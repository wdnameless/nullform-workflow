/**
 * product-quality-consumer.test.mjs — permanent regression for the bounded
 * maintenance consumer mechanism (bench/fixtures/control-product-quality.mjs +
 * bench/checks/check-product-quality.mjs).
 *
 * Runs the REAL control runner and checker in contained temp dirs, so the existing
 * `node --test tools/tests/*.test.mjs` suite exercises the new mechanism. These
 * tests catch the concrete false-green behavior found in review:
 *   - a control must require a REAL checker result (exit code + parseable JSON +
 *     designated failure ids), never accept a crash/unparseable checker output;
 *   - an unavailable/missing/broken checker must NOT count as a successful rejection;
 *   - the checker must verify exact independent totals (not just item count).
 *
 * No model dispatch, no mocks echoing source, no invented quality metrics.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const controlRunner = join(repoRoot, "bench", "fixtures", "control-product-quality.mjs");
const setupRunner = join(repoRoot, "bench", "fixtures", "setup-product-quality.mjs");
const realChecksDir = join(repoRoot, "bench", "checks");

// Isolated child env: own temp root, never an ambient benchmark run dir.
function consumerEnv(root) {
  const env = { ...process.env, BENCH_CONSUMER_DIR: root };
  delete env.BENCH_RUN_DIR;
  return env;
}
// runControl(root, variant, { runner }) — `runner` defaults to the real control
// runner; mirrored runs pass their own copied path so a missing/broken sibling
// checker is actually the one exercised, never the real one.
function runControl(root, variant, { runner = controlRunner } = {}) {
  const result = spawnSync(process.execPath, [runner, "--dir", root, "--variant", variant], {
    cwd: root,
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout || "").trim());
  } catch {
    parsed = null;
  }
  return { status: result.status, parsed, raw: result.stdout, err: result.stderr };
}

function withTempRoot(label, fn) {
  const root = mkdtempSync(join(tmpdir(), `pq-consumer-${label}-`));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeMirroredRunner(label, { checks } = {}) {
  // Mirrors bench/fixtures + bench/checks in a temp root so the runner can be
  // invoked with a sibling checks dir that is missing or deliberately broken.
  const root = mkdtempSync(join(tmpdir(), `pq-mirror-${label}-`));
  const fixturesDir = join(root, "bench", "fixtures");
  const checksDir = join(root, "bench", "checks");
  mkdirSync(fixturesDir, { recursive: true });
  const runner = join(fixturesDir, "control-product-quality.mjs");
  cpSync(controlRunner, runner);
  if (checks === "valid") {
    mkdirSync(checksDir, { recursive: true });
    cpSync(join(realChecksDir, "check-product-quality.mjs"), join(checksDir, "check-product-quality.mjs"));
  } else if (checks === "broken") {
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, "check-product-quality.mjs"), "this is not valid javascript (((\n");
  }
  // checks === "missing" -> leave the sibling dir absent entirely
  return { root, runner };
}

test("valid control: real checker accepts, exit 0, discrimination true", () => {
  withTempRoot("valid", (root) => {
    const { status, parsed } = runControl(root, "valid");
    assert.equal(status, 0, `control must exit 0; stderr=${""} stdout=${JSON.stringify(parsed)}`);
    assert.ok(parsed, "control must emit parseable JSON");
    assert.equal(parsed.discriminationOk, true);
    assert.equal(parsed.observedExit, 0);
    assert.equal(parsed.parsed, true);
    assert.equal(parsed.observedSatisfied, true);
    // exact independent totals recorded, not just item count
    assert.ok(parsed.checkerMeasured?.expected?.totalCents, "checker must report independent expected total");
    assert.equal(parsed.checkerMeasured.expected.totalCents, parsed.checkerMeasured.result.totalCents);
    // real numeric elapsed measurement, not text alone
    assert.equal(typeof parsed.checkerMeasured.elapsedMs, "number");
    assert.ok(Number.isFinite(parsed.checkerMeasured.elapsedMs) && parsed.checkerMeasured.elapsedMs >= 0, `elapsedMs must be finite nonnegative: ${parsed.checkerMeasured.elapsedMs}`);
  });
});

test("shipped fixture emits a parseable module in a fresh git repo (fixture parse regression)", () => {
  // The real setup-product-quality.mjs writes manifest.md + src/order-summary.mjs
  // into a consumer repo. If its emitted module template is unbalanced, the
  // benchmark task is broken for every candidate before any model runs. Guard the
  // shipped fixture itself, in a real git root (the fixture refuses a non-repo cwd).
  const root = mkdtempSync(join(tmpdir(), `pq-setup-`));
  try {
    const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);

    const setup = spawnSync(process.execPath, [setupRunner], { cwd: root, encoding: "utf8" });
    assert.equal(setup.status, 0, `setup-product-quality.mjs failed: ${setup.stderr}`);

    const modulePath = join(root, "src", "order-summary.mjs");
    assert.ok(readFileSync(modulePath, "utf8").includes("export function summarizeOrder"), "fixture must emit the public summarizeOrder export");

    const check = spawnSync(process.execPath, ["--check", modulePath], { encoding: "utf8" });
    assert.equal(check.status, 0, `emitted fixture module must parse (node --check): ${check.stderr}`);

    // The committed tree must be exactly the fixture's two files.
    const committed = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
    assert.equal(committed.status, 0, `git ls-files failed: ${committed.stderr}`);
    assert.deepEqual(committed.stdout.trim().split("\n").sort(), ["manifest.md", "src/order-summary.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline control: rejected via real checker exit 1 with designated failure id", () => {
  withTempRoot("baseline", (root) => {
    const { status, parsed } = runControl(root, "baseline");
    assert.equal(status, 0, "control exits 0 when discrimination matches expectation");
    assert.equal(parsed.discriminationOk, true);
    assert.equal(parsed.observedExit, 1);
    assert.equal(parsed.observedSatisfied, false);
    assert.ok(
      (parsed.checkerFailures || []).some((f) => String(f).startsWith("R02-refund-export")),
      `designated failure id missing: ${JSON.stringify(parsed.checkerFailures)}`
    );
  });
});

test("broken-total control: rejected via real checker exit 1 with designated failure id", () => {
  withTempRoot("broken-total", (root) => {
    const { status, parsed } = runControl(root, "broken-total");
    assert.equal(status, 0);
    assert.equal(parsed.discriminationOk, true);
    assert.equal(parsed.observedExit, 1);
    assert.ok(
      (parsed.checkerFailures || []).some((f) => String(f).startsWith("R02-refund-total")),
      `designated failure id missing: ${JSON.stringify(parsed.checkerFailures)}`
    );
  });
});

test("broken-boundary control: rejected via real checker exit 1 with designated failure ids", () => {
  withTempRoot("broken-boundary", (root) => {
    const { status, parsed } = runControl(root, "broken-boundary");
    assert.equal(status, 0);
    assert.equal(parsed.discriminationOk, true);
    assert.equal(parsed.observedExit, 1);
    const ids = (parsed.checkerFailures || []).map((f) => String(f).split(":")[0]);
    for (const id of ["R03-reject-refund-unknown-item", "R02-over-remaining-refusal"]) {
      assert.ok(ids.includes(id), `designated failure id ${id} missing: ${JSON.stringify(ids)}`);
    }
  });
});

test("unavailable checker (missing sibling checks dir) must NOT count as a successful rejection", () => {
  const { root, runner } = makeMirroredRunner("missing-checker", { checks: "missing" });
  try {
    const { status, parsed } = runControl(root, "baseline", { runner });
    assert.equal(status, 1, "control must exit 1 (discrimination failed), not 0");
    assert.ok(parsed, "control must still emit parseable JSON");
    assert.equal(parsed.discriminationOk, false);
    assert.equal(parsed.parsed, false, "checker output must be reported as not parseable");
    assert.equal(parsed.observedSatisfied, null, "no satisfied verdict can be inferred from an unavailable checker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broken checker (syntax error) must NOT count as a successful rejection", () => {
  const { root, runner } = makeMirroredRunner("broken-checker", { checks: "broken" });
  try {
    const { status, parsed } = runControl(root, "baseline", { runner });
    assert.equal(status, 1);
    assert.equal(parsed.discriminationOk, false);
    assert.equal(parsed.parsed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("control runner requires explicit --dir and known variant", () => {
  const missingDir = spawnSync(process.execPath, [controlRunner, "--variant", "valid"], { encoding: "utf8" });
  assert.equal(missingDir.status, 2);
  withTempRoot("usage", (root) => {
    const badVariant = spawnSync(process.execPath, [controlRunner, "--dir", root, "--variant", "nope"], { encoding: "utf8" });
    assert.equal(badVariant.status, 2);
  });
});

test("checker rejects a module with wrong large-workload totals (false-green guard)", () => {
  // Seed a VALID module via the real control, prove it valid, then wrap it with a
  // behavioral mutant that corrupts ONLY the large-workload returned totals. This is
  // an intentional test mutant, not a production abstraction.
  withTempRoot("wrong-totals", (root) => {
    const seeded = runControl(root, "valid");
    assert.equal(seeded.status, 0, `seed must be a valid module: ${JSON.stringify(seeded.parsed)}`);
    assert.equal(seeded.parsed.observedSatisfied, true);

    const baseSource = readFileSync(join(root, "src", "order-summary.mjs"), "utf8");
    writeFileSync(join(root, "src", "order-summary-base.mjs"), baseSource);
    writeFileSync(
      join(root, "src", "order-summary.mjs"),
      `import { summarizeOrder as baseSummarize, applyRefund } from "./order-summary-base.mjs";
export { applyRefund };
export function summarizeOrder(order) {
  const result = baseSummarize(order);
  if (order.items.length > 2) return { items: order.items.length, subtotalCents: order.items.length, taxCents: order.items.length, totalCents: order.items.length };
  return result;
}
`
    );

    const run = spawnSync(process.execPath, [join(realChecksDir, "check-product-quality.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: consumerEnv(root),
    });
    assert.equal(run.status, 1, "wrong large-workload totals must fail the checker");
    const parsed = JSON.parse((run.stdout || "").trim());
    const ids = (parsed.failures || []).map((f) => String(f).split(":")[0]);
    assert.deepEqual(ids, ["R04-workload-totals"], `expected only the workload-totals failure, got ${JSON.stringify(ids)}`);
  });
});
