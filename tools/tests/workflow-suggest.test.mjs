/**
 * tools/tests/workflow-suggest.test.mjs
 * Behavioral tests for workflow hardening:
 * - suggest command: heuristic tier detection (T0, T1, T2, T3) and JSON shape
 * - budgets: loading custom .workflow/budgets.json vs fallback to defaults
 * - start and status budget reporting
 * - guarded auto mode: T0 acceptance with --allow and --max-diff
 * - guarded auto mode: T1+ refusal (exit code 1 + autoRefusal recorded in state)
 * - guarded auto mode: parameter validation (--allow required, max-diff <= 20)
 * - close --auto diff-lines cap verification
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestTier,
  loadBudgets,
  DEFAULT_BUDGETS,
  cmdStart,
  cmdStatus,
  cmdClose,
  load,
} from "../workflow.mjs";

test("workflow suggest: T0 classification for 1-2 local files without heavy keywords", () => {
  const res1 = suggestTier({ files: ["src/button.ts"], task: "fix button hover color" });
  assert.equal(res1.tier, "T0");
  assert.ok(typeof res1.confidence === "number");
  assert.ok(res1.confidence > 0 && res1.confidence <= 1);
  assert.ok(Array.isArray(res1.reasons));
  assert.ok(res1.reasons.length > 0);
  assert.ok(res1.reasons.some((r) => r.includes("локальное изменение") || r.includes("файл")));

  const res2 = suggestTier({ files: ["a.ts", "b.ts"], task: "rename helper" });
  assert.equal(res2.tier, "T0");
});

test("workflow suggest: T1 classification for 3-9 files or unfamiliar directory or new deps", () => {
  // 3-9 files
  const resFiles = suggestTier({
    files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    task: "refactor utility helpers",
  });
  assert.equal(resFiles.tier, "T1");
  assert.ok(resFiles.reasons.some((r) => r.includes("от 3 до 9 файлов")));

  // Unfamiliar directory
  const resDir = suggestTier({
    files: ["legacy/old-module.js"],
    task: "patch bug in legacy parser",
  });
  assert.equal(resDir.tier, "T1");
  assert.ok(resDir.reasons.some((r) => r.includes("незнакомых")));

  // New dep or API keyword
  const resDep = suggestTier({
    files: ["package.json"],
    task: "install new package dependency",
  });
  assert.equal(resDep.tier, "T1");
  assert.ok(resDep.reasons.some((r) => r.includes("зависимостей") || r.includes("API")));
});

test("workflow suggest: T2 classification for >9 files or schema/migration/architecture keywords", () => {
  // >9 files
  const tenFiles = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
  const resTen = suggestTier({ files: tenFiles, task: "update imports" });
  assert.equal(resTen.tier, "T2");
  assert.ok(resTen.reasons.some((r) => r.includes("> 9")));

  // Schema keyword
  const resSchema = suggestTier({
    files: ["user.ts"],
    task: "database migration and schema update for user profiles",
  });
  assert.equal(resSchema.tier, "T2");
  assert.ok(resSchema.reasons.some((r) => r.includes("схему данных") || r.includes("миграци")));

  // Architecture keyword
  const resArch = suggestTier({
    files: ["index.ts"],
    task: "architectural overhaul and redesign of event bus",
  });
  assert.equal(resArch.tier, "T2");
  assert.ok(resArch.reasons.some((r) => r.includes("архитектурные")));
});

test("workflow suggest: T3 classification for multi-feature keywords and programs", () => {
  const resAnd = suggestTier({
    files: ["app.ts"],
    task: "add user authentication and implement payment billing",
  });
  assert.equal(resAnd.tier, "T3");
  assert.ok(resAnd.reasons.some((r) => r.includes("множественных фич") || r.includes("'and'")));

  const resMulti = suggestTier({
    files: ["core.ts"],
    task: "программа реализации: несколько фич в параллельных срезах",
  });
  assert.equal(resMulti.tier, "T3");
});

test("workflow budgets: fallback to default budgets when file absent", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-budgets-absent-"));
  try {
    const b = loadBudgets(tempDir);
    assert.deepEqual(b, DEFAULT_BUDGETS);
    assert.equal(b.T0, 10);
    assert.equal(b.T1, 25);
    assert.equal(b.T2, 45);
    assert.equal(b.T3, 45);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow budgets: load custom budgets from .workflow/budgets.json", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-budgets-custom-"));
  try {
    const wfDir = join(tempDir, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "budgets.json"),
      JSON.stringify({ T0: 15, T1: 30, T2: 50, T3: 60 })
    );

    const b = loadBudgets(tempDir);
    assert.equal(b.T0, 15);
    assert.equal(b.T1, 30);
    assert.equal(b.T2, 50);
    assert.equal(b.T3, 60);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow guarded auto: start allows T0 with valid allow and max-diff", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-auto-t0-"));
  try {
    const code = cmdStart(tempDir, {
      tier: "T0",
      task: "fix typo",
      auto: true,
      allow: "src/**",
      "max-diff": "5",
    });
    assert.equal(code, 0);

    const st = load(tempDir);
    assert.ok(st);
    assert.equal(st.tier, "T0");
    assert.equal(st.status, "open");
    assert.deepEqual(st.auto, { allow: "src/**", maxDiff: 5 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow guarded auto: start refuses T1+ with exit 1 and records autoRefusal in state", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-auto-refuse-"));
  try {
    const code = cmdStart(tempDir, {
      tier: "T1",
      task: "recon task",
      auto: true,
      allow: "src/**",
      "max-diff": "5",
    });
    assert.equal(code, 1);

    const st = load(tempDir);
    assert.ok(st);
    assert.ok(st.autoRefusal);
    assert.equal(st.autoRefusal.tier, "T1");
    assert.ok(st.autoRefusal.reason.includes("refused"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow guarded auto: start validates required allow pattern and max-diff cap <= 20", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-auto-val-"));
  try {
    // Missing allow
    const code1 = cmdStart(tempDir, {
      tier: "T0",
      task: "task 1",
      auto: true,
      "max-diff": "5",
    });
    assert.equal(code1, 1);

    // Invalid max-diff (> 20)
    const code2 = cmdStart(tempDir, {
      tier: "T0",
      task: "task 2",
      auto: true,
      allow: "src/**",
      "max-diff": "25",
    });
    assert.equal(code2, 1);

    // Invalid max-diff (< 1)
    const code3 = cmdStart(tempDir, {
      tier: "T0",
      task: "task 3",
      auto: true,
      allow: "src/**",
      "max-diff": "0",
    });
    assert.equal(code3, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workflow guarded auto: close verifies diff lines cap", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wf-auto-close-"));
  try {
    // Start valid auto task with max-diff 10
    const startCode = cmdStart(tempDir, {
      tier: "T0",
      task: "small fix",
      auto: true,
      allow: "src/**",
      "max-diff": "10",
    });
    assert.equal(startCode, 0);

    // Attempt close exceeding max-diff (15 > 10) -> exit 1
    const failCode = cmdClose(tempDir, {
      auto: true,
      "diff-lines": "15",
    });
    assert.equal(failCode, 1);

    // Attempt close within cap (8 <= 10) -> exit 0
    const okCode = cmdClose(tempDir, {
      auto: true,
      "diff-lines": "8",
    });
    assert.equal(okCode, 0);

    const st = load(tempDir);
    assert.equal(st.status, "closed");
    assert.equal(st.diffLines, 8);
    assert.equal(st.autoSkipReason, "non-git environment; skipped tree diff measurement");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
