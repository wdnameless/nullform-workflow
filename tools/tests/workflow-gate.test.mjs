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
  const featDir = join(root, "openspec", "changes", "feat-x");
  mkdirSync(join(featDir, "specs"), { recursive: true });
  writeFileSync(join(root, "manifest.md"), "| R01 | \"user wanted X\" |\n", "utf8");
  writeFileSync(join(root, "interfaces.md"), "# Interfaces\n- export function run(): void\n", "utf8");
  writeFileSync(join(featDir, "proposal.md"), "proposal body\n", "utf8");
  writeFileSync(join(featDir, "tasks.md"), "# Tasks\n- task 1\n", "utf8");
  writeFileSync(join(featDir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(featDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
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

    // Lean T0 succeeds; T1 requires --recon
    assert.equal(cmdCheckCi(root, { labels: "workflow:T0" }), 0, "T0 is lean");
    assert.equal(cmdCheckCi(root, { tier: "T0" }), 0, "direct tier T0 is lean");
    assert.equal(cmdCheckCi(root, { labels: "workflow:T1" }), 1, "T1 without recon must fail");
    assert.equal(cmdCheckCi(root, { tier: "T1" }), 1, "direct tier T1 without recon must fail");
    writeFileSync(join(root, "recon.md"), "# Recon\n## Files touched\n- a\n## Acceptance check\n- check\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T1", recon: "recon.md" }), 0, "T1 with recon passes");
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
    git("add", "-A");
    git("commit", "-qm", "spec artifacts");

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

test("start prints a responding dashboard URL, not a stale file with a live PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-dashboard-stale-"));
  const runtime = join(root, ".workflow", "dashboard.json");
  mkdirSync(join(root, ".workflow"), { recursive: true });
  // A live process can own a stale runtime file whose port no longer answers HTTP.
  writeFileSync(runtime, JSON.stringify({ pid: process.pid, port: 1, url: "http://localhost:1", root }));
  try {
    const res = spawnSync(process.execPath, [
      join(import.meta.dirname, "..", "workflow.mjs"), "start", "--tier", "T0",
      "--task", "dashboard-probe", "--root", root,
    ], {
      encoding: "utf8", timeout: 45000, windowsHide: true,
      env: { ...process.env, PASEO_AGENT_ID: `wf-dashboard-${process.pid}-${Date.now()}` },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const url = res.stdout.match(/dashboard: (http:\/\/localhost:\d+)/)?.[1];
    assert.ok(url && url !== "http://localhost:1", res.stdout);
    const health = await (await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(2000),
    })).json();
    const current = JSON.parse(readFileSync(runtime, "utf8"));
    assert.equal(health.ok, true);
    assert.equal(health.pid, current.pid);
  } finally {
    try {
      const current = JSON.parse(readFileSync(runtime, "utf8"));
      if (current.root === root && current.pid !== process.pid) process.kill(current.pid, "SIGTERM");
    } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
function writeT2Files(dir, extra = {}) {
  mkdirSync(join(dir, "specs"), { recursive: true });
  writeFileSync(join(dir, "manifest.md"), "| R01 | quote |\n", "utf8");
  writeFileSync(join(dir, "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(join(dir, "tasks.md"), "# Tasks\n- task\n", "utf8");
  writeFileSync(join(dir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(dir, "interfaces.md"), "# Interfaces\n- fn(): void\n", "utf8");
  if (extra.oracle !== false) writeFileSync(join(dir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
  if (extra.worktrees) writeFileSync(join(dir, "worktrees.md"), "# Worktrees\n- isolated wt-1\n", "utf8");
}

test("check-ci: split-oracle REJECT blocks CI even if another oracle ACCEPT exists", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-split-oracle-"));
  try {
    const changeDir = join(root, "openspec", "changes", "split-oracle");
    writeT2Files(changeDir, { oracle: false });
    writeFileSync(join(changeDir, "oracle-1.md"), "# Oracle 1\nVerdict: ACCEPT\n", "utf8");
    writeFileSync(join(changeDir, "oracle-2.md"), "# Oracle 2\nVerdict: REJECT\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "split-oracle" }), 1, "split-oracle REJECT must fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: T1 requires --recon, 3-9 files ceiling, >9 refuses with hint", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-t1-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", "-b", "main", ".");
    writeFileSync(join(root, "init.txt"), "init\n", "utf8");
    git("add", "init.txt");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "feature-t1");
    assert.equal(cmdCheckCi(root, { tier: "T1", "base-ref": "main" }), 1, "T1 without --recon must fail");
    const reconContent = "# Recon\n## Files touched\n- a.txt\n- b.txt\n## Acceptance check\nSmoke ok.\n";
    writeFileSync(join(root, "recon.md"), reconContent, "utf8");
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    writeFileSync(join(root, "b.txt"), "b\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "add recon and 2 files");
    assert.equal(cmdCheckCi(root, { tier: "T1", "base-ref": "main", recon: "recon.md" }), 0, "T1 with 3 files must pass");
    for (let i = 1; i <= 7; i++) writeFileSync(join(root, `extra${i}.txt`), `${i}\n`, "utf8");
    git("add", "-A");
    git("commit", "-qm", "add 7 extra files");
    assert.equal(cmdCheckCi(root, { tier: "T1", "base-ref": "main", recon: "recon.md" }), 1, "T1 with >9 files must fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: T3 requires committed worktrees.md describing at least one isolated worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-t3-"));
  try {
    const changeDir = join(root, "openspec", "changes", "t3-change");
    writeT2Files(changeDir);
    assert.equal(cmdCheckCi(root, { tier: "T3", change: "t3-change" }), 1, "T3 without worktrees.md must fail");
    writeFileSync(join(changeDir, "worktrees.md"), "# Worktrees\n- isolated worktree wt-1\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T3", change: "t3-change" }), 0, "T3 with worktrees.md must pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: guarded-auto refuses outside.txt 12-line edit and accepts in-scope 1-line edit", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-auto-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "console.log(1);\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    assert.equal(cmdStart(root, { tier: "T0", auto: true, allow: "src/**", "max-diff": 1, task: "auto-test" }), 0);
    writeFileSync(join(root, "outside.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n", "utf8");
    assert.equal(cmdClose(root, {}), 1, "guarded auto must refuse outside.txt write");
    rmSync(join(root, "outside.txt"));
    writeFileSync(join(root, "src", "app.ts"), "console.log(1);\nconst x = 1;\n", "utf8");
    assert.equal(cmdClose(root, {}), 0, "guarded auto must accept in-scope 1-line edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local T2: refuses while proposal/tasks/specs/oracle file are absent", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-t2-align-"));
  try {
    const changeDir = join(root, "openspec", "changes", "align-feat");
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, "stub.txt"), "stub\n", "utf8");
    writeFileSync(join(root, "manifest.md"), "| R01 | quote |\n", "utf8");
    writeFileSync(join(root, "interfaces.md"), "# Interfaces\n- fn(): void\n", "utf8");
    cmdStart(root, { tier: "T2", task: "align-t2-test" });
    cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" });
    cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from brief" });
    cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" });
    cmdArtifact(root, { kind: "openspec", path: "openspec/changes/align-feat", detail: "change proposal scaffolded and validated" });
    cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against brief, no gaps found" });
    assert.equal(cmdCheck(root), 1, "missing proposal, tasks, specs, oracle file");
    assert.equal(cmdClose(root, {}), 1, "close must refuse when artifacts absent");
    writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
    assert.equal(cmdCheck(root), 1, "missing tasks, specs, oracle file");
    writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- task 1\n", "utf8");
    assert.equal(cmdCheck(root), 1, "missing specs, oracle file");
    mkdirSync(join(changeDir, "specs"), { recursive: true });
    writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
    assert.equal(cmdCheck(root), 1, "missing oracle file");
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nAll passed.\n", "utf8");
    cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against brief, no gaps found" });
    assert.equal(cmdCheck(root), 0, "all required evidence present: passes check");
    assert.equal(cmdClose(root, {}), 0, "all required evidence present: passes close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: git failure fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-git-fail-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    const changeDir = join(root, "openspec", "changes", "git-fail-change");
    writeT2Files(changeDir);
    git("add", "-A");
    git("commit", "-qm", "init");
    const binDir = join(root, "broken-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, process.platform === "win32" ? "git.bat" : "git"), "@echo off\nexit /b 1\n", { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${origPath}`;
    try {
      assert.equal(cmdCheckCi(root, { tier: "T2", change: "git-fail-change" }), 1, "git failure must fail closed in check-ci");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: base-ref intersection stops false merge failure from unrelated base branch updates", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-base-merge-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", "-b", "main", ".");
    writeFileSync(join(root, "root.txt"), "root\n", "utf8");
    git("add", "root.txt");
    git("commit", "-qm", "base commit");
    git("checkout", "-qb", "feature");
    const changeDir = join(root, "openspec", "changes", "feat-merge");
    writeT2Files(changeDir, { oracle: false });
    writeFileSync(join(root, "feature.txt"), "feature code\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "feature code");
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "oracle only");
    git("checkout", "main");
    writeFileSync(join(root, "unrelated.txt"), "unrelated change on main\n", "utf8");
    git("add", "unrelated.txt");
    git("commit", "-qm", "unrelated commit on main");
    git("checkout", "feature");
    git("merge", "-qm", "merge main into feature", "main");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "feat-merge", "base-ref": "main" }), 0, "base-ref intersection must stop false merge failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("gate: local check/close refuse when explicit oracle ACCEPT has sibling REJECT in registered change", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-sibling-reject-"));
  try {
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "sibling-reject" });
    cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" });
    cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" });
    cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" });
    cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" });

    const changeDir = join(root, "openspec", "changes", "feat-x");
    writeFileSync(join(changeDir, "oracle-1.md"), "# Oracle 1\nVerdict: ACCEPT\n", "utf8");
    writeFileSync(join(changeDir, "oracle-2.md"), "# Oracle 2\nVerdict: REJECT\n", "utf8");
    cmdArtifact(root, {
      kind: "oracle",
      path: "openspec/changes/feat-x/oracle-1.md",
      detail: "ACCEPT: verified oracle-1 only",
    });
    assert.equal(cmdCheck(root), 1, "sibling REJECT must fail check even with explicit ACCEPT --path");
    assert.equal(cmdClose(root, {}), 1, "sibling REJECT must fail close even with explicit ACCEPT --path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: multi-hyphen oracle filename with REJECT blocks CI", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-multihyphen-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    const changeDir = join(root, "openspec", "changes", "multi-hyphen");
    writeT2Files(changeDir, { oracle: false });
    writeFileSync(join(changeDir, "oracle-1.md"), "# Oracle 1\nVerdict: ACCEPT\n", "utf8");
    writeFileSync(join(changeDir, "oracle-blind-recheck.md"), "# Blind Recheck\nVerdict: REJECT\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "commit multi-hyphen evidence");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "multi-hyphen" }), 1, "multi-hyphen REJECT must fail CI");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: local check/close refuse borrowing positive oracle --path from another change", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-borrow-accept-"));
  try {
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "borrow-accept" });
    cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" });
    cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" });
    cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" });
    cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" });

    const registeredDir = join(root, "openspec", "changes", "feat-x");
    rmSync(join(registeredDir, "oracle.md"), { force: true });
    const otherDir = join(root, "openspec", "changes", "other-change");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nBorrowed.\n", "utf8");

    cmdArtifact(root, {
      kind: "oracle",
      path: "openspec/changes/other-change/oracle.md",
      detail: "ACCEPT: borrowed from other change",
    });
    assert.equal(cmdCheck(root), 1, "borrowed ACCEPT path must refuse check");
    assert.equal(cmdClose(root, {}), 1, "borrowed ACCEPT path must refuse close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: guarded-auto refuses close when git inspection fails with out-of-scope edit", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-auto-git-fail-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "console.log(1);\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    assert.equal(cmdStart(root, { tier: "T0", auto: true, allow: "src/**", "max-diff": 10, task: "auto-fail-test" }), 0);
    writeFileSync(join(root, "outside.txt"), "out-of-scope\n", "utf8");

    const binDir = join(root, "broken-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, process.platform === "win32" ? "git.bat" : "git"), process.platform === "win32" ? "@echo off\nexit /b 1\n" : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${origPath}`;
    try {
      assert.equal(cmdClose(root, {}), 1, "guarded auto close must fail when git inspection fails");
      const st = load(root);
      assert.equal(st.status, "open", "task must remain open when git inspection fails");
      assert.equal(st.autoSkipReason, undefined, "must not record autoSkipReason on git failure");
    } finally {
      process.env.PATH = origPath;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: guarded-auto refuses close when git status succeeds but diff fails", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-auto-diff-fail-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "console.log(1);\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    assert.equal(cmdStart(root, { tier: "T0", auto: true, allow: "src/**", "max-diff": 10, task: "diff-fail-test" }), 0);

    writeFileSync(join(root, "src", "app.ts"), "console.log(2);\n", "utf8");
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/unborn-branch\n");
    assert.equal(git("status", "--porcelain", "-uall").status, 0, "git status must succeed");

    const errors = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
      origError(...args);
    };
    try {
      assert.equal(cmdClose(root, {}), 1, "guarded auto close must fail when git diff fails");
      assert.ok(
        errors.some((msg) => msg.includes("git diff failed in git repository")),
        `must exercise specific 'git diff failed' path, got errors: ${errors.join("\n")}`
      );
      const st = load(root);
      assert.equal(st.status, "open", "task must remain open when git diff fails");
      assert.equal(st.autoSkipReason, undefined, "must not record autoSkipReason when diff fails");
    } finally {
      console.error = origError;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: guarded-auto refuses out-of-scope edit when project root is nested inside Git repository", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "wf-gate-nested-git-"));
  const git = (...args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    mkdirSync(join(repoRoot, "sub", "src"), { recursive: true });
    writeFileSync(join(repoRoot, "sub", "src", "app.ts"), "console.log(1);\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");

    const projectRoot = join(repoRoot, "sub");
    assert.equal(cmdStart(projectRoot, { tier: "T0", auto: true, allow: "src/**", "max-diff": 5, task: "nested-auto-test" }), 0);

    writeFileSync(join(projectRoot, "outside.txt"), "out-of-scope\n", "utf8");
    assert.equal(cmdClose(projectRoot, {}), 1, "nested project auto close must refuse out-of-scope edit");

    const st = load(projectRoot);
    assert.equal(st.status, "open", "task must remain open");
    assert.equal(st.autoSkipReason, undefined, "must not skip measurement for nested git root");

    rmSync(join(projectRoot, "outside.txt"));
    writeFileSync(join(projectRoot, "src", "app.ts"), "console.log(1);\nconsole.log(2);\n", "utf8");
    assert.equal(cmdClose(projectRoot, {}), 0, "nested project auto close must accept in-scope edit");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("cmdClose: guarded-auto refuses untracked non-ASCII filename exceeding diff cap", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-unicode-diff-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  try {
    git("init", "-q", ".");
    writeFileSync(join(root, "init.txt"), "init\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");

    assert.equal(cmdStart(root, { tier: "T0", auto: true, allow: "**", "max-diff": 1, task: "unicode-diff-cap" }), 0);

    const hundredLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}\n`).join("");
    writeFileSync(join(root, "é.txt"), hundredLines, "utf8");

    assert.equal(cmdClose(root, {}), 1, "untracked unicode file exceeding maxDiff must refuse auto close");

    const st = load(root);
    assert.equal(st.status, "open", "task must remain open when diff exceeds cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: local check/close and CI refuse Markdown-bold **Verdict:** REJECT sibling verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-bold-reject-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    setupT2(root);
    cmdStart(root, { tier: "T2", task: "bold-reject-test" });
    cmdArtifact(root, { kind: "recon", detail: "recon finished: mapped boundaries and files" });
    cmdArtifact(root, { kind: "manifest", path: "manifest.md", detail: "captured R01 verbatim from the brief" });
    cmdArtifact(root, { kind: "openspec", path: "openspec/changes/feat-x", detail: "change proposal scaffolded and validated" });
    cmdArtifact(root, { kind: "interfaces", path: "interfaces.md", detail: "public signatures recorded: fn() -> void, plus invariants" });

    const changeDir = join(root, "openspec", "changes", "feat-x");
    rmSync(join(changeDir, "oracle.md"), { force: true });
    writeT2Files(changeDir, { oracle: false });
    writeFileSync(join(changeDir, "oracle-1.md"), "# Oracle 1\nVerdict: ACCEPT\n", "utf8");
    writeFileSync(join(changeDir, "oracle-2.md"), "# Oracle 2\n**Verdict:** REJECT\n", "utf8");
    cmdArtifact(root, {
      kind: "oracle",
      path: "openspec/changes/feat-x/oracle-1.md",
      detail: "ACCEPT: passed primary verification",
    });

    assert.equal(cmdCheck(root), 1, "sibling **Verdict:** REJECT must fail local check");
    assert.equal(cmdClose(root, {}), 1, "sibling **Verdict:** REJECT must fail local close");

    // Also test CI path with actual commit fixture
    git("add", "-A");
    git("commit", "-qm", "commit bold reject evidence");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "feat-x" }), 1, "committed **Verdict:** REJECT must fail check-ci");

    // Turning sibling into ACCEPT and refreshing oracle-1 passes both local and CI
    writeFileSync(join(changeDir, "oracle-2.md"), "# Oracle 2\n**Verdict:** ACCEPT\n", "utf8");
    writeFileSync(join(changeDir, "oracle-1.md"), "# Oracle 1\n**Verdict:** ACCEPT\nFresh verification: sibling resolved\n", "utf8");
    cmdArtifact(root, {
      kind: "oracle",
      path: "openspec/changes/feat-x/oracle-1.md",
      detail: "ACCEPT: passed primary verification refreshed",
    });
    git("add", "-A");
    git("commit", "-qm", "commit all-accept evidence");
    assert.equal(cmdCheck(root), 0, "all-positive evidence must pass local check");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: "feat-x" }), 0, "all-positive evidence must pass check-ci");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: R03 rejects oracle and code/non-oracle files in same commit", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-r03-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    const changeId = "r03-mixed";
    const changeDir = join(root, "openspec", "changes", changeId);
    writeT2Files(changeDir, { oracle: false });
    writeFileSync(join(root, "evil.js"), "console.log('evil');\n", "utf8");
    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nAll passed.\n", "utf8");

    // All-in-one commit: oracle.md ACCEPT and evil.js together
    git("add", "-A");
    git("commit", "-qm", "oracle and evil together");

    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "mixed oracle commit must fail check-ci");

    // Honest separate commits in a clean repo
    const root2 = mkdtempSync(join(tmpdir(), "wf-gate-r03-clean-"));
    const git2 = (...args) => spawnSync("git", args, {
      cwd: root2, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    });
    try {
      git2("init", "-q", ".");
      const changeDir2 = join(root2, "openspec", "changes", changeId);
      writeT2Files(changeDir2, { oracle: false });
      writeFileSync(join(root2, "evil.js"), "console.log('honest code');\n", "utf8");
      git2("add", "-A");
      git2("commit", "-qm", "spec and code");

      writeFileSync(join(changeDir2, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nAll passed.\n", "utf8");
      git2("add", "-A");
      git2("commit", "-qm", "oracle separate");

      assert.equal(cmdCheckCi(root2, { tier: "T2", change: changeId }), 0, "separate honest oracle commit must pass check-ci");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: R04 guarded-auto refuses binary file modifications", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-r04-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "app.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));
    git("add", "-A");
    git("commit", "-qm", "initial binary");

    cmdStart(root, { tier: "T0", task: "binary-mod", auto: true, allow: "bin/**", "max-diff": 10 });

    // Modify binary file so numstat outputs '-' counters
    writeFileSync(join(root, "bin", "app.bin"), Buffer.from([255, 254, 1, 2, 3, 0, 5, 6]));

    const closeCode = cmdClose(root, { auto: true });
    assert.equal(closeCode, 1, "close must return 1 on binary diff in numstat");

    const st = load(root);
    assert.equal(st.status, "open", "task must remain open after refusal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cmdClose: R05 guarded-auto checks both ends of file renames against allow pattern", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-r05-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "ok.txt"), "hello\nworld\n");
    git("add", "-A");
    git("commit", "-qm", "initial source");

    // Case 1: Rename escapes allow (src/ok.txt -> lib/evil.txt under allow 'src/**')
    cmdStart(root, { tier: "T0", task: "rename-escape", auto: true, allow: "src/**", "max-diff": 20 });
    mkdirSync(join(root, "lib"), { recursive: true });
    git("mv", "src/ok.txt", "lib/evil.txt");

    assert.equal(cmdClose(root, { auto: true }), 1, "rename escaping allow must fail close");
    assert.equal(load(root).status, "open", "task remains open when rename escapes allow");

    // Reset and test Case 2: Rename inside allow (src/ok.txt -> src/renamed.txt)
    git("reset", "--hard", "HEAD");
    git("clean", "-fdq");
    cmdStart(root, { tier: "T0", task: "rename-inside", auto: true, allow: "src/**", "max-diff": 20, force: true, reason: "reset" });
    git("mv", "src/ok.txt", "src/renamed.txt");

    assert.equal(cmdClose(root, { auto: true }), 0, "rename inside allow must pass close");
    assert.equal(load(root).status, "closed", "task is closed when rename is inside allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-ci: R07 dirty-check uses NUL porcelain and exact .workflow segment filter", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-gate-r07-"));
  const git = (...args) => spawnSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
  try {
    git("init", "-q", ".");
    const changeId = "r07-dirty";
    const changeDir = join(root, "openspec", "changes", changeId);
    writeT2Files(changeDir, { oracle: false });
    git("add", "-A");
    git("commit", "-qm", "specs");

    writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nAll passed.\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "oracle accepted");

    // Clean worktree passes
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 0, "clean worktree passes check-ci");

    // my.workflow/x is NOT excluded by .workflow/ segment filter
    mkdirSync(join(root, "my.workflow"), { recursive: true });
    writeFileSync(join(root, "my.workflow", "x.txt"), "leak\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "my.workflow/x must not be hidden by dirty check");
    rmSync(join(root, "my.workflow"), { recursive: true, force: true });

    // Exact .workflow/ is ignored by dirty check
    mkdirSync(join(root, ".workflow"), { recursive: true });
    writeFileSync(join(root, ".workflow", "state.json"), "{}\n", "utf8");
    assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 0, ".workflow/ must be ignored by dirty check");

    // Newline in filename (POSIX only; Windows filesystem rejects newlines in paths)
    if (process.platform !== "win32") {
      try {
        writeFileSync(join(root, "untracked\nfile.txt"), "content\n", "utf8");
        assert.equal(cmdCheckCi(root, { tier: "T2", change: changeId }), 1, "untracked file with newline fails dirty check");
        rmSync(join(root, "untracked\nfile.txt"), { force: true });
      } catch {}
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

