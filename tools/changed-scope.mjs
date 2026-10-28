/**
 * tools/changed-scope.mjs — shared changed-files scope for CI quality gates.
 *
 * Single home of git-diff scoping + suite matching used by mutation-changed
 * and coverage-changed. Split out when the copy grew a second consumer and
 * the clone gate fired (38 lines): two owners of one hunk-format parser is
 * how drift starts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export function gitRevParse(root, ref) {
  try {
    const res = execFileSync("git", ["rev-parse", "--verify", ref], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return res.trim();
  } catch { return null; }
}

export function resolveBaseRef(root, explicitBase = null) {
  if (explicitBase) {
    if (gitRevParse(root, explicitBase)) return explicitBase;
    if (gitRevParse(root, `origin/${explicitBase}`)) return `origin/${explicitBase}`;
    return explicitBase;
  }

  const baseRefEnv = process.env.BASE_REF || process.env.GITHUB_BASE_REF;
  if (baseRefEnv) {
    if (gitRevParse(root, `origin/${baseRefEnv}`)) return `origin/${baseRefEnv}`;
    if (gitRevParse(root, baseRefEnv)) return baseRefEnv;
  }

  const eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME;
  const pushBase = process.env.PUSH_BASE || process.env.GITHUB_EVENT_BEFORE;
  if (eventName === "push" && pushBase && !/^0+$/.test(pushBase)) {
    if (gitRevParse(root, pushBase)) return pushBase;
  }

  if (gitRevParse(root, "HEAD~1")) {
    return "HEAD~1";
  }

  return null;
}

export function gitDiff(root, args) {
  try {
    return execFileSync("git", ["diff", ...args], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function getChangedFiles(root, baseRef, headRef = "HEAD") {
  let diffOut = gitDiff(root, ["--name-only", `${baseRef}...${headRef}`])
    ?? gitDiff(root, ["--name-only", `${baseRef}..${headRef}`]);
  // base == head в грязном дереве: три точки пусты — смотрим worktree против base.
  if (diffOut === null) return null;
  if (baseRef === headRef && diffOut.trim() === "") {
    diffOut = gitDiff(root, ["--name-only", baseRef]);
  }
  if (diffOut === null) return null;

  return diffOut
    .split("\n")
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

export function getChangedLines(root, baseRef, headRef, file) {
  let out = gitDiff(root, ["-U0", `${baseRef}...${headRef}`, "--", file]);
  if (out === null) return null;
  if (baseRef === headRef && out.trim() === "") {
    out = gitDiff(root, ["-U0", baseRef, "--", file]);
  }
  if (out === null) return null;
  const lines = [];
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number.parseInt(m[1], 10), count = m[2] ? Number.parseInt(m[2], 10) : 1;
    for (let n = start; n < start + count; n++) lines.push(n);
  }
  return lines;
}

export function findMatchingSuite(root, targetFile) {
  const norm = targetFile.replace(/\\/g, "/");
  const base = basename(norm, ".mjs");
  const dir = dirname(norm);

  const candidates = [
    join(root, "tools", "tests", `${base}.test.mjs`),
    join(root, "tests", `${base}.test.mjs`),
    join(root, dir, "tests", `${base}.test.mjs`),
    join(root, dir, `${base}.test.mjs`),
    join(root, "tools", "tests", `u-${base}.test.mjs`),
    join(root, "tools", "tests", `p-${base}.test.mjs`),
  ];

  const stripped = base.replace(/^(workflow|dashboard|bench)-/, "");
  if (stripped !== base) {
    candidates.push(join(root, "tools", "tests", `${stripped}.test.mjs`));
  }

  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      return relative(root, c).replace(/\\/g, "/");
    }
  }

  const testsDir = join(root, "tools", "tests");
  if (existsSync(testsDir)) {
    try {
      const files = readdirSync(testsDir);
      const match = files.find((f) => f.endsWith(".test.mjs") && f.includes(base));
      if (match) {
        return `tools/tests/${match}`;
      }
    } catch {}
  }

  return null;
}

export function filterCandidateFiles(root, fileList) {
  return fileList.filter((f) => {
    if (!f.endsWith(".mjs")) return false;
    if (f.endsWith(".test.mjs") || f.includes("tools/tests/") || f.includes("/tests/")) return false;
    const absPath = join(root, f);
    return existsSync(absPath) && statSync(absPath).isFile();
  });
}
