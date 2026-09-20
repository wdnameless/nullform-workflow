/**
 * tools/tests/auto-review.test.mjs
 * Regressions for auto-review.mjs:
 * - Clean project fixture without package.json/test script and without markers passes with exit code 0
 * - Project fixture with an unhandled defer marker (lacking upgrade/trigger) fails with exit code 1
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const autoReviewScript = resolve(fileURLToPath(new URL("../auto-review.mjs", import.meta.url)));

test("auto-review: clean project without package.json/test script and without markers passes with exit code 0", () => {
  const testDir = mkdtempSync(join(tmpdir(), "auto-review-clean-"));

  try {
    const fileA = `
export function add(a, b) {
  return a + b;
}
`;
    writeFileSync(join(testDir, "math.js"), fileA, "utf8");

    const res = spawnSync(process.execPath, [autoReviewScript, "--root", testDir], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Expected exit code 0, got ${res.status}. Output: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, /АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО/);
    assert.match(res.stdout, /Долговой реестр/);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});

test("auto-review: fixture with '// defer: x' lacking upgrade fails with exit code 1 and mentions debt-ledger", () => {
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
    assert.match(res.stdout, /АВТО-РЕВЬЮ НЕ ПРОЙДЕНО/);
    assert.match(res.stdout, /debt-ledger/i);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
