#!/usr/bin/env node
// Independent behavioral check for the bounded maintenance consumer.
//
// Validates ACTUAL behavior of the consumer module (src/order-summary.mjs):
// baseline positive-order summary, added refund handling, sequential refunds,
// invalid-input boundaries (including unsafe integer/overflow), and a declared
// finite workload with exact independent totals and measured timing/environment.
// It never inspects source strings, class names, transcripts or a DONE claim.
//
// Usage:
//   node bench/checks/check-product-quality.mjs            # candidate = cwd
//   BENCH_CONSUMER_DIR=<dir> node bench/checks/check-product-quality.mjs
// When BENCH_RUN_DIR is set (benchmark harness), writes score.json and exits 0/1.
// Otherwise prints JSON and sets process.exitCode for direct regression use.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeScore } from "../../tools/bench-results.mjs";

const consumerDir = process.env.BENCH_CONSUMER_DIR
  ? resolve(process.env.BENCH_CONSUMER_DIR)
  : process.cwd();
const modulePath = join(consumerDir, "src", "order-summary.mjs");

const checks = [];
const record = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// Reference values are computed by hand, not by the candidate.
const ITEMS = [
  { name: "a", priceCents: 1000, quantity: 2 }, // 2000
  { name: "b", priceCents: 500, quantity: 3 },  // 1500
]; // subtotal 3500, tax 700, total 4200

// Declared finite workload: priceCents cycles 100..149 (period 50), quantity cycles
// 1..4 (period 4) -> combined period 100. One 100-step period contributes
// sum(price*quantity) = 31150 cents; 50000 items = 500 periods -> subtotal 15,575,000;
// tax 3,115,000; total 18,690,000 cents.
const WORKLOAD = {
  items: 50000,
  cycles: 500,
  cycleSum: 31150,
  subtotalCents: 15575000,
  taxCents: 3115000,
  totalCents: 18690000,
  smokeCeilingMs: 5000,
};

function runCheck(api) {
  const failures = [];
  const fail = (id, detail) => {
    record(id, false, detail);
    failures.push(`${id}: ${detail}`);
  };
  const pass = (id, detail) => record(id, true, detail);

  // R01: baseline public positive-order behavior preserved.
  try {
    const s = api.summarizeOrder({ items: ITEMS });
    const expected = { items: 2, subtotalCents: 3500, taxCents: 700, totalCents: 4200 };
    const same =
      s.items === expected.items &&
      s.subtotalCents === expected.subtotalCents &&
      s.taxCents === expected.taxCents &&
      s.totalCents === expected.totalCents;
    if (!same) fail("R01-baseline-summary", `expected ${JSON.stringify(expected)}, got ${JSON.stringify(s)}`);
    else pass("R01-baseline-summary", JSON.stringify(expected));
  } catch (error) {
    fail("R01-baseline-summary", `summarizeOrder threw: ${error.message}`);
  }

  // R02: refund handling added, applied in order, recorded.
  if (typeof api.applyRefund !== "function") {
    fail("R02-refund-export", "applyRefund is not exported");
  } else {
    try {
      const refunded = api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: 500 });
      const s = api.summarizeOrder(refunded);
      if (s.totalCents !== 3700) fail("R02-refund-total", `expected total 3700 after 500 refund, got ${s.totalCents}`);
      else pass("R02-refund-total", "total 4200 -> 3700 after 500-cent refund");
      if (!refunded.refunds || refunded.refunds.length !== 1) fail("R02-refund-recorded", "refund not recorded in order.refunds");
      else pass("R02-refund-recorded", "refund recorded in order.refunds");

      // Sequential refunds: each observed state summarized immediately after its own
      // refund, so no immutability of the returned order is assumed.
      try {
        const o1 = api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: 1000 });
        const s1 = api.summarizeOrder(o1);
        if (s1.totalCents !== 3200) fail("R02-sequential-first", `after 1000-cent refund expected 3200, got ${s1.totalCents}`);
        else {
          const o2 = api.applyRefund(o1, { itemId: 1, amountCents: 200 });
          const s2 = api.summarizeOrder(o2);
          if (s2.totalCents !== 3000) fail("R02-sequential-second", `after +200-cent refund expected 3000, got ${s2.totalCents}`);
          else if (o2.refunds.length !== 2) fail("R02-sequential-recorded", `expected 2 recorded refunds, got ${o2.refunds.length}`);
          else pass("R02-sequential-refunds", "4200 -> 3200 -> 3000 across two in-order refunds");
        }
      } catch (error) {
        fail("R02-sequential-refunds", `sequential refund threw: ${error.message}`);
      }

      // Over-remaining refusal: a refund larger than what remains must be rejected, not clamped.
      if (throws(() => api.applyRefund({ items: ITEMS, refunds: [{ itemId: 0, amountCents: 4000 }] }, { itemId: 0, amountCents: 1000 })))
        pass("R02-over-remaining-refusal", "refund exceeding remaining total rejected (no clamp to zero/negative)");
      else fail("R02-over-remaining-refusal", "refund exceeding remaining total was accepted (corrupt or clamped total)");
    } catch (error) {
      fail("R02-refund-behavior", `applyRefund/summarizeOrder threw: ${error.message}`);
    }
  }

  // R03: invalid input boundaries. No corrupt totals, no coercion, no overflow wrap.
  const invalid = [
    ["negative item price", () => api.summarizeOrder({ items: [{ name: "x", priceCents: -1, quantity: 1 }] })],
    ["zero item quantity", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 10, quantity: 0 }] })],
    ["non-integer price cents", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 1.5, quantity: 1 }] })],
    ["non-integer quantity", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 10, quantity: 1.5 }] })],
    ["unsafe integer price cents", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 2 ** 60, quantity: 1 }] })],
    ["unsafe integer quantity", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 10, quantity: 2 ** 60 }] })],
    ["overflowing line product", () => api.summarizeOrder({ items: [{ name: "x", priceCents: 2 ** 30, quantity: 2 ** 30 }] })],
    ["refund unknown item", () => api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 9, amountCents: 10 })],
    ["refund negative amount", () => api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: -5 })],
    ["refund non-integer amount", () => api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: 1.5 })],
    ["refund zero amount", () => api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: 0 })],
    ["refund unsafe integer amount", () => api.applyRefund({ items: ITEMS, refunds: [] }, { itemId: 0, amountCents: 2 ** 60 })],
  ];
  for (const [label, run] of invalid) {
    if (throws(run)) pass(`R03-reject-${label.replace(/\s+/g, "-")}`, `rejected: ${label}`);
    else fail(`R03-reject-${label.replace(/\s+/g, "-")}`, `accepted invalid input: ${label}`);
  }

  // R04: declared finite workload, exact independent totals, measured honestly.
  let measured = {};
  try {
    const big = {
      items: Array.from({ length: WORKLOAD.items }, (_, i) => ({
        name: `i${i}`,
        priceCents: 100 + (i % 50),
        quantity: 1 + (i % 4),
      })),
    };
    const start = process.hrtime.bigint();
    const s = api.summarizeOrder(big);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const finite = [s?.subtotalCents, s?.taxCents, s?.totalCents].every(Number.isFinite);
    const exact =
      s?.items === WORKLOAD.items &&
      s?.subtotalCents === WORKLOAD.subtotalCents &&
      s?.taxCents === WORKLOAD.taxCents &&
      s?.totalCents === WORKLOAD.totalCents;
    measured = {
      workload: `${WORKLOAD.items}-item order summary, single pass`,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      limits: `fixture-only smoke bound ${WORKLOAD.smokeCeilingMs}ms: exceeding it FAILS this check; NOT a universal performance claim`,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      expected: {
        items: WORKLOAD.items,
        subtotalCents: WORKLOAD.subtotalCents,
        taxCents: WORKLOAD.taxCents,
        totalCents: WORKLOAD.totalCents,
      },
      result: { items: s.items, subtotalCents: s.subtotalCents, taxCents: s.taxCents, totalCents: s.totalCents },
    };
    if (s.items !== WORKLOAD.items) fail("R04-workload-items", `expected ${WORKLOAD.items} items, got ${s.items}`);
    else if (!finite) fail("R04-workload-finite", `totals must be finite numbers, got ${JSON.stringify(s)}`);
    else if (!exact)
      fail(
        "R04-workload-totals",
        `wrong totals: expected ${WORKLOAD.subtotalCents}/${WORKLOAD.taxCents}/${WORKLOAD.totalCents}, got ${s.subtotalCents}/${s.taxCents}/${s.totalCents}`
      );
    else if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      fail("R04-workload-time", `measured elapsed time must be a finite nonnegative number, got ${elapsedMs}`);
    else if (elapsedMs > WORKLOAD.smokeCeilingMs)
      fail("R04-workload-time", `${WORKLOAD.items}-item summary took ${elapsedMs.toFixed(1)}ms, over ${WORKLOAD.smokeCeilingMs}ms smoke ceiling`);
    else
      pass(
        "R04-finite-workload",
        `${WORKLOAD.items} items, subtotal ${WORKLOAD.subtotalCents}, total ${WORKLOAD.totalCents} in ${elapsedMs.toFixed(2)}ms on ${process.platform}/${process.arch}`
      );
  } catch (error) {
    fail("R04-finite-workload", `workload run threw: ${error.message}`);
  }

  return { checks, failures, measured };
}

async function main() {
  if (!existsSync(modulePath)) {
    record("module-present", false, `missing ${modulePath}`);
    return finish([`module-present: missing ${modulePath}`], {});
  }
  const api = await import(pathToFileURL(modulePath).href);
  const { failures, measured } = runCheck(api);
  return finish(failures, measured);
}

function finish(failures, measured) {
  const result = {
    scenario: "product-quality-consumer",
    requirementsSatisfied: failures.length === 0,
    failures,
    checks,
    measured,
    limits: "deterministic controls; not evidence of improved model quality or UI quality",
  };
  if (process.env.BENCH_RUN_DIR) {
    process.exitCode = writeScore("product-quality", result);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ scenario: "product-quality-consumer", requirementsSatisfied: false, failures: [error.message], checks, measured: {} }, null, 2));
  process.exitCode = 1;
});
