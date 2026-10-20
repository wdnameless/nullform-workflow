#!/usr/bin/env node
// Deterministic control implementations for check-product-quality.mjs.
//
// A control rewrites <dir>/src/order-summary.mjs with a chosen behavior, then
// runs the real checker against it and REQUIRES a specific exit code plus the
// designated failure id(s). No model dispatch: these are hand-written
// implementations that prove the checker DISCRIMINATES behavior.
//
// Usage (dir is explicit; it is an error to omit it):
//   node bench/fixtures/control-product-quality.mjs --dir <consumer> --variant valid
//   node bench/fixtures/control-product-quality.mjs --dir <consumer> --variant broken-total
//   node bench/fixtures/control-product-quality.mjs --dir <consumer> --variant broken-boundary
//   node bench/fixtures/control-product-quality.mjs --dir <consumer> --variant baseline
//
// Exit codes: 0 = discrimination as expected, 1 = checker did not behave as
// required, 2 = bad invocation (missing dir/variant).
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, "..", "checks", "check-product-quality.mjs");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const dirArg = arg("--dir");
const variant = arg("--variant");
if (!dirArg || !variant) {
  console.error("usage: control-product-quality.mjs --dir <consumer> --variant <name>");
  process.exit(2);
}
const dir = resolve(dirArg);
const modulePath = join(dir, "src", "order-summary.mjs");

// Safe-integer guards keep every stored/refunded/remaining total finite and exact.
// Clamping is only used to make a corrupt input UNREPRESENTABLE, never to rescue one.
const GUARDS = `
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
function assertCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("unsafe " + label);
  return value;
}
function assertPositiveCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("unsafe " + label);
  return value;
}
function checkedProduct(priceCents, quantity) {
  const product = priceCents * quantity;
  if (!Number.isSafeInteger(product) || product < 0) throw new Error("unsafe line total");
  return product;
}
function checkedAdd(a, b, label) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error("unsafe " + label);
  return sum;
}
function checkedSubtract(a, b) {
  const diff = a - b;
  if (!Number.isSafeInteger(diff) || diff < 0) throw new Error("unsafe " + label);
  return diff;
}
`;

// Correct implementation: baseline summary + refund handling + boundaries.
const VALID = `export function summarizeOrder(order) {
  const base = summarizePositive(order);
  return { ...base, totalCents: checkedSubtract(base.totalCents, refundedCents(order)) };
}

export function applyRefund(order, refund) {
  if (!Number.isSafeInteger(refund?.amountCents) || refund.amountCents <= 0) throw new Error("invalid refund amount");
  if (!Number.isSafeInteger(refund.itemId) || refund.itemId < 0 || refund.itemId >= order.items.length) throw new Error("unknown refund target");
  if (refund.amountCents > totalRemaining(order)) throw new Error("refund exceeds remaining total");
  return { items: order.items, refunds: [...(order.refunds || []), refund] };
}

function summarizePositive(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) throw new Error("invalid order");
  let subtotalCents = 0;
  for (const item of order.items) {
    assertCents(item.priceCents, "item price");
    assertPositiveCount(item.quantity, "item quantity");
    subtotalCents = checkedAdd(subtotalCents, checkedProduct(item.priceCents, item.quantity), "subtotal");
  }
  const taxCents = assertCents(Math.round(subtotalCents * 0.2), "tax");
  const totalCents = checkedAdd(subtotalCents, taxCents, "total");
  return { items: order.items.length, subtotalCents, taxCents, totalCents };
}

function refundedCents(order) {
  return (order.refunds || []).reduce((sum, r) => checkedAdd(sum, assertCents(r.amountCents, "refund amount"), "refunded total"), 0);
}

function totalRemaining(order) {
  return checkedSubtract(summarizePositive(order).totalCents, refundedCents(order));
}
` + GUARDS;

// Broken: refund recorded but total never reduced (wrong behavior, not source shape).
const BROKEN_TOTAL = VALID.replace(
  "return { ...base, totalCents: checkedSubtract(base.totalCents, refundedCents(order)) };",
  "return { ...base, totalCents: base.totalCents };"
);

// Broken: boundary validation removed (accepts corrupt input / negative totals).
const BROKEN_BOUNDARY = VALID
  .replace('if (!Number.isSafeInteger(refund?.amountCents) || refund.amountCents <= 0) throw new Error("invalid refund amount");', "")
  .replace('if (!Number.isSafeInteger(refund.itemId) || refund.itemId < 0 || refund.itemId >= order.items.length) throw new Error("unknown refund target");', "")
  .replace('if (refund.amountCents > totalRemaining(order)) throw new Error("refund exceeds remaining total");', "");

// Baseline control: original shipped module (no refund support) -> checker must fail R02.
const BASELINE = `export function summarizeOrder(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) throw new Error("invalid order");
  let subtotalCents = 0;
  for (const item of order.items) {
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) throw new Error("invalid item price");
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("invalid item quantity");
    subtotalCents += item.priceCents * item.quantity;
  }
  const taxCents = Math.round(subtotalCents * 0.2);
  return { items: order.items.length, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
`;

// Each negative must be rejected through a REAL checker result: exit 1, parseable
// JSON, and its designated failure id present. A missing/crashing/syntax-broken
// checker can never satisfy this.
const variants = {
  valid: { source: VALID, exit: 0, mustFail: [] },
  baseline: { source: BASELINE, exit: 1, mustFail: ["R02-refund-export"] },
  "broken-total": { source: BROKEN_TOTAL, exit: 1, mustFail: ["R02-refund-total"] },
  "broken-boundary": { source: BROKEN_BOUNDARY, exit: 1, mustFail: ["R03-reject-refund-unknown-item", "R02-over-remaining-refusal"] },
};

const chosen = variants[variant];
if (!chosen) {
  console.error(`unknown variant ${variant}; use: ${Object.keys(variants).join(" | ")}`);
  process.exit(2);
}

mkdirSync(join(dir, "src"), { recursive: true });
writeFileSync(modulePath, chosen.source);

const childEnv = { ...process.env, BENCH_CONSUMER_DIR: dir };
delete childEnv.BENCH_RUN_DIR;

const result = spawnSync(process.execPath, [checker], {
  cwd: dir,
  encoding: "utf8",
  env: childEnv,
});
const stdout = (result.stdout || "").trim();
let parsed = null;
try {
  parsed = JSON.parse(stdout);
} catch {
  parsed = null;
}

const parseOk = parsed !== null && typeof parsed.requirementsSatisfied === "boolean" && Array.isArray(parsed.failures);
const exitOk = result.status === chosen.exit;
const satisfiedMatches = parseOk && parsed.requirementsSatisfied === (chosen.exit === 0);
const failedIds = parseOk && Array.isArray(parsed.failures) ? parsed.failures.map((f) => String(f).split(":")[0]) : [];
const designatedOk = chosen.mustFail.every((id) => failedIds.includes(id));

const discriminationOk = parseOk && exitOk && satisfiedMatches && designatedOk;

console.log(
  JSON.stringify(
    {
      variant,
      expectExit: chosen.exit,
      observedExit: result.status,
      parsed: parseOk,
      observedSatisfied: parseOk ? parsed.requirementsSatisfied : null,
      designatedFailuresPresent: parseOk ? designatedOk : false,
      checkerFailures: parseOk ? parsed.failures : null,
      checkerMeasured: parseOk ? parsed.measured : null,
      discriminationOk,
    },
    null,
    2
  )
);
process.exitCode = discriminationOk ? 0 : 1;
