/**
 * tools/quality/engine.mjs — core analysis engine, runner, and ratchet for the quality gate.
 *
 * Implements stack loading, bounded tree walk, stack detection, command expansion,
 * analyzer execution, ratchet evaluation, baseline management, and sidecar config generation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, relative, dirname, sep, isAbsolute } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PARSERS } from "./parsers.mjs";
import { resolveNpmRunner } from "../installation/state.mjs";

export const STACKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "stacks.json");
export const BASELINE_FILE = ".quality-baseline.json";
export const SIDECAR_DIR = ".quality";

export const SKIP_DIRS = new Set([
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

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

function processWalkEntry(entry, dir, depth, maxDepth, queue, out, limit) {
  if (entry.isSymbolicLink()) return;
  const full = join(dir, entry.name);
  if (entry.isDirectory()) {
    if (!shouldSkipDir(entry.name) && depth < maxDepth) {
      queue.push({ dir: full, depth: depth + 1 });
    }
    return;
  }
  if (out.length < limit) out.push(full);
}

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
      processWalkEntry(entry, dir, depth, maxDepth, queue, out, limit);
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
      proof = files.find((f) => f === marker || f.endsWith("/" + marker) || (marker.startsWith("*.") && f.endsWith(marker.slice(1)))) || null;
      if (proof) break;
    }
    if (proof) detected.push({ id: stack.id, display: stack.display, coco: stack.coco, metric: stack.metric, proof, verifiedOn: stack.verifiedOn ?? null });
  }
  return detected;
}

/** Project source files for a stack, by the extension markers it declares. */
export function sourceFiles(root, stack) {
  const exts = (stack.markers || []).filter((m) => /^\*\.[A-Za-z0-9]+$/.test(m)).map((m) => m.slice(1));
  const files = walk(root);
  return files
    .map((abs) => relative(root, abs).split(sep).join("/"))
    .filter((rel) => exts.some((ext) => rel.endsWith(ext)));
}

/* ---------------------------------------------------------------- command tokens */

export function venvPython(root) {
  const candidates = [".venv/bin/python", ".venv/Scripts/python.exe", "venv/bin/python", "venv/Scripts/python.exe"];
  return candidates.find((rel) => existsSync(join(root, rel))) || null;
}

export function pythonBin(root) {
  if (process.env.QUALITY_PYTHON) return process.env.QUALITY_PYTHON;
  const venv = venvPython(root);
  if (venv) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

export function expandArgv(argv, { root, qualityDir, files, stack: _stack }) {
  const values = { root, quality: qualityDir, python: pythonBin(root) };
  const out = [];
  for (const token of argv) {
    if (token === "{files...}") { out.push(...(files || [])); continue; }
    out.push(token.replace(/\{(root|quality|python)\}/g, (_, k) => values[k]));
  }
  return out;
}

export function toolAvailable(argv, cwd = process.cwd()) {
  const [cmd] = argv;
  if (!cmd) return false;
  if (!isPathLike(cmd)) {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
  }
  if (existsSync(resolve(cwd, cmd))) return true;
  if (process.platform === "win32") {
    const lastSlash = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
    const hasExt = /\.[^.\\/]+$/.test(cmd.slice(lastSlash + 2));
    if (!hasExt) {
      if ([".exe", ".cmd", ".bat"].some((ext) => existsSync(resolve(cwd, cmd + ext)))) return true;
      return spawnSync("where", [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
    }
  }
  return /[\\/]/.test(cmd) ? false
    : spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { cwd, stdio: "pipe", encoding: "utf8", shell: false, windowsHide: true }).status === 0;
}

function isPathLike(cmd) {
  return /[\\/]/.test(cmd) || /\.[cm]?js$/i.test(cmd) || /\.(exe|cmd|bat|ps1|py)$/i.test(cmd);
}

const WIN_BATCH = process.platform === "win32" ? /^(npx|pnpm|yarn|composer|gradle|mvn)$/i : null;

export function spawnArgv(argv, cwd, env) {
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
    const runner = resolveNpmRunner();
    if (runner.usesNode) return spawnSync(runner.command, [...runner.prefixArgs, ...rest], { ...options, shell: false });
  }
  return spawnSync(local, rest, { ...options, shell: false });
}

function sidecarPresent(root, stack, qualityDir) {
  return Object.keys(stack.configs || {}).every((rel) => existsSync(join(root, qualityDir, rel)));
}

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

export function runStack(stack, { root, qualityDir, files }) {
  const run = stack.run;
  if (!run) return { rows: [], status: "no-runner" };
  if (stack.configs && !sidecarPresent(root, stack, qualityDir)) writeConfigs(root, stack, { defaults: { sidecarDir: qualityDir } }, { onlyMissing: true });
  const resolvedFiles = files ?? (run.argv.includes("{files...}") ? sourceFiles(root, stack) : null);
  const argv = expandArgv(run.argv, { root, qualityDir, files: resolvedFiles, stack });
  const missingFiles = files && files.length > 0 && !argv.includes(root) && run.argv.includes("{files...}") && files.length === 0;
  if (missingFiles) return { rows: [], status: "no-input" };
  if (!toolAvailable(argv, root)) return { rows: [], status: "missing-tool", argv };
  const env = stack.env
    ? Object.fromEntries(Object.entries(stack.env).map(([k, v]) => [k, v.replace(/\{quality\}/g, qualityDir)]))
    : null;
  const batches = batchArgv(argv, resolvedFiles);
  const rows = [];
  let stderrAll = "";
  for (const batch of batches) {
    const res = spawnArgv(batch, root, env);
    if (res.error) return { rows: [], status: "cannot-run", detail: String(res.error.message || res.error), argv: batch };
    const stdout = res.stdout || "";
    const stderr = res.stderr || "";
    stderrAll += stderr;
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

export function baselineKey(row, relFile) {
  const name = row.fn || `line-${row.line}`;
  return `${relFile}:${name}`;
}

export function disambiguate(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const base = baselineKey(row, row.file);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...row, key: n > 1 ? `${base}#${n}` : base };
  });
}

/* ----------------------------------------------------------------------- check */

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

export function normalizeFile(root, file) {
  if (!file) return "";
  const absolute = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.startsWith("..")) return String(file).split("\\").join("/");
  const native = rel.split(sep).join("/");
  if (process.platform === "win32" || !native.includes("\\")) return native;
  const folded = native.split("\\").join("/");
  return !existsSync(join(root, native)) && existsSync(join(root, folded)) ? folded : native;
}

export function nameRows(root, stackId, rows) {
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

/* ---------------------------------------------------------------------- configs */

export const CONFIG_BODIES = {
  "eslint-sonarjs": (stack) => `// Generated by nullform quality install — harness-owned, safe to delete.
import sonarjs from "eslint-plugin-sonarjs";

export default [
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,jsx}"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", ${stack.threshold}],
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

[MASTER]
ignore=.venv,venv,node_modules,vendor,build,dist,.quality,.tmp,__pycache__,
ignore-paths=^\\.venv/.*$,^venv/.*$,^node_modules/.*$,^vendor/.*$,^\\.tmp/.*$
`,
  "clippy-threshold": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
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
  "editorconfig-s3776": (_stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
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
Metrics/PerceivedComplexity:
  Enabled: true
  Max: ${stack.threshold}
`,
  "swiftlint-cyclomatic": (stack) => `# Generated by nullform quality install — harness-owned, safe to delete.
cyclomatic_complexity:
  warning: ${stack.threshold}
  error: ${stack.threshold}
  ignores_case_statements: false
`,
};

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

export function seedBaseline(root, doc, chosen, qualityDir, baselineFile, err) {
  const baseline = loadBaseline(root, baselineFile);
  let seeded = false;
  let pending = false;
  for (const s of chosen) {
    const stack = doc.stacks.find((x) => x.id === s.id);
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

export function installAnalyzer(stack, { root, qualityDir, allowHostInstall = false }) {
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
