#!/usr/bin/env node
/**
 * tools/worktree-doctor.mjs — audit and prune Git worktrees this project accumulated.
 *
 * Why: measured on this repository, `git worktree list` held 23 entries, 21 of them dirty,
 * 185 uncommitted files, 566 MB — and no tool reported any of it. Worktrees also block
 * branch deletion: `git branch -d` refuses while a worktree has the branch checked out, so
 * a merged branch stays alive until its directory is removed, and nothing said so.
 *
 * A worktree is PRUNABLE when its branch is merged into the base ref and it has no
 * uncommitted work and no untracked files. Everything else is reported and left alone:
 * deleting a directory that holds someone's uncommitted work is data loss, not cleanup.
 *
 * CLI:
 *   node tools/worktree-doctor.mjs [--root <dir>] [--base <ref>] [--json]
 *   node tools/worktree-doctor.mjs --prune [--root <dir>] [--base <ref>] [--dry-run]
 *
 * Exit: 0 nothing needs attention · 1 stale worktrees found · 2 cannot run
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE = "origin/master";

/** Case- and symlink-insensitive path equality, for comparing our root to Git's output. */
export function sameLocation(a, b) {
  const canon = (p) => {
    try { return realpathSync.native ? realpathSync.native(p) : realpathSync(p); } catch { return resolve(p); }
  };
  const x = canon(a), y = canon(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreeList(text, mainRoot = null) {
  const entries = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) || null;
    if (!path) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) || null;
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7) || null;
    entries.push({
      path,
      head,
      branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
      detached: lines.some((l) => l.trim() === "detached"),
      // Git reports the path it resolved, which on Windows differs in case and on macOS in
      // /private prefix. Compare canonical paths, both sides through realpath when possible.
      main: mainRoot ? sameLocation(path, mainRoot) : false,
      locked: lines.some((l) => l.startsWith("locked")),
      prunable: lines.some((l) => l.startsWith("prunable")),
    });
  }
  return entries;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 20000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** How many entries `git status --porcelain` reports, without following links. */
export function dirtyEntryCount(path) {
  try {
    if (!existsSync(path)) return null;
    return git(["status", "--porcelain"], path).split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
}

/** True when `branch` is an ancestor of `base` (already merged, safe to drop). */
export function isMerged(branch, base, cwd) {
  if (!branch) return false;
  try {
    git(["merge-base", "--is-ancestor", branch, base], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Age of the entry in whole days, from the directory mtime; null when unavailable. */
export function ageDays(path) {
  try { return Math.floor((Date.now() - statSync(path).mtimeMs) / 86_400_000); } catch { return null; }
}

/**
 * Audit every worktree of the repository rooted at `root`.
 *
 * `main` entries are never prunable; neither is anything with local work. A missing
 * directory is reported as `missing` — Git already considers it prunable, but the branch
 * it holds stays blocked until the record is cleared.
 */
export function auditWorktrees(root = ".", { base = DEFAULT_BASE } = {}) {
  const repo = resolve(root);
  let text;
  try {
    text = git(["worktree", "list", "--porcelain"], repo);
  } catch (error) {
    return { ok: false, error: error.message || String(error), entries: [] };
  }
  const entries = parseWorktreeList(text, repo).map((entry) => {
    const exists = existsSync(entry.path);
    const dirty = exists ? dirtyEntryCount(entry.path) : null;
    const merged = exists ? isMerged(entry.branch, base, repo) : false;
    return {
      ...entry,
      exists,
      dirty,
      merged,
      ageDays: ageDays(entry.path),
      // A directory that is gone is always removable; an existing one only when it holds
      // no local work and its branch is already in the base.
      prunable: entry.main ? false : (!exists || (dirty === 0 && merged && !entry.locked)),
    };
  });
  return { ok: true, base, entries, stale: entries.filter((e) => e.prunable), total: entries.length };
}

/** One worktree's status line: identity, dirt, merge state, age, and removability. */
function describeEntry(e) {
  return [
    e.main ? "main" : e.detached ? "detached" : `branch=${e.branch}`,
    e.exists ? `${e.dirty} dirty` : "MISSING DIR",
    e.merged ? "merged" : null,
    e.ageDays !== null ? `${e.ageDays}d` : null,
    e.prunable ? "PRUNABLE" : null,
    e.locked ? "locked" : null,
  ].filter(Boolean).join(" · ");
}

function formatAudit(result) {
  if (!result.ok) return `worktree-doctor: cannot read worktrees — ${result.error}\n`;
  const lines = [`worktrees: ${result.total} (base ${result.base})`];
  for (const e of result.entries) {
    lines.push(`  ${e.path}\n      ${describeEntry(e)}`);
  }
  const stale = result.stale.length;
  lines.push(stale
    ? `\n${stale} prunable — run: node tools/worktree-doctor.mjs --prune`
    : "\nnothing to prune.");
  return lines.join("\n") + "\n";
}

/** Remove prunable worktrees. Returns what was removed and what refused. */
export function pruneWorktrees(root, { base = DEFAULT_BASE, dryRun = false, audit = null } = {}) {
  const result = audit || auditWorktrees(root, { base });
  if (!result.ok) return result;
  const repo = resolve(root);
  const removed = [];
  const refused = [];
  for (const e of result.stale) {
    if (dryRun) { removed.push({ path: e.path, dryRun: true }); continue; }
    try {
      git(["worktree", "remove", "--force", e.path], repo);
      removed.push({ path: e.path });
    } catch (error) {
      refused.push({ path: e.path, reason: String(error.message || error).split(/\r?\n/)[0] });
    }
  }
  if (!dryRun) {
    try { git(["worktree", "prune"], repo); } catch { /* records without directories */ }
  }
  return { ...result, removed, refused };
}

export function parseArgs(argv) {
  const args = { _: [], root: ".", base: DEFAULT_BASE, json: false, prune: false, dryRun: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--json") args.json = true;
    else if (a === "--prune") args.prune = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = argv[++i] || ".";
    else if (a === "--base") args.base = argv[++i] || DEFAULT_BASE;
    else if (a.startsWith("-")) args.errors.push(`unknown flag ${a}`);
    else args._.push(a);
  }
  return args;
}

const HELP = `worktree-doctor.mjs — audit and prune Git worktrees

  node tools/worktree-doctor.mjs [--root <dir>] [--base <ref>] [--json]
  node tools/worktree-doctor.mjs --prune [--dry-run] [--root <dir>] [--base <ref>]

A worktree is prunable when its branch is merged into <ref> and it has no uncommitted
work. Anything holding local changes is reported and left alone.

Exit: 0 nothing to prune · 1 stale worktrees · 2 cannot run
`;

/** Render an audit or prune outcome for the terminal (or JSON when asked). */
function formatResult(result, args) {
  if (args.json) return JSON.stringify(result, null, 2) + "\n";
  if (!args.prune) return formatAudit(result);
  const lines = [
    ...result.removed.map((r) => `removed ${r.path}${r.dryRun ? " (dry-run)" : ""}`),
    ...result.refused.map((r) => `refused ${r.path} — ${r.reason}`),
  ];
  return (lines.length ? lines.join("\n") : "nothing to prune.") + "\n";
}

export function runWorktreeDoctor(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const args = parseArgs(argv);
  if (args.help) { out.write(HELP); return 0; }
  if (args.errors.length) { for (const e of args.errors) err.write(`worktree-doctor: ${e}\n`); return 2; }
  const root = resolve(args.root);
  if (!existsSync(root)) { err.write(`worktree-doctor: root not found: ${root}\n`); return 2; }

  const result = args.prune
    ? pruneWorktrees(root, { base: args.base, dryRun: args.dryRun })
    : auditWorktrees(root, { base: args.base });

  if (!result.ok) { err.write(`worktree-doctor: ${result.error}\n`); return 2; }

  out.write(formatResult(result, args));
  return args.prune ? 0 : result.stale.length > 0 ? 1 : 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = runWorktreeDoctor();
}
