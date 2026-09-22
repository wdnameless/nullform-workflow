/**
 * tools/tests/auto-review.test.mjs
 * Regressions for auto-review.mjs:
 * - Clean project fixture without package.json/test script and without markers passes with exit code 0
 * - Project fixture with an unhandled defer marker (lacking upgrade/trigger) fails with exit code 1
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

/* ------------------------------------------------ --json контракт (bug sweep) */

test("auto-review --json: печатает только JSON, отдаёт ok/exitCode/problems/report", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-json-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");

    const proc = spawnSync(process.execPath, [autoReviewScript, "--json", "--root", tmp], { encoding: "utf8" });
    assert.equal(proc.status, 0);

    // stdout — ровно JSON: иначе дашборд не сможет разобрать вердикт
    const parsed = JSON.parse(proc.stdout);
    assert.equal(typeof parsed.ok, "boolean");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exitCode, 0);
    assert.equal(Array.isArray(parsed.problems), true);
    assert.equal(parsed.total, 0);
    assert.ok(typeof parsed.report === "string" && parsed.report.length > 0, "текстовый отчёт сохранён");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("auto-review --json: провал гейта даёт ok=false и причину в problems", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ar-json-fail-"));
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    // Маркер defer: без триггера апгрейда — детерминированный провал гейта
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
  assert.ok(proc.stderr.includes("неизвестный параметр"));
});
