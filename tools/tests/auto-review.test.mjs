/**
 * tools/tests/auto-review.test.mjs
 * Regressions for auto-review.mjs consumer-visible contracts:
 * - Debt-ledger failure blocks (exit 1)
 * - JSON envelope preserved (ok/exitCode/problems/report)
 * - Unknown flags refuse with exit 2
 * - Broken build with green test fails (per-check status)
 * - Failing lint/typecheck scripts fail (per-check status)
 * - Missing required custom script is unverified
 * - No product checks is unverified
 * - Passing explicit --check supplies product evidence, unrelated categories n/a
 * - Invalid flags/JSON/argv refuse before any marker side effect
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const autoReviewScript = resolve(fileURLToPath(new URL("../auto-review.mjs", import.meta.url)));

test("auto-review: fixture with '// defer: x' lacking upgrade fails with exit code 1", () => {
  const testDir = mkdtempSync(join(tmpdir(), "auto-review-debt-"));

  try {
    const fileWithDebt = [
      "// " + "defer: optimize this later",
      "export function slowOperation() {",
      "  return [1, 2, 3];",
      "}",
    ].join("\n");
    writeFileSync(join(testDir, "heavy.js"), fileWithDebt, "utf8");

    const res = spawnSync(process.execPath, [autoReviewScript, "--root", testDir], {
      encoding: "utf8",
    });

    assert.equal(res.status, 1, `Expected exit code 1, got ${res.status}. Output: ${res.stdout} ${res.stderr}`);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});

test("auto-review --json: провал гейта даёт ok=false и причину в problems", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-json-fail-"));
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.js"), "// defer: quick hack | ceiling: 10 users\n", "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(proc.status, 1);
    assert.ok(parsed.total >= 1, "причина провала попала в problems");
    assert.ok(parsed.problems[0].message.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: неизвестный флаг — ошибка, а не молчаливый пропуск", () => {
  const proc = spawnSync(process.execPath, [autoReviewScript, "--nope"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
});

/* ------------------------- New consumer-visible contracts ------------------------- */

test("auto-review: broken build with green test fails (per-check build.status=fail, test.status=pass)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-build-fail-"));
  try {
    writeFileSync(join(tmp, "build.js"), "this is not valid javascript!!!\n", "utf8");
    writeFileSync(join(tmp, "test.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0",
      scripts: { build: "node build.js", test: "node test.js" }
    }), "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 1);
    assert.equal(proc.status, 1);
    const checks = parsed.checks || [];
    const buildCheck = checks.find(c => c.id === "build");
    const testCheck = checks.find(c => c.id === "test");
    assert.ok(buildCheck, "build check row present");
    assert.ok(testCheck, "test check row present");
    assert.equal(buildCheck.status, "fail");
    assert.equal(testCheck.status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: failing typecheck and lint scripts each fail (per-check rows)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-lint-type-fail-"));
  try {
    writeFileSync(join(tmp, "fail.js"), "process.exit(1);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0",
      scripts: { typecheck: "node fail.js", lint: "node fail.js" }
    }), "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 1);
    const checks = parsed.checks || [];
    const typeCheck = checks.find(c => c.id === "typecheck");
    const lintCheck = checks.find(c => c.id === "lint");
    assert.ok(typeCheck, "typecheck check row present");
    assert.ok(lintCheck, "lint check row present");
    assert.equal(typeCheck.status, "fail");
    assert.equal(lintCheck.status, "fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: --require missing script is unverified", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-require-missing-"));
  try {
    writeFileSync(join(tmp, "test.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0",
      scripts: { test: "node test.js" }
    }), "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp, "--require", "check:perf"], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.status, "unverified");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: no product checks is unverified", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-no-checks-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0"
    }), "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.status, "unverified");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: passing explicit --check supplies product evidence, unrelated categories n/a", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-check-pass-"));
  try {
    writeFileSync(join(tmp, "smoke.js"), "process.exit(0);\n", "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp, "--check", JSON.stringify(["node", "smoke.js"])], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.status, "pass");
    const checks = parsed.checks || [];
    const smokeCheck = checks.find(c => c.argv && c.argv[0] === "node" && c.argv[1] === "smoke.js");
    assert.ok(smokeCheck, "explicit --check command should be in checks");
    assert.equal(smokeCheck.status, "pass");
    const hasNotApplicable = checks.some(c => c.status === "not-applicable");
    assert.ok(hasNotApplicable, "unrelated categories should be not-applicable");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: invalid flags/JSON/argv refuse with exit 2 before any side effect", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-invalid-"));
  try {
    const markerArgv = ["node", "-e", "require('fs').writeFileSync('marker.txt','created')"];
    const markerPath = join(tmp, "marker.txt");

    const invalidInputs = [
      ["--check", "not-json"],
      ["--check", ""],
      ["--check", JSON.stringify([])],
      ["--check", JSON.stringify(["node", 1])],
      ["--nope"],
      ["positional-arg"],
    ];

    for (const args of invalidInputs) {
      const valid = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp, "--check", JSON.stringify(markerArgv)], { encoding: "utf8" });
      assert.equal(valid.status, 0, "valid --check marker argv should pass");
      assert.ok(existsSync(markerPath), "valid marker argv creates marker");
      rmSync(markerPath, { force: true });

      const r = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp, "--check", JSON.stringify(markerArgv), ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, `Expected exit 2 for ${JSON.stringify(args)}, got ${r.status}`);
      assert.ok(!existsSync(markerPath), `marker must not exist after invalid input ${JSON.stringify(args)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------- Guard regressions (appended) ------------------------- */

test("auto-review: configured checker unavailable is unverified", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-ts-unavail-"));
  try {
    writeFileSync(join(tmp, "tsconfig.json"), "{}", "utf8");
    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    const tsCheck = parsed.checks.find((c) => c.id === "typescript");
    assert.ok(tsCheck, "typescript check row present");
    assert.equal(tsCheck.status, "unverified");
    assert.equal(parsed.status, "unverified");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: malformed package.json is unverified", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-malformed-pkg-"));
  try {
    writeFileSync(join(tmp, "package.json"), "{ invalid", "utf8");
    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "unverified");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: --require flag-like value refuses with exit 2", () => {
  const proc = spawnSync(process.execPath, [autoReviewScript, "--require", "--json"], { encoding: "utf8" });
  assert.equal(proc.status, 2);
});

test("auto-review: dedup --require build does not duplicate check rows", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-dedup-"));
  try {
    writeFileSync(join(tmp, "build.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0",
      scripts: { build: "node build.js" }
    }), "utf8");
    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp, "--require", "build"], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    const buildRows = parsed.checks.filter((c) => c.id === "build");
    assert.equal(buildRows.length, 1, "build appears exactly once");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: debt-ledger fail while product check passes gives overall fail", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-debt-vs-product-"));
  try {
    writeFileSync(join(tmp, "smoke.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "fixture.js"), "// defer: no trigger\n", "utf8");
    const proc = spawnSync(process.execPath, [
      autoReviewScript, "--json", "--root", tmp,
      "--check", JSON.stringify(["node", "smoke.js"])
    ], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    const debtCheck = parsed.checks.find((c) => c.id === "debt-ledger");
    assert.ok(debtCheck, "debt-ledger check row present");
    assert.equal(debtCheck.status, "fail");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: invalid scripts shape with passing check is unverified", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-bad-scripts-"));
  try {
    writeFileSync(join(tmp, "smoke.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0", scripts: []
    }), "utf8");
    const proc = spawnSync(process.execPath, [
      autoReviewScript, "--json", "--root", tmp,
      "--check", JSON.stringify(["node", "smoke.js"])
    ], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "unverified");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: root not a directory refuses before any side effect", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-root-notdir-"));
  const filePath = join(tmp, "not-a-dir");
  try {
    writeFileSync(filePath, "x", "utf8");
    const markerArgv = ["node", "-e", "require('fs').writeFileSync('marker.txt','created')"];
    const markerPath = join(tmp, "marker.txt");
    const proc = spawnSync(process.execPath, [
      autoReviewScript, "--json", "--root", filePath,
      "--check", JSON.stringify(markerArgv)
    ], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "unverified");
    assert.ok(!existsSync(markerPath), "no command side effect on invalid root");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review: discovered existing script is required:true without --require", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-req-invariant-"));
  try {
    writeFileSync(join(tmp, "test.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0", scripts: { test: "node test.js" }
    }), "utf8");
    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    const parsed = JSON.parse(proc.stdout);
    const testRow = parsed.checks.find((c) => c.id === "test");
    assert.ok(testRow, "test check row present");
    assert.equal(testRow.required, true, "existing discovered script must be required");
    assert.equal(testRow.status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
