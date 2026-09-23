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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdStart,
  cmdArtifact,
  cmdCheck,
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
