/**
 * tools/changed-scope.mjs — shared changed-files scope for CI quality gates.
 *
 * Single home of git-diff scoping + suite matching used by mutation-changed
 * and coverage-changed. Split out when the copy grew a second consumer and
 * the clone gate fired (38 lines): two owners of one hunk-format parser is
 * how drift starts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";

export function resolveRoot(explicit) {
  if (explicit) return resolve(explicit);
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

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

export function findMatchingSuite(root, targetFile, suitesDir = "tools/tests") {
  const norm = targetFile.replace(/\\/g, "/");
  const base = basename(norm, ".mjs");
  const dir = dirname(norm);

  const candidates = [
    join(root, suitesDir, `${base}.test.mjs`),
    join(root, "tests", `${base}.test.mjs`),
    join(root, dir, "tests", `${base}.test.mjs`),
    join(root, dir, `${base}.test.mjs`),
    join(root, suitesDir, `u-${base}.test.mjs`),
    join(root, suitesDir, `p-${base}.test.mjs`),
  ];

  const stripped = base.replace(/^(workflow|dashboard|bench)-/, "");
  if (stripped !== base) {
    candidates.push(join(root, suitesDir, `${stripped}.test.mjs`));
  }

  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      return relative(root, c).replace(/\\/g, "/");
    }
  }

  const testsDir = join(root, suitesDir);
  if (existsSync(testsDir)) {
    try {
      const files = readdirSync(testsDir);
      const match = files.find((f) => f.endsWith(".test.mjs") && f.includes(base));
      if (match) {
        return relative(root, join(testsDir, match)).replace(/\\/g, "/");
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

const CONFIG_FILE_RE = /(^|\/)(package(-lock)?\.json|tsconfig.*\.json|eslint\.config\..*|\.eslintrc.*|\.prettierrc.*|\.env.*|\.git.*|.*\.(json|json5|yaml|yml|toml))$/i;
function makeFileEntry(oldPath = null, newPath = null) {
  return {
    oldPath,
    newPath,
    file: newPath || oldPath,
    additions: 0,
    deletions: 0,
    hunks: 0,
    addedLines: [],
    deletedLines: [],
    isRename: false,
    renameFrom: null,
    renameTo: null,
  };
}

export function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== "string") return [];
  const lines = diffText.split(/\r?\n/);
  const files = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const parts = line.slice("diff --git ".length).split(" ");
      const oldPath = parts[0] ? parts[0].replace(/^[ab]\//, "") : null;
      const newPath = parts[1] ? parts[1].replace(/^[ab]\//, "") : null;
      current = makeFileEntry(oldPath, newPath);
      files.push(current);
      continue;
    }

    if (line.startsWith("--- ")) {
      if (!current || current.hunks > 0 || current.additions > 0 || current.deletions > 0) {
        current = makeFileEntry();
        files.push(current);
      }
      const p = line.slice(4).trim();
      if (p !== "/dev/null") {
        current.oldPath = p.replace(/^[ab]\//, "");
        if (!current.file) current.file = current.oldPath;
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith("rename from ")) {
      current.isRename = true;
      current.renameFrom = line.slice("rename from ".length).trim();
      current.oldPath = current.renameFrom;
    } else if (line.startsWith("rename to ")) {
      current.isRename = true;
      current.renameTo = line.slice("rename to ".length).trim();
      current.newPath = current.renameTo;
      current.file = current.renameTo;
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") {
        current.newPath = p.replace(/^[ab]\//, "");
        current.file = current.newPath;
      }
    } else if (line.startsWith("@@ ")) {
      current.hunks++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions++;
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions++;
      current.deletedLines.push(line.slice(1));
    }
  }

  return files.filter(f => f.file != null);
}

function extractNewDeps(parsedFiles) {
  const deps = new Set();
  for (const f of parsedFiles) {
    const isPackageJson = f.file === "package.json" || f.file.endsWith("/package.json");
    if (isPackageJson) {
      for (const line of f.addedLines) {
        const m = line.match(/"(@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)"\s*:\s*["^~>=<0-9]/i);
        if (m) {
          const name = m[1];
          if (!name.startsWith("@types/") && !["scripts", "name", "version", "description", "main", "type"].includes(name)) {
            deps.add(name);
          }
        }
      }
    } else {
      for (const line of f.addedLines) {
        const impMatch = line.match(/(?:import\s+(?:.*?from\s+)?|require\()\s*["']([^"']+)["']/);
        if (impMatch) {
          const spec = impMatch[1];
          if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:")) {
            const rootPkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
            if (!isBuiltin(rootPkg)) {
              deps.add(rootPkg);
            }
          }
        }
      }
    }
  }
  return Array.from(deps).sort();
}

function extractApiRenames(parsedFiles) {
  const renames = [];
  for (const f of parsedFiles) {
    if (f.isRename && f.renameFrom && f.renameTo) {
      renames.push({ file: f.file, from: f.renameFrom, to: f.renameTo, type: "file" });
    }
    const removedExports = [];
    const addedExports = [];
    const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([a-zA-Z0-9_$]+)/;
    for (const line of f.deletedLines) {
      const m = line.match(exportRe);
      if (m) removedExports.push(m[1]);
    }
    for (const line of f.addedLines) {
      const m = line.match(exportRe);
      if (m) addedExports.push(m[1]);
    }
    for (let i = 0; i < Math.min(removedExports.length, addedExports.length); i++) {
      if (removedExports[i] !== addedExports[i]) {
        renames.push({
          file: f.file,
          from: removedExports[i],
          to: addedExports[i],
          type: "export",
        });
      }
    }
  }
  return renames;
}

function normalizeIntent(intent) {
  if (!intent) return [];
  if (Array.isArray(intent)) return intent.map(String).map(s => s.trim().replace(/\\/g, "/")).filter(Boolean);
  if (typeof intent === "string") {
    return intent.split(/[\s,]+/).map(s => s.trim().replace(/\\/g, "/")).filter(Boolean);
  }
  if (typeof intent === "object") {
    const list = [];
    for (const key of ["files", "paths", "scope", "zone", "allowed", "allowedFiles"]) {
      if (intent[key]) {
        if (Array.isArray(intent[key])) {
          list.push(...intent[key].map(String).map(s => s.trim().replace(/\\/g, "/")));
        } else if (typeof intent[key] === "string") {
          list.push(...intent[key].split(/[\s,]+/).map(s => s.trim().replace(/\\/g, "/")));
        }
      }
    }
    return list.filter(Boolean);
  }
  return [];
}

function matchIntent(file, patterns) {
  const normFile = file.replace(/\\/g, "/");
  for (const p of patterns) {
    if (p === normFile) return true;
    const dirPrefix = p.replace(/\/+$/, "") + "/";
    if (normFile.startsWith(dirPrefix)) return true;
    if (p.includes("*")) {
      const regexStr = "^" + p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
      if (new RegExp(regexStr).test(normFile)) return true;
    }
  }
  return false;
}

export function classifyScope(diffOrOpts, maybeIntent = null) {
  let diff = "";
  let intentInput = maybeIntent;
  if (typeof diffOrOpts === "string") {
    diff = diffOrOpts;
  } else if (diffOrOpts && typeof diffOrOpts === "object") {
    diff = diffOrOpts.diff ?? "";
    intentInput = diffOrOpts.intent ?? maybeIntent;
  }

  const parsedFiles = parseUnifiedDiff(diff);
  const patterns = normalizeIntent(intentInput);
  const hasIntent = patterns.length > 0;

  const in_scope = [];
  const likely_creep = [];
  const config_edits = [];

  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalHunks = 0;

  for (const pf of parsedFiles) {
    totalAdditions += pf.additions;
    totalDeletions += pf.deletions;
    totalHunks += pf.hunks;

    if (CONFIG_FILE_RE.test(pf.file)) {
      config_edits.push(pf.file);
    }

    if (hasIntent && matchIntent(pf.file, patterns)) {
      in_scope.push(pf.file);
    } else {
      likely_creep.push(pf.file);
    }
  }

  const new_deps = extractNewDeps(parsedFiles);
  const api_renames = extractApiRenames(parsedFiles);

  const stats = {
    files: parsedFiles.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    hunks: totalHunks,
    in_scope: in_scope.length,
    likely_creep: likely_creep.length,
  };

  let advisory = "keep";
  if (parsedFiles.length === 0) {
    advisory = "keep";
  } else if (in_scope.length > 0 && likely_creep.length > 0) {
    advisory = "split";
  } else if (likely_creep.length > 0 && in_scope.length === 0) {
    advisory = "justify";
  } else if (new_deps.length > 0 || api_renames.length > 0) {
    advisory = "justify";
  } else {
    advisory = "keep";
  }

  return {
    in_scope,
    likely_creep,
    new_deps,
    api_renames,
    config_edits,
    stats,
    advisory,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let diffFile = null;
  let intent = null;
  let baseRef = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--diff" && args[i + 1]) {
      diffFile = args[++i];
    } else if (args[i] === "--intent" && args[i + 1]) {
      intent = args[++i];
    } else if (args[i] === "--base" && args[i + 1]) {
      baseRef = args[++i];
    }
  }

  let diffText = "";
  if (diffFile) {
    diffText = readFileSync(diffFile, "utf8");
  } else {
    const root = resolveRoot();
    const resolvedBase = resolveBaseRef(root, baseRef) || "HEAD";
    diffText = gitDiff(root, ["-u", resolvedBase]) || "";
  }

  const report = classifyScope(diffText, intent);
  console.log(JSON.stringify(report, null, 2));
}
