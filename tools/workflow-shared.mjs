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

/** Paths git ignores, as root-relative POSIX strings (empty when unavailable). */
export function gitIgnoredPaths(root) {
  const out = new Set();
  try {
    const raw = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    });
    for (const entry of raw.split("\0")) {
      const rel = entry.trim().replace(/\\/g, "/").replace(/\/$/, "");
      if (rel) out.add(rel);
    }
  } catch { /* no git or nothing ignored: an unreadable ignore set cannot invent orphans */ }
  return out;
}

/** Last commit in `baseRef..HEAD` that touched a change's directory (empty when untouched). */
export function lastTouchingRevision(root, change, baseRef) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%H", `${baseRef}..HEAD`, "--", `openspec/changes/${change}`], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Acceptance vocabulary shared by the local recon artifact gate and the CI recon
 * file gate. They used to hold two different regexes: a note could pass locally and
 * fail in CI (or the reverse) because each matched its own wording.
 *
 * Evidence words only — "plan"/"mapped" describe intent, not proof.
 */
export const ACCEPTANCE_VERDICT_RE = /(accept|verif|check|prove|proof|proven|test(?:s|ed)?\b|pass(?:es|ed)?\b|green|criteria|criterion|exit\s*code|repro|assert|smoke|suite|\d+\s*\/\s*\d+|провер|приёмк|приемк|критери|тест|готов)/i;

/** Files the recon note claims to touch: a path, a filename, or a "Files:" label.
 *
 * The extension list is data, not a judgement about which languages count: a note that
 * names `a.txt` or `schema.sql` is naming a file just as much as one that names `.mjs`.
 * The previous narrower list rejected `- a.txt` as "no evidence", which is a false
 * negative on a perfectly explicit recon note.
 */
const RECON_EXTENSIONS = [
  "mjs", "cjs", "js", "jsx", "ts", "tsx", "json", "jsonl", "md", "txt", "py", "ps1", "sh",
  "bash", "ya?ml", "toml", "ini", "cfg", "conf", "env", "sql", "csv", "xml", "html", "css",
  "scss", "vue", "svelte", "java", "kt", "kts", "go", "rs", "rb", "php", "cs", "swift",
  "c", "h", "cc", "cpp", "hpp", "gradle", "lock", "snap",
];
export const RECON_FILES_RE = new RegExp(
  `(touched files|files touched|files:|\\b[\\w@.-]+\\.(?:${RECON_EXTENSIONS.join("|")})\\b|(?:^|\\s)[\\w.-]+\\/[\\w./-]+)`,
  "i",
);

/** True when the text names both what it touches and how completion is proven. */
export function hasReconEvidence(text) {
  // Headings are labels, not evidence: a file whose only content is
  // "## Files touched" / "## Acceptance check" matched both patterns and passed
  // while proving nothing, so the section titles are removed before testing.
  const body = String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join("\n");
  return RECON_FILES_RE.test(body) && ACCEPTANCE_VERDICT_RE.test(body);
}
