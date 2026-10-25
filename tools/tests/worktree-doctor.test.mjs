import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { parseWorktreeList, auditWorktrees, pruneWorktrees } from "../worktree-doctor.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

/** A repo with one commit on `main`, plus `count` worktrees branching from it. */
function repoFixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), "wt-doctor-"));
  git(root, "init", "-q", "-b", "main", ".");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const paths = [];
  for (let i = 0; i < count; i++) {
    const p = join(root, ".tmp", `wt${i}`);
    mkdirSync(join(root, ".tmp"), { recursive: true });
    git(root, "worktree", "add", "-q", "-b", `feat/wt${i}`, p);
    paths.push(p);
  }
  return { root, paths };
}

test("parseWorktreeList captures branch, detached and main", () => {
  const text = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/wt",
    "HEAD def",
    "detached",
    "",
  ].join("\n");
  const entries = parseWorktreeList(text, "/repo");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].branch, "main");
  assert.equal(entries[0].main, true);
  assert.equal(entries[1].detached, true);
  assert.equal(entries[1].main, false);
});

test("a clean worktree whose branch is merged is prunable; a dirty one is not", () => {
  const { root, paths } = repoFixture(2);
  try {
    // Merge wt0's branch so wt0 becomes prunable; leave wt1 with local work.
    git(root, "merge", "-q", "--no-ff", "-m", "m", "feat/wt0");
    writeFileSync(join(paths[1], "local.txt"), "uncommitted\n");

    const audit = auditWorktrees(root, { base: "main" });
    assert.equal(audit.ok, true);
    // Git reports canonical paths, so compare by suffix rather than by an exact string the
    // fixture guessed; the point under test is the prunable decision, not path spelling.
    const find = (p) => audit.entries.find((e) => e.path.replace(/\\/g, "/").endsWith(p.split(/[\\/]/).slice(-1)[0]));
    const clean = find(paths[0]);
    const dirty = find(paths[1]);
    assert.ok(clean && dirty, `both worktrees must be reported (got ${audit.entries.map((e) => e.path).join(", ")})`);
    assert.equal(clean.prunable, true, "merged + clean must be prunable");
    assert.equal(dirty.prunable, false, "uncommitted work must never be prunable");
    assert.ok(dirty.dirty > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the main worktree is never prunable even when clean and merged", () => {
  const { root } = repoFixture(1);
  try {
    const audit = auditWorktrees(root, { base: "main" });
    const main = audit.entries.find((e) => e.main);
    assert.equal(main.prunable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune removes only the prunable set and reports refusals", () => {
  const { root, paths } = repoFixture(2);
  try {
    git(root, "merge", "-q", "--no-ff", "-m", "m", "feat/wt0");
    writeFileSync(join(paths[1], "keep.txt"), "work\n");

    const result = pruneWorktrees(root, { base: "main" });
    const removed = result.removed.map((r) => r.path.replace(/\\/g, "/"));
    assert.ok(removed.some((p) => p.endsWith("wt0")), "the clean merged worktree is removed");
    assert.ok(!removed.some((p) => p.endsWith("wt1")), "the dirty worktree survives");

    const after = auditWorktrees(root, { base: "main" });
    assert.equal(after.entries.some((e) => e.path.replace(/\\/g, "/").endsWith("wt1")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run reports without removing", () => {
  const { root } = repoFixture(1);
  try {
    git(root, "merge", "-q", "--no-ff", "-m", "m", "feat/wt0");
    const planned = pruneWorktrees(root, { base: "main", dryRun: true });
    assert.equal(planned.removed.length, 1);
    const after = auditWorktrees(root, { base: "main" });
    assert.equal(after.entries.length, 2, "nothing was actually removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
