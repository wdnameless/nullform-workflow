#!/usr/bin/env node
/**
 * tools/quality.mjs — stack-aware static-analysis gate with a cognitive-complexity ratchet.
 *
 * The whole stack matrix lives in tools/quality/stacks.json; this file contains no
 * language knowledge. It answers one question per command:
 *
 *   detect    which stacks are in this project, and what proved it
 *   plan      what install would do (argv per stack), touching nothing
 *   install   write the harness-owned sidecar configs and seed the baseline
 *   check     fail on COCO above threshold for anything not baselined, or on growth
 *   baseline  re-seed the baseline (may only lower a value, never raise it)
 *
 * Ratchet semantics are copied from tools/code-size.mjs on purpose: same baseline
 * shape, same "grew vs new" vocabulary, so one mental model covers both gates.
 * A missing toolchain reports `unverified`, never `pass`.
 *
 * CLI:
 *   node tools/quality.mjs detect  [--root <dir>] [--json]
 *   node tools/quality.mjs plan    [--root <dir>] [--stack <id>] [--json]
 *   node tools/quality.mjs install [--root <dir>] [--stack <id>] [--dry-run] [--json]
 *   node tools/quality.mjs check   [--root <dir>] [--stack <id>] [--changed] [--json]
 *   node tools/quality.mjs baseline [--root <dir>] [--stack <id>] [--dry-run] [--prune] [--json]
 *
 * defer: stack matrix + ratchet in one module | ceiling: 700 lines | upgrade: split CLI and engine if adapters grow per-stack logic
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname, basename, sep, isAbsolute } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PARSERS } from "./quality/parsers.mjs";
import { resolveNpmRunner } from "./installation/state.mjs";
// One glob dialect in the repo, not two: markers and code-size scope use the same matcher.
import { globToRegex } from "./code-size.mjs";

export const STACKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "quality", "stacks.json");
export const BASELINE_FILE = ".quality-baseline.json";
export const SIDECAR_DIR = ".quality";

// Vendored/host-provisioned trees are not the project's code. `.venv`/`venv` matter most:
// the CI step creates one to hold the analyzer, and without this the gate graded
// site-packages of the analyzer itself (798 findings, measured).
// Deliberately NOT listing "bin": in this repo (and in most Node/Python projects) it is
// source. It came from code-size's build-output list and silently dropped 7 baselined
// functions from coverage — the gate went green by measuring less.
// `runs` matters most on a machine that has executed benchmarks: bench/runs holds full
// repository copies per run, and grading them reported 2646 findings from archived code
// nobody can act on. `_archive` and backup dirs are the same class.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "target", "dist", "build", "obj", "runs",
  ".tmp", ".quality", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "_archive", "migration-backup",
]);

export function loadStacks(file = STACKS_FILE) {
  const doc = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const ids = new Set();
  for (const stack of doc.stacks || []) {
    if (!stack.id || ids.has(stack.id)) throw new Error(`stacks.json: duplicate or missing id '${stack.id}'`);
    ids.add(stack.id);
    if (!Array.isArray(stack.markers) || stack.markers.length === 0) throw new Error(`stacks.json: '${stack.id}' has no markers`);
    if (!["native", "proxy", "none"].includes(stack.coco)) throw new Error(`stacks.json: '${stack.id}' coco must be native|proxy|none`);
    if (stack.run && !PARSERS[stack.run.parser]) throw new Error(`stacks.json: '${stack.id}' names unknown parser '${stack.run.parser}'`);
  }
  return doc;
}

/* ------------------------------------------------------------------ glob / walk */

/** Bounded walk: markers are shallow by nature, so depth is capped instead of
 * scanning an entire monorepo. Symlinked directories are not followed. */
export function walk(root, limit = 20000, maxDepth = 12) {
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && out.length < limit) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

/* ----------------------------------------------------------------------- detect */

/** Every stack whose marker matches, with the exact file that proved it. Marker
 * order inside a stack is significant: the first hit is the evidence shown, so a
 * declared manifest (package.json) outranks an incidental extension match. */
export function detectStacks(root, doc = loadStacks()) {
  const files = walk(root).map((f) => relative(root, f).split(sep).join("/"));
  const detected = [];
  for (const stack of doc.stacks) {
    let proof = null;
    for (const marker of stack.markers) {
      const re = globToRegex(marker);
      const hit = files.find((rel) => re.test(rel));
      if (hit) { proof = hit; break; }
    }
    if (proof) detected.push({ id: stack.id, display: stack.display, coco: stack.coco, metric: stack.metric, proof, verifiedOn: stack.verifiedOn ?? null });
  }
  return detected;
}

/** Project source files for a stack, by the extension markers it declares.
 *
 * Why the analyzers get a list instead of a root: every analyzer has its own idea of
 * what to skip, and a root passed to pylint walked a CI venv and reported 556 findings
 * from site-packages. One exclusion list (SKIP_DIRS) is the authority, and the analyzer
 * is never asked to make that decision.
 */
export function sourceFiles(root, stack) {
  const exts = (stack.markers || []).filter((m) => /^\*\.[A-Za-z0-9]+$/.test(m)).map((m) => m.slice(1));
  const files = walk(root);
  return files
    .map((abs) => relative(root, abs).split(sep).join("/"))
    .filter((rel) => exts.some((ext) => rel.endsWith(ext)));
}

/* ---------------------------------------------------------------- command tokens */

/** True only for an interpreter inside a project virtualenv. Installing a linter with
 * a global pip is a change to the operator's machine, not to the project, and was
 * observed happening: `install` polluted a system Python before this guard existed. */
function venvPython(root) {
  const candidates = [".venv/bin/python", ".venv/Scripts/python.exe", "venv/bin/python", "venv/Scripts/python.exe"];
  return candidates.find((rel) => existsSync(join(root, rel))) || null;
}

/** Interpreter for the project under test. `root` is authoritative: reading cwd made
 * `--root <other project>` resolve a venv that belonged to a different directory (or
 * none at all) and silently fall back to the host python — the exact path that put
 * pylint into a system interpreter. */
function pythonBin(root) {
  if (process.env.QUALITY_PYTHON) return process.env.QUALITY_PYTHON;
  const venv = venvPython(root);
  if (venv) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

export function expandArgv(argv, { root, qualityDir, files, stack }) {
  const values = { root, quality: qualityDir, python: pythonBin(root) };
  const out = [];
  for (const token of argv) {
    // An empty list is meaningful: it means "no project sources of this kind". Falling
    // back to {root} here is what let an analyzer grade its own virtualenv.
    if (token === "{files...}") { out.push(...(files || [])); continue; }
    out.push(token.replace(/\{(root|quality|python)\}/g, (_, k) => values[k]));
  }
  return out;
}

/**
 * A command is available when it is a resolvable file (relative runners such as
 * node_modules/eslint/bin/eslint.js) or a binary on PATH. `where`/`which` alone
 * cannot answer the first case, which made a working local eslint look missing.
 *
 * Windows batch shims (`npm.cmd`, `pnpm.cmd`) are only found by the probe, because
 * `spawnSync` without a shell cannot execute them — see spawnArgv.
 */
export function toolAvailable(argv, cwd = process.cwd()) {
  const [cmd] = argv;
  if (!cmd) return false;
  if (!isPathLike(cmd)) {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
  }
  if (existsSync(resolve(cwd, cmd))) return true;
  // `.cmd`/`.bat` shims live on PATH without an extension, so `where` still knows them.
  return /[\\/]/.test(cmd) ? false
    : spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
}

function isPathLike(cmd) {
  return /[\\/]/.test(cmd) || /\.[cm]?js$/i.test(cmd) || /\.(exe|cmd|bat|ps1|py)$/i.test(cmd);
}

/** Windows cannot spawn a `.cmd` shim without a shell. `npm` is the common case, and
 * it can be launched shell-free through its own JS entry (the resolver this repo
 * already uses); only the remaining shims fall back to cmd.exe. */
const WIN_BATCH = process.platform === "win32" ? /^(npx|pnpm|yarn|composer|gradle|mvn)$/i : null;

/** Resolve a relative runner against the project root without letting
 * `shell: true` reinterpret anything. A `.js` entry (node_modules/eslint/bin/
 * eslint.js) is not executable on its own, so it is launched under this Node. */
function spawnArgv(argv, cwd, env) {
  let [cmd, ...rest] = argv;
  if (/\.[cm]?js$/i.test(cmd)) { rest = [cmd, ...rest]; cmd = process.execPath; }
  const local = /[\\/]/.test(cmd) && !/^[A-Za-z]:/.test(cmd) ? resolve(cwd, cmd) : cmd;
  const options = {
    cwd, stdio: "pipe", encoding: "utf8", timeout: 300000,
    maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  };
  if (WIN_BATCH && WIN_BATCH.test(cmd)) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", cmd, ...rest], { ...options, shell: false });
  }
  if (process.platform === "win32" && /^npm$/i.test(cmd)) {
    // npm.cmd is not spawnable without a shell; npm-cli.js is, and this repo
    // already knows how to locate it (no second convention).
    const runner = resolveNpmRunner();
    if (runner.usesNode) return spawnSync(runner.command, [...runner.prefixArgs, ...rest], { ...options, shell: false });
  }
  return spawnSync(local, rest, { ...options, shell: false });
}

/** True when every declared sidecar file already exists on disk. */
function sidecarPresent(root, stack, qualityDir) {
  return Object.keys(stack.configs || {}).every((rel) => existsSync(join(root, qualityDir, rel)));
}

/** Split a file-list argv into batches that fit a platform command line.
 *
 * `{files...}` expands to every project source; on a large tree that exceeds the Windows
 * ~32K limit and the spawn fails before the analyzer runs. Only the trailing file list is
 * split, so the flags in front stay with each batch.
 */
export function batchArgv(argv, files, limit = 6000) {
  if (!Array.isArray(files) || files.length === 0) return [argv];
  const firstFile = argv.length - files.length;
  if (firstFile < 0) return [argv];
  const head = argv.slice(0, firstFile);
  const headLen = head.reduce((n, a) => n + a.length + 1, 0);
  const batches = [];
  let current = [];
  let size = headLen;
  for (const file of files) {
    if (current.length && size + file.length + 1 > limit) {
      batches.push([...head, ...current]);
      current = [];
      size = headLen;
    }
    current.push(file);
    size += file.length + 1;
  }
  if (current.length) batches.push([...head, ...current]);
  return batches.length ? batches : [argv];
}

/* ---------------------------------------------------------------------- run one */

/** Run one stack's analyzer and return parsed rows plus how they were obtained. */
export function runStack(stack, { root, qualityDir, files }) {
  const run = stack.run;
  if (!run) return { rows: [], status: "no-runner" };
  // The sidecar is generated, not committed (.quality/ is gitignored), so a fresh CI
  // clone has the baseline but no config. Materializing it here — byte-identical to
  // what `install` writes — is what makes `check` runnable on a clean checkout
  // instead of failing as "tool-error: config doesn't exist".
  if (stack.configs && !sidecarPresent(root, stack, qualityDir)) writeConfigs(root, stack, { defaults: { sidecarDir: qualityDir } }, { onlyMissing: true });
  // No explicit file list => analyze the project's own sources, never the bare root.
  const resolvedFiles = files ?? (run.argv.includes("{files...}") ? sourceFiles(root, stack) : null);
  const argv = expandArgv(run.argv, { root, qualityDir, files: resolvedFiles, stack });
  const missingFiles = files && files.length > 0 && !argv.includes(root) && run.argv.includes("{files...}") && files.length === 0;
  if (missingFiles) return { rows: [], status: "no-input" };
  if (!toolAvailable(argv, root)) return { rows: [], status: "missing-tool", argv };
  const env = stack.env
    ? Object.fromEntries(Object.entries(stack.env).map(([k, v]) => [k, v.replace(/\{quality\}/g, qualityDir)]))
    : null;
  // Windows caps a command line at ~32K characters; 226 source paths exceeded it and
  // spawnSync failed with ENAMETOOLONG, which reported as "cannot-run" on a tree that was
  // fine. Batch the file list and merge the reports so the gate works at any tree size.
  const batches = batchArgv(argv, resolvedFiles);
  const rows = [];
  let stderrAll = "";
  for (const batch of batches) {
    const res = spawnArgv(batch, root, env);
    if (res.error) return { rows: [], status: "cannot-run", detail: String(res.error.message || res.error), argv: batch };
    const stdout = res.stdout || "";
    const stderr = res.stderr || "";
    stderrAll += stderr;
    // An analyzer that produced no report at all (module missing, config rejected,
    // build failed) must not be read as "no violations": there is nothing to parse.
    if (!stdout.trim()) {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ") || `exit ${res.status}`;
      return { rows: [], status: "tool-error", detail, argv: batch, exitCode: res.status };
    }
    try {
      rows.push(...(PARSERS[run.parser] || (() => []))(stdout));
    } catch (err) {
      return { rows: [], status: "unparsable", detail: String(err.message || err), argv: batch, stderr: stderr.slice(0, 400) };
    }
  }
  return { rows, status: "ran", argv, exitCode: 0, stderr: stderrAll.slice(0, 400) };
}

/* -------------------------------------------------------------------- baseline */

export function loadBaseline(root, file = BASELINE_FILE) {
  const path = join(root, file);
  if (!existsSync(path)) return { version: 1, stacks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || typeof parsed.stacks !== "object") throw new Error(`${file}: expected {"version":1,"stacks":{…}}`);
  return parsed;
}

export function saveBaseline(root, baseline, file = BASELINE_FILE) {
  writeFileSync(join(root, file), JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

/** `file:name#n` — an n-th same-named function in one file, exactly like code-size. */
export function baselineKey(row, relFile) {
  const name = row.fn || `line-${row.line}`;
  return `${relFile}:${name}`;
}

function disambiguate(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const base = baselineKey(row, row.file);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...row, key: n > 1 ? `${base}#${n}` : base };
  });
}

/* ----------------------------------------------------------------------- check */

/** Apply the ratchet. `baselined` rows pass only while they do not grow; a row
 * above its stack threshold and absent from the baseline fails as `new`. */
export function applyRatchet(rows, stackBaseline, threshold) {
  const failures = [];
  const kept = {};
  for (const row of rows) {
    const base = stackBaseline[row.key];
    kept[row.key] = Math.max(base ?? 0, 0);
    if (row.coco <= threshold) continue;
    if (base === undefined) {
      failures.push({ type: "new", key: row.key, file: row.file, line: row.line, coco: row.coco, threshold, message: `New function above COCO threshold: ${row.key} (${row.coco} > ${threshold})` });
    } else if (row.coco > base) {
      failures.push({ type: "growth", key: row.key, file: row.file, line: row.line, coco: row.coco, base, threshold, message: `COCO grew past baseline: ${row.key} (${row.coco} > baseline ${base})` });
    }
  }
  return { failures, kept };
}

/** Merge one run's offenders into the recorded baseline.
 *
 * A key recorded before but absent now is either a deleted function or a RENAMED one.
 * Dropping it silently let `rename + baseline` erase a ceiling: the renamed function then
 * read as "new" and was re-baselined at today's number. Orphans are carried forward unless
 * `prune` is explicitly requested.
 */
export function mergeBaselineEntries(previous, rows, { prune = false } = {}) {
  const functions = {};
  const seen = new Set();
  let lowered = 0;
  for (const row of rows) {
    const prev = previous[row.key];
    const value = prev === undefined ? row.coco : Math.min(prev, row.coco);
    if (prev !== undefined && value < prev) lowered++;
    functions[row.key] = value;
    seen.add(row.key);
  }
  const orphans = Object.keys(previous).filter((k) => !seen.has(k));
  if (!prune) for (const k of orphans) functions[k] = previous[k];
  return { functions, lowered, orphans: prune ? 0 : orphans.length, pruned: prune ? orphans.length : 0 };
}

/** Files a `--changed` run should analyze: tracked modifications plus untracked
 * files (a brand-new 400-line function is exactly what the ratchet must see).
 * Extensions come from the stack's own `*.ext` markers, so adapters stay data-only. */
export function changedFiles(root, stack) {
  const exts = (stack.markers || []).filter((m) => /^\*\.[A-Za-z0-9]+$/.test(m)).map((m) => m.slice(1));
  const pick = (out) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((rel) => exts.length === 0 || exts.some((e) => rel.endsWith(e)));
  const run = (args) => {
    try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return null; }
  };
  const tracked = run(["diff", "--name-only", "--diff-filter=d", "HEAD"]);
  if (tracked === null) return null;
  const untracked = run(["ls-files", "--others", "--exclude-standard"]) ?? "";
  return [...new Set([...pick(tracked), ...pick(untracked)])];
}

function resolveName(sourceLines, line) {
  const limit = Math.min(sourceLines.length, line);
  for (let i = limit - 1; i >= 0; i--) {
    const m = sourceLines[i].match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/)
      || sourceLines[i].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()/)
      || sourceLines[i].match(/^\s{2,}(?:static\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\(/);
    if (m) return m[1];
  }
  return null;
}

/** Normalize a reported path to a repo-relative, forward-slash form.
 *
 * Analyzers report paths differently: pylint on Windows emits `tools\\session_cost.py`,
 * eslint emits an absolute path. Baseline keys must not depend on the OS, or a baseline
 * seeded on Windows reports every function as "new" on Linux CI — the gate would be
 * permanently red cross-platform for reasons that have nothing to do with complexity.
 */
export function normalizeFile(root, file) {
  if (!file) return "";
  const absolute = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, absolute);
  // A path outside the root keeps its own form rather than becoming "../x".
  if (rel.startsWith("..")) return String(file).split("\\").join("/");
  const native = rel.split(sep).join("/");
  // A baseline seeded on Windows carries "tools\\a.py:main". On POSIX a backslash is a legal
  // filename character, and `path.join` does not treat it as a separator, so the check is
  // gated on the platform rather than on a filesystem probe that cannot distinguish the
  // two meanings there.
  if (process.platform === "win32" || !native.includes("\\")) return native;
  const folded = native.split("\\").join("/");
  // On POSIX, fold only when the folded path exists and no file literally carries the
  // backslash — then it was a separator, not part of the name.
  return !existsSync(join(root, native)) && existsSync(join(root, folded)) ? folded : native;
}

function nameRows(root, stackId, rows) {
  const cache = new Map();
  return rows.map((row) => {
    const rel = normalizeFile(root, row.file);
    if (row.fn || stackId !== "node") return { ...row, file: rel };
    if (!cache.has(rel)) {
      try { cache.set(rel, readFileSync(join(root, rel), "utf8").split(/\r?\n/)); }
      catch { cache.set(rel, []); }
    }
    return { ...row, file: rel, fn: resolveName(cache.get(rel), row.line) };
  });
}

/* ---------------------------------------------------------------------- install */

const CONFIG_BODIES = {
  "eslint-sonarjs": (stack) => `// Generated by nullform quality install — harness-owned, safe to delete.
// Composition: this file is passed via -c, so the project's own eslint.config.mjs
// keeps working untouched. Threshold: ${stack.threshold}.
import sonarjs from "eslint-plugin-sonarjs";

export default [
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,jsx}"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", ${stack.threshold}],
      // Escape hatch: // eslint-disable-next-line sonarjs/cognitive-complexity -- reason
      // must carry a reason; the gate reports unreasoned suppressions separately.
    },
  },
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.quality/**", "**/.venv/**", "**/venv/**", "**/vendor/**", "**/target/**", "**/.tmp/**"] },
];
`,
  "pylint-coco": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
[MESSAGES CONTROL]
disable=all
enable=too-cognitively-complex

[COGNITIVE COMPLEXITY]
max-cognitive-complexity=${stack.threshold}

# Analyzer installs live here (CI creates a venv for pylint); grading site-packages
# would report the analyzer's own code as project defects.
[MASTER]
ignore=.venv,venv,node_modules,vendor,build,dist,.quality,.tmp,__pycache__,
ignore-paths=^\\.venv/.*$,^venv/.*$,^node_modules/.*$,^vendor/.*$,^\\.tmp/.*$
`,
  "clippy-threshold": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
# Consumed via CLIPPY_CONF_DIR, so the project's own clippy.toml is not modified.
cognitive-complexity-threshold = ${stack.threshold}
`,
  "golangci-gocognit": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
version: "2"
linters:
  enable:
    - gocognit
  settings:
    gocognit:
      min-complexity: ${stack.threshold}
`,
  "pmd-ruleset": (stack) => `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by nullform quality install — harness-owned, safe to delete. -->
<ruleset name="nullform-coco"
         xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0 https://pmd.sourceforge.io/ruleset_2_0_0.xsd">
  <description>Cognitive complexity ratchet</description>
  <rule ref="category/java/design.xml/CognitiveComplexity">
    <properties>
      <property name="reportLevel" value="${stack.threshold}"/>
    </properties>
  </rule>
</ruleset>
`,
  "detekt-coco": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
complexity:
  CognitiveComplexMethod:
    active: true
    allowedComplexity: ${stack.threshold}
  LongMethod:
    active: false
`,
  "editorconfig-s3776": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
# S3776 is disabled by default in SonarAnalyzer.CSharp; this block enables it.
[*.cs]
dotnet_diagnostic.S3776.severity = warning
`,
  "phpstan-coco": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
includes:
    - vendor/tomasvotruba/cognitive-complexity/extension.neon

parameters:
    cognitive_complexity:
        class: 50
        function: ${stack.threshold}
`,
  "rubocop-perceived": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
# PROXY: RuboCop reports PerceivedComplexity, which is NOT Sonar cognitive complexity.
Metrics/PerceivedComplexity:
  Enabled: true
  Max: ${stack.threshold}
`,
  "swiftlint-cyclomatic": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
# PROXY: SwiftLint has no cognitive-complexity rule; this is cyclomatic.
cyclomatic_complexity:
  warning: ${stack.threshold}
  error: ${stack.threshold}
  ignores_case_statements: false
`,
};

/** Materialize the harness-owned sidecar configs. `onlyMissing` is used by `check` on a
 * fresh clone: it writes what a clean checkout lacks and never rewrites an existing file,
 * so a locally tuned sidecar is not silently replaced. */
export function writeConfigs(root, stack, doc, { onlyMissing = false } = {}) {
  const written = [];
  const sidecar = join(root, doc.defaults?.sidecarDir || SIDECAR_DIR);
  for (const [rel, kind] of Object.entries(stack.configs || {})) {
    const make = CONFIG_BODIES[kind];
    if (!make) throw new Error(`no config body for kind '${kind}' (stack '${stack.id}')`);
    const dest = join(sidecar, rel);
    const body = make(stack);
    if (onlyMissing && existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const unchanged = existsSync(dest) && readFileSync(dest, "utf8") === body;
    if (!unchanged) writeFileSync(dest, body, "utf8");
    written.push({ file: relative(root, dest).split(sep).join("/"), status: unchanged ? "unchanged" : "written" });
  }
  return written;
}

/* ------------------------------------------------------------------------- CLI */

export function parseArgs(argv) {
  const args = { _: [], root: ".", stack: null, json: false, dryRun: false, changed: false, help: false, baseline: null, allowHostInstall: false, prune: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    // CI runners are disposable: installing there is not a change to an operator machine.
    // An explicit flag keeps the default safe and the exception visible in the workflow.
    else if (arg === "--allow-host-install") args.allowHostInstall = true;
    else if (arg === "--changed") args.changed = true;
    // Explicit opt-in to dropping baseline entries whose function no longer exists.
    else if (arg === "--prune") args.prune = true;
    else if (arg === "--root") args.root = argv[++i] || ".";
    else if (arg === "--stack") args.stack = argv[++i] || "";
    else if (arg === "--baseline") args.baseline = argv[++i] || "";
    else if (arg.startsWith("-")) args.errors.push(`unknown flag ${arg}`);
    else args._.push(arg);
  }
  if (args.errors.length === 0 && args._.length === 0) args.errors.push("missing command (detect|plan|install|check|baseline)");
  return args;
}

function selectStacks(doc, detected, only) {
  if (!only) return detected;
  const wanted = detected.find((s) => s.id === only);
  if (!wanted) throw new Error(`stack '${only}' not detected in this project (detected: ${detected.map((s) => s.id).join(", ") || "none"})`);
  return [wanted];
}

/** Resolve the stacks a command acts on, reporting the CLI error rather than throwing. */
function resolveSelection(doc, detected, only, err) {
  try { return { chosen: selectStacks(doc, detected, only) }; }
  catch (e) { err.write(`quality: ${e.message}\n`); return { error: true }; }
}

function cmdDetect(ctx) {
  const { detected, emit, root } = ctx;
  const rows = detected.map((s) => `  ${s.id.padEnd(8)} ${s.coco.padEnd(6)} proof=${s.proof.padEnd(24)} ${s.verifiedOn ? "verified: " + s.verifiedOn : "UNPROVEN on this host"}`);
  emit({ ok: true, root, stacks: detected }, detected.length ? `Detected stacks:\n${rows.join("\n")}\n` : "No known stack markers found.\n");
  return 0;
}

function cmdPlan(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const plan = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    return {
      id: s.id, coco: s.coco, metric: s.metric, threshold: stack.threshold,
      install: stack.install ? expandArgv(stack.install.argv, { root, qualityDir, stack }) : null,
      run: stack.run ? expandArgv(stack.run.argv, { root, qualityDir, stack, files: [] }) : null,
      configs: Object.keys(stack.configs || {}).map((rel) => `${qualityDir}/${rel}`),
    };
  });
  emit({ ok: true, root, plan }, plan.map((p) => `${p.id}: ${p.metric}\n  threshold ${p.threshold} (${p.coco})\n  install ${p.install ? p.install.join(" ") : "ships with toolchain"}\n  configs ${p.configs.join(", ") || "none"}\n`).join(""));
  return 0;
}

/** Seed every stack whose baseline is missing or whose earlier seeding failed. */
function seedBaseline(root, doc, chosen, qualityDir, baselineFile, err) {
  const baseline = loadBaseline(root, baselineFile);
  let seeded = false;
  let pending = false;
  for (const s of chosen) {
    const stack = doc.stacks.find((x) => x.id === s.id);
    // A previous attempt that never ran the analyzer left `seeded:false`; retrying
    // install is the natural fix, so that state must not be treated as done.
    if (baseline.stacks[s.id]?.seeded) continue;
    pending = true;
    const result = runStack(stack, { root, qualityDir, files: null });
    if (result.status !== "ran") { baseline.stacks[s.id] = { seeded: false, reason: result.status, detail: result.detail || null }; continue; }
    const entries = {};
    for (const row of disambiguate(nameRows(root, s.id, result.rows))) if (row.coco > stack.threshold) entries[row.key] = row.coco;
    baseline.stacks[s.id] = { threshold: stack.threshold, seeded: true, functions: entries };
    seeded = true;
  }
  saveBaseline(root, baseline, baselineFile);
  if (pending && !seeded) err.write("quality: baseline not seeded — see per-stack status above\n");
}

/** Pick the install argv for the situation, then actually run it.
 *
 * Two rules keep this safe on a real project:
 *   - never install for a stack whose package manager is absent: report the reason;
 *   - never force a fresh peer tool onto a project that already has one (`whenPresent`),
 *     because replacing a project's eslint major is not a quality gate's call.
 */
function installAnalyzer(stack, { root, qualityDir, allowHostInstall = false }) {
  if (!stack.install) return { status: "ships-with-toolchain" };
  const variant = stack.install.whenPresent && existsSync(join(root, stack.install.whenPresent.marker))
    ? stack.install.whenPresent
    : stack.install;
  if (variant.requiresVenv && !allowHostInstall) {
    const venv = venvPython(root);
    if (!venv) {
      return { status: "skipped-no-venv", argv: variant.argv.join(" "),
        detail: "refusing to install into the host interpreter; create .venv and re-run, or pass --allow-host-install on a disposable CI runner" };
    }
  }
  const argv = expandArgv(variant.argv, { root, qualityDir, stack });
  if (!toolAvailable([argv[0]], root)) return { status: "skipped-missing-package-manager", argv: argv[0] };
  const res = spawnArgv(argv, root, null);
  const detail = res.error ? String(res.error.message || res.error)
    : res.status === 0 ? null
    : String(res.stderr || res.stdout || "").trim().split(/\r?\n/).slice(-2).join(" | ");
  if (res.status !== 0 || res.error) return { status: "install-failed", argv, detail };
  return { status: "installed", argv };
}

function cmdInstall(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const actions = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    if (args.dryRun) {
      const variant = stack.install?.whenPresent && existsSync(join(root, stack.install.whenPresent.marker)) ? stack.install.whenPresent : stack.install;
      return { id: s.id, configs: Object.keys(stack.configs || {}), install: variant ? expandArgv(variant.argv, { root, qualityDir, stack }) : null, status: "dry-run" };
    }
    const configs = writeConfigs(root, stack, doc);
    return { id: s.id, configs, install: installAnalyzer(stack, { root, qualityDir, allowHostInstall: args.allowHostInstall }) };
  });
  if (!args.dryRun) seedBaseline(root, doc, chosen, qualityDir, baselineFile, err);
  const text = actions.map((a) => `${a.id}: ${a.status || a.install?.status || "installed"} ${JSON.stringify(a.configs)}${a.install?.detail ? ` — ${a.install.detail}` : ""}\n`).join("")
    + (args.dryRun ? "" : `baseline seeded in ${baselineFile}\n`);
  emit({ ok: true, root, actions }, text);
  return 0;
}

function cmdBaseline(ctx) {
  const { doc, detected, args, root, qualityDir, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  const baseline = loadBaseline(root, baselineFile);
  const report = chosen.map((s) => {
    const stack = doc.stacks.find((x) => x.id === s.id);
    const result = runStack(stack, { root, qualityDir, files: null });
    if (result.status !== "ran") return { id: s.id, status: result.status };
    const previous = baseline.stacks[s.id]?.functions || {};
    const rows = disambiguate(nameRows(root, s.id, result.rows)).filter((r) => r.coco > stack.threshold);
    const merged = mergeBaselineEntries(previous, rows, { prune: args.prune });
    baseline.stacks[s.id] = { threshold: stack.threshold, seeded: true, functions: merged.functions };
    return { id: s.id, offenders: Object.keys(merged.functions).length, lowered: merged.lowered, orphans: merged.orphans, pruned: merged.pruned };
  });
  if (!args.dryRun) saveBaseline(root, baseline, baselineFile);
  emit({ ok: true, root, report, dryRun: args.dryRun }, report.map((r) => `${r.id}: ${r.offenders ?? "-"} baselined, ${r.lowered ?? 0} lowered${r.orphans ? `, ${r.orphans} kept without a current match (rename? use --prune to drop)` : ""}${r.pruned ? `, ${r.pruned} pruned` : ""}${r.status ? ` (${r.status})` : ""}\n`).join("") + (args.dryRun ? "dry-run: nothing written\n" : `updated ${baselineFile}\n`));
  return 0;
}

/** One stack's verdict. Extracted so the loop body stays readable and the
 * "unseeded is not 45 findings" distinction lives next to the ratchet call. */
function checkOneStack(s, ctx, baseline, unverifiedRef) {
  const { doc, args, root, qualityDir } = ctx;
  const stack = doc.stacks.find((x) => x.id === s.id);
  const files = args.changed ? changedFiles(root, stack) : null;
  if (args.changed && files !== null && files.length === 0) return { id: s.id, status: "no-changes", failures: [] };
  const result = runStack(stack, { root, qualityDir, files });
  if (result.status !== "ran") {
    unverifiedRef.value = true;
    return { id: s.id, status: result.status, detail: result.detail || null, failures: [] };
  }
  if (baseline.stacks[s.id]?.seeded !== true) {
    unverifiedRef.value = true;
    return { id: s.id, status: "unseeded", detail: `baseline not seeded — run: node tools/quality.mjs baseline --stack ${s.id}`, failures: [] };
  }
  const rows = disambiguate(nameRows(root, s.id, result.rows));
  const { failures } = applyRatchet(rows, baseline.stacks[s.id]?.functions || {}, stack.threshold);
  return { id: s.id, status: failures.length ? "fail" : "pass", coco: s.coco, checked: rows.length, failures };
}

function formatCheck(results, ok) {
  const body = results.map((r) => {
    const head = `  ${r.id.padEnd(8)} ${r.status}${r.checked !== undefined ? ` (${r.checked} functions)` : ""}${r.detail ? ` — ${r.detail}` : ""}`;
    return [head, ...r.failures.map((f) => `      ${f.message}`)].join("\n");
  }).join("\n");
  const failures = results.reduce((n, r) => n + r.failures.length, 0);
  const tail = ok ? "COCO ratchet clean." : failures ? `FAIL: ${failures} violation(s).` : "UNVERIFIED: analyzer did not run.";
  return `${body}\n${tail}\n`;
}

function cmdCheck(ctx) {
  const { doc, detected, args, root, emit, err, baselineFile } = ctx;
  const { chosen, error } = resolveSelection(doc, detected, args.stack, err);
  if (error) return 2;
  if (chosen.length === 0) { err.write("quality: no known stack detected; nothing to check (not a pass)\n"); return 2; }
  const baseline = loadBaseline(root, baselineFile);
  const unverifiedRef = { value: false };
  const results = chosen.map((s) => checkOneStack(s, ctx, baseline, unverifiedRef));
  const ok = results.every((r) => r.status !== "fail") && !unverifiedRef.value;
  emit({ ok, root, results }, formatCheck(results, ok));
  return ok ? 0 : 1;
}

export function runQualityCli(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const args = parseArgs(argv);
  if (args.help) { out.write(HELP); return 0; }
  if (args.errors.length) { for (const e of args.errors) err.write(`quality: ${e}\n`); return 2; }

  const command = args._[0];
  const root = resolve(args.root);
  if (!existsSync(root)) { err.write(`quality: root not found: ${root}\n`); return 2; }

  let doc;
  try { doc = loadStacks(); } catch (e) { err.write(`quality: ${e.message}\n`); return 2; }

  const emit = (payload, text) => { if (args.json) out.write(JSON.stringify(payload, null, 2) + "\n"); else out.write(text); };
  const ctx = {
    doc, args, root, err, emit, command,
    detected: detectStacks(root, doc),
    baselineFile: args.baseline || doc.defaults?.baselineFile || BASELINE_FILE,
    qualityDir: relative(root, join(root, doc.defaults?.sidecarDir || SIDECAR_DIR)).split(sep).join("/"),
  };
  const commands = { detect: cmdDetect, plan: cmdPlan, install: cmdInstall, baseline: cmdBaseline, check: cmdCheck };
  const handler = commands[command];
  if (!handler) { err.write(`quality: unknown command '${command}'\n${HELP}`); return 2; }
  return handler(ctx);
}

const HELP = `quality.mjs — stack-aware static analysis with a cognitive-complexity ratchet

  node tools/quality.mjs detect   [--root <dir>] [--json]
  node tools/quality.mjs plan     [--root <dir>] [--stack <id>] [--json]
  node tools/quality.mjs install  [--root <dir>] [--stack <id>] [--dry-run] [--allow-host-install] [--json]
  node tools/quality.mjs check    [--root <dir>] [--stack <id>] [--changed] [--json]
  node tools/quality.mjs baseline [--root <dir>] [--stack <id>] [--dry-run] [--json]

Installs are refused outside a project virtualenv unless --allow-host-install is
given; that flag is for disposable CI runners, not a developer machine.
Exit: 0 clean · 1 violation or unverified · 2 cannot run.
A missing analyzer reports "unverified", never "pass". See docs/quality-gate.md.
`;

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = runQualityCli();
}
