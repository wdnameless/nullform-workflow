/**
 * tools/tests/workflow-staleness.test.mjs
 * Acceptance-staleness gate: an ACCEPT verdict is evidence only for the tree it
 * was rendered against. Editing a tracked file after the oracle ran and then
 * closing must be refused, and any --force override must stay recorded.
 *
 * The bug this pins: `close` compared nothing against the oracle timestamp, so a
 * post-acceptance edit closed for free — and a forced override wrote
 * `forced: false` with no deviation record, leaving no trace at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmdStart, cmdArtifact, cmdClose, load } from "../workflow.mjs";

const CLI = fileURLToPath(new URL("../workflow.mjs", import.meta.url));

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

/** A git-backed temp project with one tracked file, so staleness is measurable. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "wf-stale-"));
  git(root, ["init", "-q", "."]);
  writeFileSync(join(root, "tracked.txt"), "x\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

/** Record every artifact a T2 lane needs, asserting each one actually recorded.
 * The gate enforces per-kind detail floors (interfaces >= 40 chars), so a silent
 * failure here would leave close() blocked for the wrong reason and mask a real
 * staleness regression. */
function completeT2(root) {
  mkdirSync(join(root, "openspec", "changes", "p"), { recursive: true });
  writeFileSync(join(root, "m.md"), "| R01 | \"user asked for X\" |\n", "utf8");
  writeFileSync(join(root, "i.md"), "# iface\n- fn(): void\n", "utf8");
  writeFileSync(join(root, "openspec", "changes", "p", "proposal.md"), "proposal\n", "utf8");

  const steps = [
    ["recon", null, "recon done: mapped the tree and the acceptance criteria"],
    ["manifest", "m.md", "captured R01 verbatim from the brief"],
    ["openspec", "openspec/changes/p", "change scaffolded and validated"],
    ["interfaces", "i.md", "public signatures recorded: fn() -> void, plus invariants"],
  ];
  for (const [kind, path, detail] of steps) {
    assert.equal(cmdArtifact(root, { kind, path, detail }), 0, `${kind} must record`);
  }
}

/** Synchronous sleep: makes the verdict/edit ordering deterministic. Filesystems
 * report mtime at ~1s granularity on some platforms, so 20ms is not enough to
 * order an edit against a re-recorded verdict. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function touchTracked(root) {
  // A real edit, clearly after the verdict: a future timestamp would keep the file
  // "newer" than a re-recorded oracle and break the honest path.
  sleepMs(1100);
  writeFileSync(join(root, "tracked.txt"), `x\n# fix ${Date.now()}\n`, "utf8");
}

test("staleness: a tracked file edited after the oracle verdict blocks close", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    touchTracked(root);

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse a stale acceptance");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: re-recording the oracle on the current tree allows an honest close", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    touchTracked(root);
    // Re-verify AFTER the edit: this is the honest path the gate pushes toward.
    sleepMs(1100);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: re-verified against the current tree" }), 0);

    const code = cmdClose(root, {});
    assert.equal(code, 0, "a fresh verdict must close cleanly");
    const st = load(root);
    assert.equal(st.status, "closed");
    assert.equal(st.deviation, undefined, "an honest close records no deviation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: --force without --reason is refused", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    touchTracked(root);

    const code = cmdClose(root, { force: true });
    assert.equal(code, 1, "--force must still explain itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: a forced override is RECORDED in state and metrics", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    touchTracked(root);

    const code = cmdClose(root, { force: true, reason: "hotfix after acceptance; re-verification scheduled" });
    assert.equal(code, 0, "the escape hatch must work when it states a reason");

    const st = load(root);
    assert.ok(st.deviation, "the override must leave a deviation record");
    assert.equal(st.deviation.forced, true);
    assert.match(st.deviation.staleAcceptance, /changed after the oracle verdict/);

    const metrics = readFileSync(join(root, ".workflow", "metrics.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(metrics[metrics.length - 1]);
    assert.equal(last.forced, true, "metrics must not report an overridden close as unforced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: a lane without an oracle artifact is unaffected (T0/T1 stay cheap)", () => {
  const root = project();
  try {
    assert.equal(cmdStart(root, { tier: "T0", task: "typo" }), 0);
    const code = cmdClose(root, {});
    assert.equal(code, 0, "T0 has no acceptance to go stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
