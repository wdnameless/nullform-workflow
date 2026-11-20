// Settle lifecycle: resolve a change's worktrees and branches, then remove them.
//
// Split out of `workflow-ci.mjs` (issue #16): the CI gate module had grown past the
// 1200-line acceptance of the monolith split while this block — git-ref guards plus the
// resolve/remove settle surface — never touches anything else in that file. It depends
// only on node builtins, `worktree-snapshot.mjs` (path containment) and
// `workflow-shared.mjs` (git presence). `workflow-ci.mjs` re-exports every public name,
// so existing importers keep working unchanged.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { isPathInsideRoot, isRealPathInsideRoot } from "../worktree-snapshot.mjs";
import { isInsideGitRepo } from "../workflow-shared.mjs";

export const PROTECTED_BRANCH_RE = /^(?:master|main|head)$|(?:\/|-)(?:master|main|head)$/i;

export function isProtectedRefName(name) {
  if (!name || typeof name !== "string") return false;
  return PROTECTED_BRANCH_RE.test(name.trim());
}

export function getCurrentBranch(root) {
  if (!isInsideGitRepo(root)) return null;
  try {
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export function isRefMatchingCurrentBranch(refOrChange, currentBranch) {
  if (!refOrChange || !currentBranch) return false;
  const c = refOrChange.trim();
  const b = currentBranch.trim();
  if (c === b) return true;
  const strip = (s) => s.replace(/^(?:feat|fix|feature)[/-]/i, "");
  return strip(c) === strip(b);
}

export function getLocalBranches(root) {
  if (!isInsideGitRepo(root)) return new Set();
  try {
    const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function confirmSettle(flags) {
  let positional = null;
  if (Array.isArray(flags._)) {
    const nonCmd = flags._.filter((a) => a !== "settle");
    if (nonCmd.length > 0) positional = nonCmd[0];
  }
  const change = flags.change || flags.name || positional;
  if (!change || typeof change !== "string" || !change.trim()) {
    console.error("workflow settle: --change <name> is required.");
    return null;
  }
  const trimmed = change.trim();
  if (isProtectedRefName(trimmed)) {
    console.error(`workflow settle: refusing to settle protected ref '${trimmed}'.`);
    return null;
  }
  if (!flags.yes) {
    console.error(`workflow settle: confirmation required (--yes) to remove worktree and branch for change '${trimmed}'.`);
    return null;
  }
  return trimmed;
}

export function resolveSettleDocTargets(root, change, worktreePaths, branches) {
  const doc = join(root, "openspec", "changes", change, "worktrees.md");
  if (!existsSync(doc)) return;
  try {
    for (const line of readFileSync(doc, "utf8").split("\n")) {
      const match = line.match(/\.tmp\/worktrees\/[^\s|`]+/);
      if (match) {
        const p = resolve(root, match[0]);
        if (existsSync(p) && isPathInsideRoot(root, p) && isRealPathInsideRoot(root, p) && resolve(p) !== resolve(root)) {
          worktreePaths.add(p);
        }
      }
      const branchMatch = line.match(/(?:feat|fix|feature)\/[a-z0-9_-]+/i);
      if (branchMatch && !isProtectedRefName(branchMatch[0])) {
        branches.add(branchMatch[0]);
      }
    }
  } catch {}
}

export function resolveSettleGitTargets(root, change, worktreePaths, branches) {
  if (!isInsideGitRepo(root)) return;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    const state = { currentPath: null };
    for (const line of out.split("\n")) {
      parseWorktreeLine(line, root, change, worktreePaths, branches, state);
    }
  } catch {}
}

function parseWorktreeLine(line, root, change, worktreePaths, branches, state) {
  if (line.startsWith("worktree ")) {
    state.currentPath = line.slice("worktree ".length).trim();
    const resolvedPath = resolve(root, state.currentPath);
    if (resolvedPath !== resolve(root) && isPathInsideRoot(root, resolvedPath) && existsSync(resolvedPath) && isRealPathInsideRoot(root, resolvedPath)) {
      const base = basename(state.currentPath);
      // Exact identity only. A substring match made `settle --change feat-a` resolve
      // an unrelated `feat-abc` worktree and destroy its uncommitted work.
      if (base === change || base === `feature${change}` || base === `feat-${change}` || base === `feat_${change}`) {
        worktreePaths.add(resolvedPath);
      }
    }
  } else if (line.startsWith("branch refs/heads/") && state.currentPath) {
    const b = line.slice("branch refs/heads/".length).trim();
    const resolvedPath = resolve(root, state.currentPath);
    if (resolvedPath !== resolve(root) && worktreePaths.has(resolvedPath)) {
      if (!isProtectedRefName(b)) branches.add(b);
    }
  }
}

export function resolveSettleTargets(root, change) {
  const worktreePaths = new Set();
  const branches = new Set();

  if (!change || typeof change !== "string" || isProtectedRefName(change)) {
    return { worktreePaths, branches };
  }

  const currentBranch = isInsideGitRepo(root) ? getCurrentBranch(root) : null;
  if (currentBranch && isRefMatchingCurrentBranch(change, currentBranch)) {
    return { worktreePaths, branches };
  }

  resolveSettleDocTargets(root, change, worktreePaths, branches);
  resolveSettleDiskWorktrees(root, change, worktreePaths);
  resolveSettleGitTargets(root, change, worktreePaths, branches);
  resolveSettleBranchCandidates(root, change, currentBranch, branches);

  return { worktreePaths, branches };
}

function resolveSettleDiskWorktrees(root, change, worktreePaths) {
  const wtBase = join(root, ".tmp", "worktrees");
  if (!existsSync(wtBase)) return;
  try {
    for (const entry of readdirSync(wtBase)) {
      // Same exactness rule as parseWorktreeLine: `feat-a` must never resolve `feat-abc`.
      if (entry === change || entry === `feature${change}` || entry === `feat-${change}` || entry === `feat_${change}`) {
        const p = resolve(wtBase, entry);
        if (existsSync(p) && isPathInsideRoot(root, p) && isRealPathInsideRoot(root, p) && resolve(p) !== resolve(root)) {
          worktreePaths.add(p);
        }
      }
    }
  } catch {}
}

function resolveSettleBranchCandidates(root, change, currentBranch, branches) {
  if (!isInsideGitRepo(root)) {
    branches.clear();
    return;
  }
  const existingLocalBranches = getLocalBranches(root);
  const candidateBranches = new Set([
    `feat/${change}`, `fix/${change}`, `feat-${change}`, `fix-${change}`,
    ...(/^(?:feat|fix|feature)[/-]/i.test(change) ? [change] : []),
  ]);
  for (const b of candidateBranches) {
    if (existingLocalBranches.has(b)) branches.add(b);
  }
  for (const b of Array.from(branches)) {
    if (!existingLocalBranches.has(b) || isProtectedRefName(b) || (currentBranch && isRefMatchingCurrentBranch(b, currentBranch))) {
      branches.delete(b);
    }
  }
}

export function removeSettleWorktrees(root, worktreePaths) {
  for (const wtPath of worktreePaths) {
    // A junction inside the root would pass the lexical check and then be deleted
    // recursively outside the project. Refuse existing-but-escaping paths; a path that
    // no longer exists keeps the old behavior (git drops a stale registration).
    if (isPathInsideRoot(root, wtPath) && resolve(wtPath) !== resolve(root) && (!existsSync(wtPath) || isRealPathInsideRoot(root, wtPath))) {
      removeSingleSettleWorktree(root, wtPath);
    }
  }
}

function removeSingleSettleWorktree(root, wtPath) {
  if (isInsideGitRepo(root)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch {}
  }
  try {
    rmSync(wtPath, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`failed to remove worktree at ${wtPath}: ${err.message}`);
  }
  if (existsSync(wtPath)) {
    throw new Error(`failed to remove worktree at ${wtPath}: directory still exists`);
  }
}

export function removeSettleBranches(root, branches) {
  if (!isInsideGitRepo(root)) return;
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore", windowsHide: true });
  } catch {}
  for (const b of branches) {
    if (isProtectedRefName(b)) {
      throw new Error(`cannot delete protected branch '${b}'`);
    }
    const currentBranch = getCurrentBranch(root);
    if (currentBranch && isRefMatchingCurrentBranch(b, currentBranch)) {
      throw new Error(`cannot delete current branch '${b}'`);
    }
    try {
      execFileSync("git", ["branch", "-D", b], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`failed to delete branch '${b}': ${msg}`);
    }
  }
}

export function cmdSettle(root, flags = {}) {
  const change = confirmSettle(flags);
  if (!change) return 1;

  if (isProtectedRefName(change)) {
    console.error(`workflow settle: refusing to settle protected ref '${change}'.`);
    return 1;
  }

  if (isInsideGitRepo(root)) {
    const currentBranch = getCurrentBranch(root);
    if (currentBranch && isRefMatchingCurrentBranch(change, currentBranch)) {
      console.error(`workflow settle: refusing to settle current branch '${currentBranch}'.`);
      return 1;
    }
  }

  const { worktreePaths, branches } = resolveSettleTargets(root, change);
  if (worktreePaths.size === 0 && branches.size === 0) {
    console.error(`workflow settle: no existing worktree or branch found for change '${change}'.`);
    return 1;
  }

  try {
    removeSettleWorktrees(root, worktreePaths);
    removeSettleBranches(root, branches);
  } catch (err) {
    console.error(`workflow settle: ${err.message}`);
    return 1;
  }

  console.log(`workflow settle: change '${change}' worktree and branch removed.`);
  return 0;
}
