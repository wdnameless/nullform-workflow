/**
 * tools/tests/auto-review.test.mjs
 * Regressions for auto-review.mjs:
 * - Clean project fixture returns exit code 0
 * - Cycle project fixture returns exit code 1
 * - Critical / High problem in state.problems triggers exit code 1
 * - Low / Medium problems only result in exit code 0
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const autoReviewScript = resolve(fileURLToPath(new URL("../auto-review.mjs", import.meta.url)));

test("auto-review: clean project without cycles or high problems passes with exit code 0", () => {
  const testDir = mkdtempSync(join(tmpdir(), "auto-review-clean-"));

  try {
    // Create minimal clean project with 2 files without cycles
    const fileA = `
import { b } from "./b.js";
export function a() { return b() + 1; }
`;
    const fileB = `
export function b() { return 42; }
`;
    writeFileSync(join(testDir, "a.js"), fileA, "utf8");
    writeFileSync(join(testDir, "b.js"), fileB, "utf8");

    // Pre-create .archmap/state.json with 0 cycles and no problems
    const archDir = join(testDir, ".archmap");
    mkdirSync(archDir, { recursive: true });
    const cleanState = {
      totals: { files: 2, loc: 6, avgMi: 85 },
      cycles: [],
      problems: [
        {
          id: "test-low",
          severity: "low",
          category: "maintainability",
          kind: "formatting",
          title: "Мелкое замечание",
          why: "Тест",
          fix: "Ничего",
          where: [{ file: "a.js", line: 1 }],
          heuristic: true,
        },
      ],
    };
    writeFileSync(join(archDir, "state.json"), JSON.stringify(cleanState, null, 2), "utf8");

    const res = spawnSync(process.execPath, [autoReviewScript, "--root", testDir], {
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `Expected exit code 0, got ${res.status}. Output: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, /АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО/);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});

test("auto-review: cycle project fails with exit code 1", () => {
  const testDir = mkdtempSync(join(tmpdir(), "auto-review-cycle-"));

  try {
    // Two files that circularly import each other
    const fileA = `
import { b } from "./b.js";
export function a() { return b(); }
`;
    const fileB = `
import { a } from "./a.js";
export function b() { return a(); }
`;
    writeFileSync(join(testDir, "a.js"), fileA, "utf8");
    writeFileSync(join(testDir, "b.js"), fileB, "utf8");

    // Pre-create .archmap/state.json with cycle
    const archDir = join(testDir, ".archmap");
    mkdirSync(archDir, { recursive: true });
    const cycleState = {
      totals: { files: 2, loc: 6, avgMi: 70 },
      cycles: [["a.js", "b.js", "a.js"]],
      problems: [],
    };
    writeFileSync(join(archDir, "state.json"), JSON.stringify(cycleState, null, 2), "utf8");

    const res = spawnSync(process.execPath, [autoReviewScript, "--root", testDir], {
      encoding: "utf8",
    });

    assert.equal(res.status, 1, `Expected exit code 1, got ${res.status}. Output: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, /АВТО-РЕВЬЮ НЕ ПРОЙДЕНО/);
    assert.match(res.stdout, /цикл/i);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});

test("auto-review: critical/high severity problems in state.problems fail with exit code 1", () => {
  const testDir = mkdtempSync(join(tmpdir(), "auto-review-problems-"));

  try {
    writeFileSync(join(testDir, "a.js"), "export const a = 1;\n", "utf8");

    const archDir = join(testDir, ".archmap");
    mkdirSync(archDir, { recursive: true });
    const problemState = {
      totals: { files: 1, loc: 1, avgMi: 90 },
      cycles: [],
      problems: [
        {
          id: "crit-1",
          severity: "critical",
          category: "security",
          kind: "hardcoded_secret",
          title: "Утечка секрета",
          why: "Секрет в коде",
          fix: "Убрать в env",
          where: [{ file: "a.js", line: 1 }],
          heuristic: true,
        },
      ],
    };
    writeFileSync(join(archDir, "state.json"), JSON.stringify(problemState, null, 2), "utf8");

    const res = spawnSync(process.execPath, [autoReviewScript, "--root", testDir], {
      encoding: "utf8",
    });

    assert.equal(res.status, 1, `Expected exit code 1, got ${res.status}. Output: ${res.stdout} ${res.stderr}`);
    assert.match(res.stdout, /АВТО-РЕВЬЮ НЕ ПРОЙДЕНО/);
    assert.match(res.stdout, /критическ/i);
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
