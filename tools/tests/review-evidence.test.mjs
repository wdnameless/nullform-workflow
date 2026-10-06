/**
 * tools/tests/review-evidence.test.mjs
 * Comprehensive behavior and security boundary tests for review execution integrity (R02).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReviewRecord,
  recordStageB,
  validateReviewEvidence,
  loadReviewEvidence,
  computeFileHash,
  computeSourceDigest,
  computeRolePromptHash,
  computeTestFilesHash,
  countSourceChanges,
  isFlashOrFallback,
  EVIDENCE_FILE,
} from "../review-evidence.mjs";
import { nativeRunner, prepareEvidence } from "./fixtures/review-execution.mjs";

function setupMockProject(root, changeId = "feat-test") {
  const changeDir = join(root, "openspec", "changes", changeId);
  const agentDir = join(root, "agent", "agents");
  mkdirSync(join(changeDir, "specs"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "tools", "tests"), { recursive: true });

  writeFileSync(join(agentDir, "reviewer.md"), "# Reviewer Role\nCheck diff.\n", "utf8");
  writeFileSync(join(agentDir, "oracle.md"), "# Oracle Role\nAcceptance only.\n", "utf8");
  writeFileSync(join(changeDir, "manifest.md"), "| R01 | User quote |\n", "utf8");
  writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- t1\n", "utf8");
  writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
  writeFileSync(join(root, "tools", "tests", "sample.test.mjs"), "// test suite\n", "utf8");
  prepareEvidence(root, changeId);
  return { changeDir };
}

const makeMockOmpRunner = nativeRunner;

test("review-evidence: static ACCEPT markdown alone fails gate", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-static-"));
  try {
    setupMockProject(root, "static-only");
    const res = validateReviewEvidence({ root, changeId: "static-only", tier: "T2" });
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /missing review execution evidence/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: review-run rejects zero token usage", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-zerousage-"));
  try {
    setupMockProject(root, "feat-zero");
    const zeroRunner = makeMockOmpRunner("sess-zero", { input: 0, output: 0 });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-zero", role: "reviewer", ompRunner: zeroRunner }),
      /zero.*token usage/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: review-run rejects failed process exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-failcode-"));
  try {
    setupMockProject(root, "feat-fail");
    const failRunner = () => ({ status: 1, stderr: "Process crashed" });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-fail", role: "reviewer", ompRunner: failRunner }),
      /runner exited with code 1/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: reviewer + stage-b + oracle end-to-end recording", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-e2e-"));
  try {
    const { changeDir } = setupMockProject(root, "feat-e2e");
    const revRunner = makeMockOmpRunner("sess-rev-1", { input: 200, output: 80 }, "correct");
    const oraRunner = makeMockOmpRunner("sess-ora-1", { input: 300, output: 90 }, "correct", { text: "ACCEPT: all requirements verified." });

    const revRes = runReviewRecord({ root, changeId: "feat-e2e", role: "reviewer", ompRunner: revRunner });
    assert.equal(revRes.ok, true);
    assert.equal(revRes.record.verdict, "ACCEPT");
    assert.equal(revRes.record.nativeVerdict, "correct");

    const stageBRes = recordStageB({
      root,
      changeId: "feat-e2e",
      disposition: "lean-already",
      testCmd: `"${process.execPath}" tests/product.test.cjs "openspec/changes/feat-e2e/manifest.md"`,
      summary: "Lean already.",
    });
    assert.equal(stageBRes.ok, true);
    assert.equal(stageBRes.stageB.disposition, "lean-already");

    const oraRes = runReviewRecord({ root, changeId: "feat-e2e", role: "oracle", ompRunner: oraRunner });
    assert.equal(oraRes.ok, true);
    assert.equal(oraRes.record.verdict, "ACCEPT");

    const val = validateReviewEvidence({ root, changeId: "feat-e2e", tier: "T2" });
    assert.equal(val.ok, true, `Validation failed: ${val.errors.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: rejects duplicate session IDs across oracles", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-dup-"));
  try {
    setupMockProject(root, "feat-dup");
    const runner = makeMockOmpRunner("duplicate-session-id", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-dup", role: "reviewer", ompRunner: runner });
    recordStageB({
      root,
      changeId: "feat-dup",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });
    // First oracle with same session ID as reviewer must fail
    assert.throws(() => runReviewRecord({ root, changeId: "feat-dup", role: "oracle", ompRunner: runner }), /duplicate session ID/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stage-b fails if test files were mutated", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stagemut-"));
  try {
    setupMockProject(root, "feat-mut");
    const revRunner = makeMockOmpRunner("sess-rev-m", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-mut", role: "reviewer", ompRunner: revRunner });

    // Test runner that mutates a test file during execution
    const mutatingTestRunner = () => {
      writeFileSync(join(root, "tools", "tests", "sample.test.mjs"), "// mutated tests\n", "utf8");
      return { status: 0, stdout: "ok" };
    };

    assert.throws(
      () =>
        recordStageB({
          root,
          changeId: "feat-mut",
          disposition: "lean-already",
          testCmd: "dummy",
          testRunner: mutatingTestRunner,
        }),
      /frozen test files were modified/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: flash oracle requires 2 distinct sessions when exceeding Oracle-lite", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-flash-"));
  try {
    setupMockProject(root, "feat-flash");
    const revRunner = makeMockOmpRunner("sess-rev-f", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-flash", role: "reviewer", ompRunner: revRunner });
    recordStageB({
      root,
      changeId: "feat-flash",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });

    // 1 flash oracle
    const flashRunner1 = makeMockOmpRunner("sess-ora-f1", { input: 100, output: 50 }, "correct", {
      provider: "google", model: "gemini-3.8-flash",
      text: "ACCEPT: verified.",
    });
    runReviewRecord({ root, changeId: "feat-flash", role: "oracle", ompRunner: flashRunner1 });

    // Simulate exceeding Oracle-lite (e.g. 5 changed files)
    const valSingle = validateReviewEvidence({ root, changeId: "feat-flash", tier: "T2" });
    assert.equal(valSingle.ok, false);
    assert.match(valSingle.errors[0], /requires at least 2 distinct independent sessions/i);
    // When a 2nd distinct flash oracle session is recorded:
    const flashRunner2 = makeMockOmpRunner("sess-ora-f2", { input: 110, output: 55 }, "correct", {
      provider: "google", model: "gemini-3.8-flash",
      text: "ACCEPT: double check verified.",
    });
    runReviewRecord({ root, changeId: "feat-flash", role: "oracle", ompRunner: flashRunner2 });
    const valDouble = validateReviewEvidence({ root, changeId: "feat-flash", tier: "T2" });
    assert.equal(valDouble.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stale manifest hash is detected and rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-staleman-"));
  try {
    setupMockProject(root, "feat-stale");
    const revRunner = makeMockOmpRunner("sess-rev-s", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-stale", role: "reviewer", ompRunner: revRunner });
    recordStageB({
      root,
      changeId: "feat-stale",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });
    const oraRunner = makeMockOmpRunner("sess-ora-s", { input: 100, output: 50 }, "correct", { text: "ACCEPT" });
    runReviewRecord({ root, changeId: "feat-stale", role: "oracle", ompRunner: oraRunner });

    // Mutate manifest.md
    writeFileSync(join(root, "openspec", "changes", "feat-stale", "manifest.md"), "| R01 | altered |\n", "utf8");

    const val = validateReviewEvidence({ root, changeId: "feat-stale", tier: "T2" });
    assert.equal(val.ok, false);
    assert.match(val.errors.join("; "), /manifest hash mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("review-evidence: user prompt, tool echo, and thinking containing ACCEPT never pass verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-fake-accept-"));
  try {
    setupMockProject(root, "feat-fake");
    const fakeRunner = nativeRunner("sess-fake", { input: 100, output: 50 }, "incorrect", {
      content: [{ type: "thinking", text: "ACCEPT echo" }, { type: "text", text: JSON.stringify({ findings: [{ title: "Broken invariant", body: "R01 fails on the fixture consumer.", priority: 1, confidence: 0.9, file_path: "tools/tests/sample.test.mjs", line_start: 1, line_end: 1 }], overall_correctness: "incorrect", overall_explanation: "Not accepted", overall_confidence_score: 0.9 }) }],
    });

    const res = runReviewRecord({ root, changeId: "feat-fake", role: "reviewer", ompRunner: fakeRunner });
    assert.equal(res.record.verdict, "REJECT");
    assert.notEqual(res.record.verdict, "ACCEPT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: assistant error/aborted/length stop is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stop-"));
  try {
    setupMockProject(root, "feat-stop");
    for (const stopReason of ["error", "aborted", "length"]) {
      const runner = nativeRunner(`sess-stop-${stopReason}`, { input: 50, output: 50 }, "correct", { stopReason });
      assert.throws(
        () => runReviewRecord({ root, changeId: "feat-stop", role: "reviewer", ompRunner: runner }),
        new RegExp(`abnormal stop reason '${stopReason}'`, "i")
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: effective model mismatch is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-mismatch-"));
  try {
    setupMockProject(root, "feat-mismatch");
    const runner = makeMockOmpRunner("sess-mismatch", { input: 100, output: 50 }, "correct", {
      model: "cheap-fallback-model",
    });
    assert.throws(
      () =>
        runReviewRecord({
          root,
          changeId: "feat-mismatch",
          role: "reviewer",
          model: "anthropic/claude-3-5-sonnet",
          ompRunner: runner,
        }),
      /effective model mismatch/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: empty or missing final report is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-empty-"));
  try {
    setupMockProject(root, "feat-empty");
    const emptyRunner = nativeRunner("sess-empty", { input: 50, output: 50 }, "correct", { content: [{ type: "thinking", text: "only thinking" }] });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-empty", role: "reviewer", ompRunner: emptyRunner }),
      /empty\/final report missing/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stale earlier reviewer rejects appending new oracle", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stale-rev-"));
  try {
    setupMockProject(root, "feat-stale-rev");
    const runner = makeMockOmpRunner("sess-stale-rev", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-stale-rev", role: "reviewer", ompRunner: runner });

    // Modify a source file in repo after reviewer ran
    writeFileSync(join(root, "tracked_source.txt"), "new source modification\n", "utf8");

    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-stale-rev", role: "oracle", ompRunner: runner }),
      /earlier reviewer record is stale/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("review-evidence: dryRun option returns clean plan without invoking native process", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-dry-"));
  try {
    setupMockProject(root, "feat-dry");
    const res = runReviewRecord({ root, changeId: "feat-dry", role: "reviewer", dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
