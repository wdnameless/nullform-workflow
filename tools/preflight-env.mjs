#!/usr/bin/env node
/**
 * tools/preflight-env.mjs — fail fast when the environment would poison the suite.
 *
 * Exists because of a measured incident: `D:/TMP` contained an empty `.git` repository
 * (zero commits, created by some unrelated tool). Every test that assumes `os.tmpdir()`
 * is outside version control then saw a "git repository with no HEAD":
 * `review-budget` went 30/30 -> 10/30, `workflow-suggest` lost its non-git branch, and
 * `git diff HEAD` failed inside fixtures. The failures point at code that is fine.
 *
 * This is a preflight, not a fix: it names the real cause instead of letting a machine
 * quirk masquerade as 51 test failures. Point TMPDIR/TEMP/TMP at a directory outside
 * version control, or remove the stray `.git`.
 *
 * Exit: 0 fine · 1 the temp dir is inside a repository · 2 cannot determine.
 *
 * CLI: node tools/preflight-env.mjs [--json]
 */

import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** Walk up from `dir` looking for a `.git` entry; return the repository root or null. */
export function repoRootAbove(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** True when the repository at `root` has no commits, so `git diff HEAD` cannot work. */
export function hasNoCommits(root) {
  const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  return res.status !== 0;
}

/** The environment verdict. `ok` is false when a repository would swallow the temp dir. */
export function checkEnvironment(temp = tmpdir()) {
  const root = repoRootAbove(temp);
  if (!root) return { ok: true, temp, repoRoot: null };
  // A repository with commits is still a problem for fixtures that expect "not a repo",
  // but an empty one is worse: it breaks `git diff HEAD` as well.
  return {
    ok: false,
    temp,
    repoRoot: root,
    empty: hasNoCommits(root),
    advice: `os.tmpdir() (${temp}) is inside a git repository (${root}). Tests that expect a non-git temp dir or diff against HEAD will fail for reasons unrelated to the code. Set TMPDIR/TEMP/TMP to a directory outside version control.`,
  };
}

export function formatVerdict(v) {
  if (v.ok) return `preflight: temp dir is outside version control (${v.temp}).`;
  return `preflight: FAIL — ${v.advice}\n${v.empty ? "  that repository has no commits, so `git diff HEAD` cannot run either." : ""}`;
}

if (process.argv[1] && process.argv[1].endsWith("preflight-env.mjs")) {
  const asJson = process.argv.includes("--json");
  const verdict = checkEnvironment();
  if (asJson) process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
  else process.stdout.write(formatVerdict(verdict) + "\n");
  process.exitCode = verdict.ok ? 0 : 1;
}
