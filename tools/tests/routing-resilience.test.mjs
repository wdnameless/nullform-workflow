/**
 * tools/tests/routing-resilience.test.mjs
 * Unit and behavioral tests for Slice D: Routing & resilience (R06, R07, R08).
 *
 * Requirements:
 * - R06: Triage lane derived from blast-radius with rationale ({ fileCount, dirSpread, keywords })
 * - R07: Orchestrator behavioral evals (runEvals, DEFAULT_CASES, CLI exit code and reporting)
 * - R08: Tool fallback in order with log, throwing when exhausted; budget compact-before-refuse
 */

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { suggestTier } from "../workflow.mjs";
import { runEvals, DEFAULT_CASES } from "../orchestrator-evals.mjs";

/* ------------------------------------------------------------------ R06: Triage */

test("R06 suggestTier: T0 lane and rationale for small local change", () => {
  const res = suggestTier({
    files: ["src/button.ts"],
    task: "fix button hover color",
  });
  assert.equal(res.tier, "T0");
  assert.ok(typeof res.confidence === "number");
  assert.ok(Array.isArray(res.reasons));
  assert.ok(res.rationale, "rationale field must be present");
  assert.equal(res.rationale.fileCount, 1);
  assert.deepEqual(res.rationale.dirSpread, ["src"]);
  assert.deepEqual(res.rationale.keywords, []);
});

test("R06 suggestTier: T1 lane with multiple directories in spread", () => {
  const res = suggestTier({
    files: ["src/a.ts", "lib/b.ts", "tools/c.ts", "src/sub/d.ts"],
    task: "refactor utility helpers across modules",
  });
  assert.equal(res.tier, "T1");
  assert.equal(res.rationale.fileCount, 4);
  assert.deepEqual(res.rationale.dirSpread, ["src", "lib", "tools"]);
});

test("R06 suggestTier: T1 lane with unfamiliar directory", () => {
  const res = suggestTier({
    files: ["legacy/parser.js"],
    task: "patch bug in parser",
  });
  assert.equal(res.tier, "T1");
  assert.equal(res.rationale.fileCount, 1);
  assert.deepEqual(res.rationale.dirSpread, ["legacy"]);
});

test("R06 suggestTier: T2 lane with >9 files measured blast-radius", () => {
  const files = Array.from({ length: 12 }, (_, i) => `dir${i}/file.ts`);
  const res = suggestTier({ files, task: "update imports across components" });
  assert.equal(res.tier, "T2");
  assert.equal(res.rationale.fileCount, 12);
  assert.equal(res.rationale.dirSpread.length, 12);
});

test("R06 suggestTier: T2 lane with schema and migration keywords in rationale", () => {
  const res = suggestTier({
    files: ["src/models/user.ts"],
    task: "database migration and schema update for user profiles",
  });
  assert.equal(res.tier, "T2");
  assert.equal(res.rationale.fileCount, 1);
  assert.deepEqual(res.rationale.dirSpread, ["src"]);
  assert.ok(res.rationale.keywords.includes("database"));
  assert.ok(res.rationale.keywords.includes("migration"));
  assert.ok(res.rationale.keywords.includes("schema"));
});

test("R06 suggestTier: T3 lane with multi-feature keywords in rationale", () => {
  const res = suggestTier({
    files: ["core.ts"],
    task: "программа реализации: несколько фич в параллельных срезах",
  });
  assert.equal(res.tier, "T3");
  assert.equal(res.rationale.fileCount, 1);
  assert.deepEqual(res.rationale.dirSpread, ["."]);
  assert.ok(res.rationale.keywords.includes("программа"));
  assert.ok(res.rationale.keywords.includes("несколько фич"));
  assert.ok(res.rationale.keywords.includes("параллельн"));
});

test("R06 suggestTier: T3 lane with independent verb pair signal", () => {
  const res = suggestTier({
    files: ["app.ts"],
    task: "add user authentication and implement payment billing",
  });
  assert.equal(res.tier, "T3");
  assert.ok(res.rationale.keywords.includes("verb-pair-t3"));
});

test("R06 suggestTier: edge cases with empty files and root files", () => {
  const emptyRes = suggestTier({ files: [], task: "empty task" });
  assert.equal(emptyRes.rationale.fileCount, 0);
  assert.deepEqual(emptyRes.rationale.dirSpread, []);

  const rootRes = suggestTier({ files: ["package.json", "README.md"], task: "docs" });
  assert.equal(rootRes.rationale.fileCount, 2);
  assert.deepEqual(rootRes.rationale.dirSpread, ["."]);
});

/* ---------------------------------------------------- R07: Behavioral evals */

test("R07 runEvals: reports pass on matching subject expectations", () => {
  const cases = [
    { id: "c1", input: {}, expect: { field: "status", equals: "DONE" } },
    { id: "c2", input: {}, expect: { field: "files", contains: "workflow.mjs" } },
  ];
  const subject = { status: "DONE", files: ["tools/workflow.mjs"] };
  const results = runEvals(cases, subject);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "c1");
  assert.equal(results[0].pass, true);
  assert.equal(results[0].detail, "ok");
  assert.equal(results[1].id, "c2");
  assert.equal(results[1].pass, true);
  assert.equal(results[1].detail, "ok");
});

test("R07 runEvals: reports fail with details on mismatch or missing field", () => {
  const cases = [
    { id: "c1", input: {}, expect: { field: "status", equals: "DONE" } },
    { id: "c2", input: {}, expect: { field: "nonexistent", equals: "something" } },
  ];
  const subject = { status: "BLOCKED" };
  const results = runEvals(cases, subject);
  assert.equal(results[0].pass, false);
  assert.ok(results[0].detail.includes("expected field \"status\" to equal \"DONE\""));
  assert.equal(results[1].pass, false);
  assert.ok(results[1].detail.includes("undefined"));
});

test("R07 DEFAULT_CASES covers all 6 orchestrator return contract fields", () => {
  const fields = DEFAULT_CASES.map((c) => c.expect.field.toLowerCase());
  assert.ok(fields.includes("status"), "DEFAULT_CASES must cover status");
  assert.ok(fields.includes("files"), "DEFAULT_CASES must cover files");
  assert.ok(fields.includes("tests"), "DEFAULT_CASES must cover tests");
  assert.ok(fields.includes("interfaces"), "DEFAULT_CASES must cover interfaces");
  assert.ok(fields.includes("requirements"), "DEFAULT_CASES must cover requirements");
  assert.ok(fields.includes("concerns"), "DEFAULT_CASES must cover concerns");
});

test("R07 DEFAULT_CASES: passes on valid orchestrator contract subject", () => {
  const validSubject = {
    status: "DONE",
    files: ["tools/workflow.mjs"],
    tests: "было 10 → стало 14",
    interfaces: "suggestTier({ files, task })",
    requirements: "R06, R07, R08",
    concerns: "none",
  };
  const results = runEvals(DEFAULT_CASES, validSubject);
  for (const r of results) {
    assert.equal(r.pass, true, `Case ${r.id} expected to pass`);
  }
});

test("R07 orchestrator-evals CLI: exits 0 on valid subject, 1 on failing subject", () => {
  const validFile = join(tmpdir(), `eval-valid-${Date.now()}.json`);
  const invalidFile = join(tmpdir(), `eval-invalid-${Date.now()}.json`);

  writeFileSync(validFile, JSON.stringify({
    status: "DONE",
    files: ["tools/workflow.mjs"],
    tests: "было 10 → стало 12",
    interfaces: "suggestTier",
    requirements: "R06, R07",
    concerns: "none",
  }));

  writeFileSync(invalidFile, JSON.stringify({
    status: "FAILED",
    files: [],
    tests: "none",
    interfaces: "none",
    requirements: "none",
    concerns: "blocker",
  }));

  try {
    const stdoutValid = execFileSync(process.execPath, [
      "tools/orchestrator-evals.mjs",
      "--subject",
      validFile,
    ], { encoding: "utf8" });
    assert.ok(stdoutValid.includes("PASS eval-status"));

    assert.throws(() => {
      execFileSync(process.execPath, [
        "tools/orchestrator-evals.mjs",
        "--subject",
        invalidFile,
      ], { encoding: "utf8" });
    }, (err) => {
      assert.equal(err.status, 1);
      return true;
    });
  } finally {
    try { unlinkSync(validFile); } catch {}
    try { unlinkSync(invalidFile); } catch {}
  }
});

