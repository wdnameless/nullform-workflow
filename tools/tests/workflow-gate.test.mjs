/**
 * tools/tests/workflow-gate.test.mjs
 * Behavioral tests for workflow gate hardening (R02, R04):
 * - missing path: T2 requires real rooted paths for manifest, openspec, interfaces
 * - path containment: rejects paths escaping root (relative traversal)
 * - shared validator: cmdCheck and cmdClose agree when evidence is emptied/invalidated
 * - negative oracle: REJECT verdict cannot close
 * - retained evidence: missing or empty artifact files fail close
 * - check-ci: PR labels, lean T0/T1, committed T2/T3 OpenSpec evidence (proposal + tasks + specs + manifest + interfaces + oracle)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testTierGate } from "../verify.mjs";
import {
  cmdStart,
  cmdArtifact,
  cmdCheck,
  cmdEscalate,
  cmdClose,
  cmdCheckCi,
  load,
} from "../workflow.mjs";

function setupT2(root) {
  mkdirSync(join(root, "openspec", "changes", "feat-x"), { recursive: true });
  writeFileSync(join(root, "manifest.md"), "| R01 | \"user wanted X\" |\n", "utf8");
  writeFileSync(join(root, "interfaces.md"), "# Interfaces\n- export function run(): void\n", "utf8");
  writeFileSync(join(root, "openspec", "changes", "feat-x", "proposal.md"), "proposal body\n", "utf8");
}

test("gate: T2 rejects registering manifest, openspec, or interfaces without a path", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-path-"));
  try {
    cmdStart(root, { tier: "T2", task: "missing-path" });

    // Manifest without path must fail
    assert.equal(
      cmdArtifact(root, { kind: "manifest", detail: "captured R01 verbatim from the brief" }),
      1,
      "manifest without --path must be rejected"
    );

    // Interfaces without path must fail
    assert.equal(
      cmdArtifact(root, { kind: "interfaces", detail: "public signatures recorded: fn() -> void, plus invariants" }),
      1,
      "interfaces without --path must be rejected"
    );

    // Openspec without path must fail
    assert.equal(
      cmdArtifact(root, { kind: "openspec", detail: "change proposal scaffolded and validated" }),
      1,
      "openspec without --path must be rejected"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: path escaping project root is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-escape-"));
  try {
    cmdStart(root, { tier: "T2", task: "escape-path" });

    assert.equal(
      cmdArtifact(root, { kind: "manifest", path: "../outside.md", detail: "captured R01 verbatim from the brief" }),
      1,
      "manifest with escaping path must be rejected"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: shared validator ensures cmdCheck and cmdClose agree when manifest is emptied", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-empty-manifest-"));
  try {
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "empty-manifest" });

    assert.equal(cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" }), 0);
    assert.equal(cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" }), 0);
    assert.equal(cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" }), 0);
    assert.equal(cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" }), 0);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Empty the manifest file
    writeFileSync(join(root, "manifest.md"), "", "utf8");

    // Both cmdCheck and cmdClose must report failure
    assert.equal(cmdCheck(root), 1, "cmdCheck must report INCOMPLETE when manifest is empty");
    assert.equal(cmdClose(root, {}), 1, "cmdClose must refuse when manifest is empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: T2 rejects negative oracle verdict at close", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-reject-"));
  try {
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "negative-oracle" });

    assert.equal(cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" }), 0);
    assert.equal(cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" }), 0);
    assert.equal(cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" }), 0);
    assert.equal(cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" }), 0);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "REJECT: acceptance tests failed on boundary checks" }), 0);

    const checkCode = cmdCheck(root);
    assert.equal(checkCode, 1, "cmdCheck must fail when oracle verdict is REJECT");

    const closeCode = cmdClose(root, {});
    assert.equal(closeCode, 1, "cmdClose must refuse negative oracle verdict");

    const st = load(root);
    assert.equal(st.status, "open", "task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: retained evidence check refuses close if artifact file is deleted before close", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-retained-"));
  try {
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "deleted-artifact" });

    assert.equal(cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" }), 0);
    assert.equal(cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" }), 0);
    assert.equal(cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" }), 0);
    assert.equal(cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" }), 0);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Delete manifest file after recording
    rmSync(join(root, "manifest.md"));

    const closeCode = cmdClose(root, {});
    assert.equal(closeCode, 1, "cmdClose must fail when retained evidence is missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: enforces PR tier label and lean T0/T1 execution", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-ci-labels-"));
  try {
    // Missing tier or labels fails
    assert.equal(cmdCheckCi(root, {}), 1, "missing tier and labels must fail");

    // PR without workflow tier label fails
    assert.equal(
      cmdCheckCi(root, { labels: "enhancement,documentation" }),
      1,
      "PR without workflow:T* label must fail"
    );

    // PR with multiple workflow tier labels fails
    assert.equal(
      cmdCheckCi(root, { labels: "workflow:T1,workflow:T2" }),
      1,
      "PR with multiple workflow labels must fail"
    );

    // Lean T0 and T1 succeed without change directory
    assert.equal(cmdCheckCi(root, { labels: "workflow:T0" }), 0, "T0 is lean");
    assert.equal(cmdCheckCi(root, { labels: "workflow:T1" }), 0, "T1 is lean");
    assert.equal(cmdCheckCi(root, { tier: "T0" }), 0, "direct tier T0 is lean");
    assert.equal(cmdCheckCi(root, { tier: "T1" }), 0, "direct tier T1 is lean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: validates committed T2 OpenSpec artifacts (manifest + proposal + tasks + specs + interfaces + oracle)", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-ci-artifacts-"));
  try {
    // T2 without --change fails
    assert.equal(cmdCheckCi(root, { tier: "T2" }), 1, "T2 without --change must fail");

    const changeId = "feature-hardened";
    const changeDir = join(root, "openspec", "changes", changeId);
    mkdirSync(changeDir, { recursive: true });

    // Missing manifest.md fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing manifest fails");
    writeFileSync(join(changeDir, "manifest.md"), "| R01 | user quote |\n", "utf8");

    // Missing proposal.md fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing proposal fails");
    writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");

    // Missing tasks.md fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing tasks fails");
    writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- task 1\n", "utf8");

    // Missing specs/ fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing specs dir fails");
    mkdirSync(join(changeDir, "specs"), { recursive: true });
    // Empty specs/ fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "empty specs dir fails");
    writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");

    // Missing interfaces.md fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing interfaces fails");
    writeFileSync(join(changeDir, "interfaces.md"), "# Interfaces\n- export fn(): void\n", "utf8");

    // Missing oracle.md fails
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "missing oracle fails");

    // Negative oracle.md (REJECT) fails
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: REJECT\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "oracle REJECT must fail");

    // Positive oracle.md (ACCEPT) succeeds
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nEvidence verified.\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 0, "complete valid evidence passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("ci contract: workflow gate configurations trigger on label changes", () => {
  const root = join(import.meta.dirname, "../..");
  const repoGatePath = join(root, ".github", "workflows", "repo-gate.yml");
  const templatePath = join(root, "templates", "ci", "workflow-gate.yml");

  const repoGateYaml = readFileSync(repoGatePath, "utf8");
  assert.match(
    repoGateYaml,
    /types:\s*\[opened,\s*synchronize,\s*reopened,\s*labeled,\s*unlabeled\]/,
    "repo-gate.yml must trigger on PR label changes"
  );

  const templateYaml = readFileSync(templatePath, "utf8");
  assert.match(
    templateYaml,
    /types:\s*\[opened,\s*synchronize,\s*reopened,\s*labeled,\s*unlabeled\]/,
    "templates/ci/workflow-gate.yml must trigger on PR label changes"
  );
});

test("gate: external manifest or openspec symlink pointing outside project root is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "wf-gate-symlink-outside-"));
  try {
    writeFileSync(join(outside, "manifest.md"), "| R01 | external quote |\n", "utf8");
    mkdirSync(join(outside, "openspec-change"), { recursive: true });
    writeFileSync(join(outside, "openspec-change", "proposal.md"), "# Proposal\n", "utf8");

    cmdStart(root, { tier: "T2", task: "symlink-test" });

    // Create external symlink for manifest
    try {
      symlinkSync(join(outside, "manifest.md"), join(root, "manifest.md"));
      const artCode = cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "verbatim capture" });
      assert.equal(artCode, 1, "external manifest symlink must be rejected on registration");
    } catch (err) {
      // If symlink creation requires elevated privileges on Windows without developer mode,
      // verify that realpath validation still protects against escaped paths
      if (err.code !== "EPERM") throw err;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("check-ci: distinguishes anchored positive/negative verdicts from prose words", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-not-accepted-"));
  try {
    const changeId = "feature-verdict";
    const changeDir = join(root, "openspec", "changes", changeId);
    mkdirSync(join(changeDir, "specs"), { recursive: true });

    writeFileSync(join(changeDir, "manifest.md"), "| R01 | user quote |\n", "utf8");
    writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
    writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- task 1\n", "utf8");
    writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
    writeFileSync(join(changeDir, "interfaces.md"), "# Interfaces\n- export fn(): void\n", "utf8");

    // (1) Verdict: NOT ACCEPTED must fail
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: NOT ACCEPTED\nBoundary checks failed.\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "NOT ACCEPTED verdict must fail");

    // (2) Anchored Verdict: REJECT alongside anchored ACCEPT must fail
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nVerdict: REJECT\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "contradictory anchored REJECT alongside ACCEPT must fail");

    // (3) Verdict: ACCEPT with ordinary prose using the word 'rejected' must pass
    writeFileSync(
      join(changeDir, "oracle.md"),
      "# Oracle\nVerdict: ACCEPT\nExternal symlink artifacts are rejected; contradictory wrapper status is rejected.\n",
      "utf8"
    );
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 0, "Verdict: ACCEPT with prose 'rejected' must pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("check-ci: rejects manifest modified in commits after oracle acceptance", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-post-oracle-"));
  function git(...args) {
    return spawnSync("git", args, {
      cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    });
  }
  try {
    git("init", "-q", ".");
    const changeId = "post-oracle-mod";
    const changeDir = join(root, "openspec", "changes", changeId);
    mkdirSync(join(changeDir, "specs"), { recursive: true });

    writeFileSync(join(changeDir, "manifest.md"), "| R01 | quote |\n", "utf8");
    writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
    writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- task\n", "utf8");
    writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
    writeFileSync(join(changeDir, "interfaces.md"), "# Interfaces\n- fn(): void\n", "utf8");
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nAll passed.\n", "utf8");

    git("add", "-A");
    git("commit", "-qm", "oracle accepted");

    // Check passes immediately after oracle commit
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 0, "clean commit passes check-ci");

    // Now edit and commit manifest.md after the oracle commit
    writeFileSync(join(changeDir, "manifest.md"), "| R01 | modified quote |\n| R02 | new requirement |\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "modify manifest after oracle");

    // check-ci must detect that manifest changed after oracle commit and fail
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "manifest changed after oracle commit must fail check-ci");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: rejects T0 PR when changed files against --base-ref exceed 2 without approved override", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-base-ref-"));
  function git(...args) {
    const res = spawnSync("git", args, {
      cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
    return res;
  }
  try {
    git("init", "-q", "-b", "main", ".");
    writeFileSync(join(root, "file1.txt"), "1\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "base commit");

    // Switch to feature branch so main remains at the base commit
    git("checkout", "-qb", "feature");

    // 1 file changed against main: passes T0
    writeFileSync(join(root, "file1.txt"), "1 modified\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "change 1 file");
    assert.equal(cmdCheckCi(root, { tier: "T0", "base-ref": "main" }), 0, "1 file changed passes T0");

    // Add 2 more files (total 3 files changed against main)
    writeFileSync(join(root, "file2.txt"), "2\n", "utf8");
    writeFileSync(join(root, "file3.txt"), "3\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "add 2 more files");

    // Exceeds 2 files without override: must fail
    assert.equal(cmdCheckCi(root, { tier: "T0", "base-ref": "main" }), 1, "exceeding 2 files must fail T0");

    // With approved override flag: succeeds
    assert.equal(cmdCheckCi(root, { tier: "T0", "base-ref": "main", override: true }), 0, "approved override passes");

    // Nonexistent base ref must fail rather than silently falling through
    assert.equal(cmdCheckCi(root, { tier: "T0", "base-ref": "nonexistent-branch-xyz" }), 1, "nonexistent base ref must fail check-ci");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalate: monotonic tier escalation preserves task identity, start time, and prior recon", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-escalate-"));
  try {
    cmdStart(root, { tier: "T1", task: "investigate module" });
    assert.equal(cmdArtifact(root, { kind: "recon", detail: "detailed recon of module dependencies" }), 0);

    const initialSt = load(root);
    assert.equal(initialSt.tier, "T1");
    assert.ok(initialSt.artifacts.recon);

    // Escalate to T2
    const code = cmdEscalate(root, { tier: "T2" });
    assert.equal(code, 0, "escalation to T2 must succeed");

    const escalatedSt = load(root);
    assert.equal(escalatedSt.tier, "T2");
    assert.equal(escalatedSt.task, "investigate module", "task identity must be preserved");
    assert.equal(escalatedSt.startedAt, initialSt.startedAt, "start time must be preserved");
    assert.ok(escalatedSt.artifacts.recon, "prior recon evidence must be retained");
    assert.equal(escalatedSt.artifacts.recon.detail, "detailed recon of module dependencies");

    // Monotonic check: escalating to lower or same tier must be rejected
    assert.equal(cmdEscalate(root, { tier: "T1" }), 1, "escalating down to T1 must be rejected");
    assert.equal(cmdEscalate(root, { tier: "T2" }), 1, "escalating to same tier T2 must be rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start: replacing active task with --force requires --reason and records deviation", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-start-force-"));
  try {
    assert.equal(cmdStart(root, { tier: "T1", task: "initial task" }), 0);

    // Starting new task without force is rejected
    assert.equal(cmdStart(root, { tier: "T2", task: "replacement task" }), 2);

    // Starting new task with force but without reason is rejected
    assert.equal(cmdStart(root, { tier: "T2", task: "replacement task", force: true }), 1);

    // Starting with force and reason succeeds and records deviation
    assert.equal(cmdStart(root, { tier: "T2", task: "replacement task", force: true, reason: "replacing initial task" }), 0);

    const st = load(root);
    assert.equal(st.task, "replacement task");
    assert.equal(st.tier, "T2");
    assert.ok(st.deviation);
    assert.equal(st.deviation.forced, true);
    assert.equal(st.deviation.reason, "replacing initial task");
    assert.equal(st.deviation.replacedTask.task, "initial task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: rejects invalid changeId containing path traversal or illegal characters", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-slug-"));
  try {
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "../escaping-change" }), 1, "traversal change id must fail");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "change with spaces" }), 1, "space in change id must fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify: testTierGate passes probe with subprocess status assertions", () => {
  const harnessRoot = resolve(import.meta.dirname, "../..");
  const res = testTierGate(harnessRoot, true);
  assert.equal(res, "T0 passes, T2 blocks, fake paths rejected, forced close recorded");
});

test("check-ci: rejects external symlink in change directory or artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-ci-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "wf-gate-ci-symlink-outside-"));
  try {
    const changeId = "symlink-change";
    const changeDir = join(root, "openspec", "changes", changeId);
    mkdirSync(join(changeDir, "specs"), { recursive: true });

    writeFileSync(join(outside, "manifest.md"), "| R01 | quote |\n", "utf8");
    writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
    writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- task\n", "utf8");
    writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
    writeFileSync(join(changeDir, "interfaces.md"), "# Interfaces\n- fn(): void\n", "utf8");
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");

    try {
      symlinkSync(join(outside, "manifest.md"), join(changeDir, "manifest.md"));
      assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "external symlink manifest must fail check-ci");
    } catch (err) {
      if (err.code !== "EPERM") throw err;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
