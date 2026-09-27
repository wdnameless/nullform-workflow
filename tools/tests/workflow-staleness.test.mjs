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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmdStart, cmdArtifact, cmdClose, load } from "../workflow.mjs";

const _CLI = fileURLToPath(new URL("../workflow.mjs", import.meta.url));

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
  const pDir = join(root, "openspec", "changes", "p");
  mkdirSync(join(pDir, "specs"), { recursive: true });
  writeFileSync(join(root, "m.md"), "| R01 | \"user asked for X\" |\n", "utf8");
  writeFileSync(join(root, "i.md"), "# iface\n- fn(): void\n", "utf8");
  writeFileSync(join(pDir, "proposal.md"), "proposal\n", "utf8");
  writeFileSync(join(pDir, "tasks.md"), "# Tasks\n- task 1\n", "utf8");
  writeFileSync(join(pDir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(pDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
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
test("staleness: an untracked source file added after the oracle verdict blocks close", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe-untracked" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    sleepMs(1100);
    writeFileSync(join(root, "untracked.ts"), "export const a = 1;\n", "utf8");

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse when an untracked file is added after oracle");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: deleting a tracked file after the oracle verdict blocks close", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe-deleted" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    sleepMs(1100);
    rmSync(join(root, "tracked.txt"));

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse when a tracked file is deleted after oracle");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: non-git directory does not silently treat modified evidence as fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-nongit-"));
  try {
    writeFileSync(join(root, "code.txt"), "hello world\n", "utf8");
    cmdStart(root, { tier: "T2", task: "probe-nongit" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);
    sleepMs(1100);
    writeFileSync(join(root, "code.txt"), "hello modified\n", "utf8");

    const code = cmdClose(root, {});
    assert.equal(code, 1, "non-git close must refuse modified evidence after oracle");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("staleness: content modified with restored mtime still blocks close via content hash", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe-hash" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    const filePath = join(root, "tracked.txt");
    const prevStat = statSync(filePath);

    // Modify content with exact same byte length
    writeFileSync(filePath, "y\n", "utf8");
    // Restore original atime and mtime
    utimesSync(filePath, prevStat.atime, prevStat.mtime);

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse edit even with identical mtime and size");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("staleness: newly tracked file added with backdated mtime blocks close", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe-backdated-tracked" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Add and stage a new tracked file with backdated mtime
    const newFile = join(root, "added.txt");
    writeFileSync(newFile, "added\n", "utf8");
    const past = new Date(Date.now() - 3600000);
    utimesSync(newFile, past, past);
    git(root, ["add", "added.txt"]);

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse newly tracked file even if backdated");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: deleting an untracked file present at snapshot blocks close", () => {
  const root = project();
  try {
    const untrackedFile = join(root, "scratch.txt");
    writeFileSync(untrackedFile, "temp\n", "utf8");

    cmdStart(root, { tier: "T2", task: "probe-deleted-untracked" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Delete the untracked file that was present during oracle snapshot
    rmSync(untrackedFile);

    const code = cmdClose(root, {});
    assert.equal(code, 1, "close must refuse when untracked file from snapshot is deleted");
    const st = load(root);
    assert.equal(st.status, "open", "the task must stay open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: credential and secret files are excluded from scanWorktree snapshot", () => {
  const root = project();
  try {
    mkdirSync(join(root, "agent"), { recursive: true });
    // Write synthetic credential fixtures (NOT real secrets)
    writeFileSync(join(root, "agent", "models.yml"), "synthetic: token\n", "utf8");
    writeFileSync(join(root, ".env.local"), "SYNTHETIC_KEY=fake\n", "utf8");
    writeFileSync(join(root, "secrets.json"), "{\"synthetic\": true}\n", "utf8");

    cmdStart(root, { tier: "T2", task: "probe-credentials-skipped" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    const st = load(root);
    const snap = st.artifacts?.oracle?.snapshot;
    assert.ok(snap, "snapshot must exist");

    // Assert synthetic credential files are NOT included in snapshot
    const allSnapshotKeys = [
      ...Object.keys(snap.tracked || {}),
      ...Object.keys(snap.untracked || {}),
      ...Object.keys(snap.files || {}),
    ];
    for (const key of allSnapshotKeys) {
      assert.doesNotMatch(key, /models\.ya?ml|mcp\.json|\.env|secrets/i, "credential path must not be snapshotted");
    }

    // Modifying synthetic credential files must not cause acceptance staleness
    writeFileSync(join(root, "agent", "models.yml"), "synthetic: modified_fake\n", "utf8");
    writeFileSync(join(root, ".env.local"), "SYNTHETIC_KEY=modified_fake\n", "utf8");

    const code = cmdClose(root, {});
    assert.equal(code, 0, "modifying credential files must not trigger staleness");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: generated worktrees and caches do not invalidate acceptance in a non-git project", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-generated-"));
  try {
    writeFileSync(join(root, "code.txt"), "source\n", "utf8");
    cmdStart(root, { tier: "T2", task: "probe-generated" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified source before generated files appeared" }), 0);

    for (const dir of [".tmp/worktrees", ".archmap", ".codemap", ".opencode", "cache", "logs"]) {
      const target = join(root, dir);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "generated.txt"), "generated output\n", "utf8");
    }
    assert.equal(cmdClose(root, {}), 0, "generated files must not make accepted source stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: touching a tracked file with identical content does not invalidate acceptance", () => {
  const root = project();
  try {
    cmdStart(root, { tier: "T2", task: "probe-identical-touch" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Touch with identical content (timestamp advances, content hash unchanged)
    sleepMs(1100);
    writeFileSync(join(root, "tracked.txt"), "x\n", "utf8");
    utimesSync(join(root, "tracked.txt"), new Date(), new Date());

    const code = cmdClose(root, {});
    assert.equal(code, 0, "touching with identical content hash must not invalidate acceptance");

    const st = load(root);
    assert.equal(st.status, "closed");
    assert.equal(st.deviation, undefined, "honest close with unchanged content produces no deviation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: out-of-root symlinks are excluded from worktree snapshot without hashing", () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "wf-outside-secret-"));
  try {
    const secretFile = join(outside, "secret.key");
    writeFileSync(secretFile, "SUPER_SECRET_KEY\n", "utf8");

    try {
      symlinkSync(secretFile, join(root, "symlink-secret.txt"));
      git(root, ["add", "-A"]);
      git(root, ["commit", "-qm", "add symlink"]);

      cmdStart(root, { tier: "T2", task: "probe-symlink" });
      completeT2(root);
      assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief" }), 0);

      const st = load(root);
      const snapshot = st.artifacts?.oracle?.snapshot;
      // Symlink pointing outside must NOT be indexed in tracked snapshot
      assert.equal(snapshot?.tracked?.["symlink-secret.txt"], undefined);
    } catch (err) {
      if (err.code !== "EPERM") throw err;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("staleness: tracked credentials file edited after oracle verdict blocks close", () => {
  const root = project();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const credPath = join(root, "src", "credentials.ts");
    writeFileSync(credPath, "export const apiKey = 'initial';\n", "utf8");
    git(root, ["add", "src/credentials.ts"]);
    git(root, ["commit", "-qm", "add credentials.ts"]);

    cmdStart(root, { tier: "T2", task: "probe-credentials-staleness" });
    completeT2(root);
    assert.equal(cmdArtifact(root, { kind: "oracle", detail: "ACCEPT: verified against the brief, no gaps found" }), 0);

    // Edit the tracked credentials file
    sleepMs(1100);
    writeFileSync(credPath, "export const apiKey = 'modified_after_oracle';\n", "utf8");

    const code = cmdClose(root, {});
    assert.equal(code, 1, "editing tracked credentials file must block close with staleness");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
