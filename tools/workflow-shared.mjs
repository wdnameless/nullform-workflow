#!/usr/bin/env node
/**
 * tools/workflow-shared.mjs — shared definitions for workflow and workflow-ci.
 * Leaf module: must not import from workflow.mjs or workflow-ci.mjs.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { getPorcelainStatusRaw } from "./review/evidence.mjs";
import { isStructuralExcludedPath } from "./worktree-snapshot.mjs";

function findGitRoot(startDir) {
  let curr = resolve(startDir);
  while (true) {
    if (existsSync(join(curr, ".git"))) {
      return curr;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

export function isInsideGitRepo(root) {
  if (findGitRoot(root)) return true;
  try {
    const res = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000
    }).trim();
    return res === "true";
  } catch {
    return false;
  }
}

export const isWorkflowPath = (p) => String(p || "").replace(/\\/g, "/").split("/").includes(".workflow");

/**
 * Acceptance staleness: verifies full tree content state (tracked + untracked)
 * recorded at acceptance against current tree using SHA-256 content hashes,
 * timestamps, and file existence. Detects modified files even with matching
 * mtime/size or restored timestamps, deleted files, and newly added untracked files.
 */
export function getPorcelainEntries(root) {
  try {
    let prefix = "";
    try {
      prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000
      }).trim().replace(/\\/g, "/");
    } catch {}

    const statusOut = getPorcelainStatusRaw(root);
    if (statusOut === null) return null;
    const rawItems = statusOut.split("\0");
    const entries = [];
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      if (!item) continue;
      const code = item.slice(0, 2);
      let rel = item.slice(3);
      if ((code[0] === "R" || code[0] === "C") && i + 1 < rawItems.length) {
        i++;
      }
      if (prefix && rel.startsWith(prefix)) {
        rel = rel.slice(prefix.length);
      }
      rel = rel.replace(/\\/g, "/");
      if (!rel || isWorkflowPath(rel) || isStructuralExcludedPath(rel)) continue;
      entries.push({ code, rel });
    }
    return entries;
  } catch {
    return null;
  }
}
