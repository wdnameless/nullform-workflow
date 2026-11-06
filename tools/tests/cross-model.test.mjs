import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReviewRecord, recordStageB, loadReviewEvidence } from "../review/evidence.mjs";
import { nativeRunner, prepareEvidence } from "./fixtures/review-execution.mjs";
import { cmdReviewRun } from "../workflow-ci.mjs";
import { runWorkflowCli } from "../workflow.mjs";

function setupProject(root, changeId = "feat-cross") {
  const changeDir = join(root, "openspec", "changes", changeId);
  const agentDir = join(root, "agent", "agents");
  mkdirSync(join(changeDir, "specs"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "tools", "tests"), { recursive: true });

  writeFileSync(join(agentDir, "reviewer.md"), "# Reviewer\nCheck diff.\n", "utf8");
  writeFileSync(join(agentDir, "oracle.md"), "# Oracle\nAcceptance.\n", "utf8");
  writeFileSync(join(changeDir, "manifest.md"), "| R01 | Cross-model critique | verify | open |\n", "utf8");
  writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- t1\n", "utf8");
  writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
  prepareEvidence(root, changeId);

  // Reviewer pass
  const revRunner = nativeRunner("sess-rev-01", { input: 100, output: 50 }, "correct", {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
  });
  runReviewRecord({ root, changeId, role: "reviewer", model: "anthropic/claude-3-5-sonnet", ompRunner: revRunner });

  // Stage-B pass
  recordStageB({
    root,
    changeId,
    disposition: "lean-already",
    testCmd: `"${process.execPath}" tests/product.test.cjs "openspec/changes/${changeId}/manifest.md"`,
    summary: "Baseline unchanged.",
  });

  return { changeDir };
}

test("cross-model: flag absent -> single pass, unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-absent-"));
  try {
    const changeId = "feat-single";
    const { changeDir } = setupProject(root, changeId);
    let oraCalls = 0;
    const oraRunner = (opts) => {
      oraCalls++;
      return nativeRunner("sess-ora-single", { input: 200, output: 60 }, "correct", {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        text: "Verdict: ACCEPT\nEvidence verified.\n",
      })(opts);
    };

    const code = cmdReviewRun(root, {
      change: changeId,
      role: "oracle",
      model: "anthropic/claude-3-5-sonnet",
      ompRunner: oraRunner,
    });

    assert.equal(code, 0, "review-run without cross-model flag must exit 0 on accept");
    assert.equal(oraCalls, 1, "exactly one oracle pass must run when flag is absent");

    const evidence = loadReviewEvidence(changeDir);
    assert.equal(evidence.oracles.length, 1, "exactly one oracle record stored");
    assert.equal(evidence.oracles[0].verdict, "ACCEPT");
    assert.equal(evidence.crossModel, undefined, "crossModel field absent when flag absent");
    assert.equal(evidence.escalated, undefined, "escalated flag absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-model: same verdicts -> accept", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-same-"));
  try {
    const changeId = "feat-same";
    const { changeDir } = setupProject(root, changeId);
    let passes = 0;
    const runner = (opts) => {
      passes++;
      const isCross = passes === 2;
      return nativeRunner(`sess-ora-same-${passes}`, { input: 200, output: 60 }, "correct", {
        provider: isCross ? "openai" : "anthropic",
        model: isCross ? "gpt-4o" : "claude-3-5-sonnet",
        text: "Verdict: ACCEPT\nCriteria verified.\n",
      })(opts);
    };

    const code = cmdReviewRun(root, {
      change: changeId,
      role: "oracle",
      model: "anthropic/claude-3-5-sonnet",
      "cross-model": "openai/gpt-4o",
      ompRunner: runner,
      env: { OPENAI_API_KEY: "test-openai-key" },
    });

    assert.equal(code, 0, "equal ACCEPT verdicts must exit 0");
    assert.equal(passes, 2, "both primary and cross-model passes must execute");

    const evidence = loadReviewEvidence(changeDir);
    assert.equal(evidence.oracles.length, 2, "both oracle records recorded");
    assert.equal(evidence.oracles[0].verdict, "ACCEPT");
    assert.equal(evidence.oracles[1].verdict, "ACCEPT");
    assert.equal(evidence.verdict, "ACCEPT", "single unified verdict is ACCEPT");
    assert.equal(evidence.crossModel?.matches, true, "crossModel matches recorded");
    assert.equal(evidence.escalated, undefined, "escalation must not trigger on equal verdicts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-model: different verdicts -> escalation marker, both recorded, no ACCEPT", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-diff-"));
  try {
    const changeId = "feat-diff";
    const { changeDir } = setupProject(root, changeId);
    let passCount = 0;
    const runner1 = (opts) => {
      passCount++;
      return nativeRunner("sess-ora-diff-1", { input: 200, output: 60 }, "correct", {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        text: "Verdict: ACCEPT\nPrimary model approved.\n",
      })(opts);
    };
    const runner2 = (opts) => {
      passCount++;
      return nativeRunner("sess-ora-diff-2", { input: 200, output: 60 }, "rejected", {
        provider: "openai",
        model: "gpt-4o",
        text: "Verdict: REJECT\nCross-model found missing invariant.\n",
      })(opts);
    };

    const code = cmdReviewRun(root, {
      change: changeId,
      role: "oracle",
      model: "anthropic/claude-3-5-sonnet",
      "cross-model": "openai/gpt-4o",
      ompRunner: runner1,
      crossModelRunner: runner2,
      env: { OPENAI_API_KEY: "test-openai-key" },
    });

    assert.equal(code, 1, "divergent verdicts must exit 1 (no ACCEPT)");
    assert.equal(passCount, 2, "both passes executed");

    const evidence = loadReviewEvidence(changeDir);
    assert.equal(evidence.oracles.length, 2, "both oracle records recorded");
    assert.equal(evidence.oracles[0].verdict, "ACCEPT");
    assert.equal(evidence.oracles[1].verdict, "REJECT");
    assert.equal(evidence.escalated, true, "escalated flag set in evidence");
    assert.ok(evidence.escalation, "escalation record present");
    assert.deepEqual(evidence.escalation.verdicts, ["ACCEPT", "REJECT"], "both verdicts captured in escalation record");
    assert.notEqual(evidence.verdict, "ACCEPT", "no ACCEPT granted");
    assert.equal(evidence.crossModel?.matches, false);
    assert.equal(evidence.crossModel?.escalated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-model: missing provider / absent credential -> unverified, never simulated", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-unverified-"));
  try {
    const changeId = "feat-unverified";
    const { changeDir } = setupProject(root, changeId);
    let passCount = 0;
    const runner = (opts) => {
      passCount++;
      return nativeRunner("sess-ora-pass1", { input: 200, output: 60 }, "correct", {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        text: "Verdict: ACCEPT\nPass 1 accepted.\n",
      })(opts);
    };

    // Case A: Unknown / unavailable provider
    const codeA = cmdReviewRun(root, {
      change: changeId,
      role: "oracle",
      model: "anthropic/claude-3-5-sonnet",
      "cross-model": "unsupported-provider/model-x",
      ompRunner: runner,
      env: {},
    });

    assert.equal(codeA, 1, "unverified cross-model must exit 1 (no ACCEPT)");
    assert.equal(passCount, 1, "second pass MUST NOT be simulated when provider is unavailable");

    const evidenceA = loadReviewEvidence(changeDir);
    assert.equal(evidenceA.crossModel?.status, "unverified");
    assert.equal(evidenceA.crossModel?.verdict, "UNVERIFIED");
    assert.equal(evidenceA.verdict, "UNVERIFIED");
    assert.equal(evidenceA.unverified, true);

    // Case B: Admitted provider (openai) but credential absent from environment
    passCount = 0;
    const codeB = cmdReviewRun(root, {
      change: changeId,
      role: "oracle",
      model: "anthropic/claude-3-5-sonnet",
      "cross-model": "openai/gpt-4o",
      ompRunner: runner,
      env: { OPENAI_API_KEY: "" }, // empty / absent
    });

    assert.equal(codeB, 1, "absent credential must exit 1 (no ACCEPT)");
    assert.equal(passCount, 1, "second pass MUST NOT be simulated when credential is absent");

    const evidenceB = loadReviewEvidence(changeDir);
    assert.equal(evidenceB.crossModel?.status, "unverified");
    assert.equal(evidenceB.crossModel?.verdict, "UNVERIFIED");
    assert.equal(evidenceB.verdict, "UNVERIFIED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-model: rejects invalid cross-model flag usage", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-invalid-"));
  try {
    const changeId = "feat-invalid";
    setupProject(root, changeId);

    // Cross-model with non-oracle role must exit 1
    const codeRole = cmdReviewRun(root, { change: changeId, role: "reviewer", "cross-model": "openai/gpt-4o" });
    assert.equal(codeRole, 1, "non-oracle role with cross-model must fail");

    // Malformed format must exit 1
    const codeFmt = cmdReviewRun(root, { change: changeId, role: "oracle", "cross-model": "baremodel" });
    assert.equal(codeFmt, 1, "malformed cross-model format must fail");

    // Boolean without value must exit 1
    const codeBool = cmdReviewRun(root, { change: changeId, role: "oracle", "cross-model": true });
    assert.equal(codeBool, 1, "boolean cross-model flag without value must fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cross-model: runWorkflowCli validates --cross-model CLI flag parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "cm-cli-"));
  try {
    const changeId = "feat-cli";
    setupProject(root, changeId);

    // Flag with missing provider fails with unverified exit 1
    const code = runWorkflowCli([
      "review-run",
      "--root", root,
      "--change", changeId,
      "--role", "oracle",
      "--model", "anthropic/claude-3-5-sonnet",
      "--cross-model", "missing-provider/model-x",
      "--product-command", '["node", "-v"]',
      "--dry-run",
    ], { cwd: root });

    // Dry run with cross-model must succeed (reporting plan)
    assert.equal(code, 0, "CLI review-run dry-run with cross-model must succeed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
