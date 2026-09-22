#!/usr/bin/env node
/**
 * codemap.mjs — hierarchical repository cartography with change tracking.
 *
 * Subcommands:
 *   init     --root <dir> [--include <glob>...] [--exclude <glob>...]
 *   changes  --root <dir>
 *   update   --root <dir>
 *
 * State lives in <root>/.codemap/state.json (hashes per file + folder).
 * Emits per-folder `CODEMAP.md` templates for a Fixer agent to fill in.
 *
 * Zero dependencies. Node 18+ / Bun compatible.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";

const STATE_DIR = ".codemap";
const STATE_FILE = "state.json";
const LEGACY_STATE = ".codemap/state.legacy.json";
const MAP_FILE = "CODEMAP.md";

const DEFAULT_EXCLUDES = [
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
  "coverage", "__pycache__", ".venv", "venv", ".codemap", "vendor", ".turbo",
];

function parseArgs(argv) {
  const out = { _: [], include: [], exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--include") out.include.push(argv[++i]);
    else if (a === "--exclude") out.exclude.push(argv[++i]);
    else out._.push(a);
  }
  out.root = out.root || process.cwd();
  out.exclude = [...DEFAULT_EXCLUDES, ...out.exclude];
  return out;
}

function isExcluded(relPath, excludes) {
  const segs = relPath.split(/[\\/]/);
  return segs.some((s) => excludes.includes(s)) || segs.some((s) => s.startsWith("."));
}

// Glob-lite: supports **, *, and literal extensions. Enough for include filtering.
function toRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pat = esc
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp("^" + pat + "$");
}

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".kt", ".rb", ".php", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".swift",
  ".vue", ".svelte", ".sql", ".sh", ".ps1", ".lua", ".ex", ".exs", ".dart",
]);

function walk(root, excludes) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (isExcluded(rel, excludes)) continue;
      if (e.isDirectory()) stack.push(full);
      else files.push(rel);
    }
  }
  return files;
}

function hashFile(full) {
  try { return createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16); }
  catch { return null; }
}

function loadState(root) {
  const p = join(root, STATE_DIR, STATE_FILE);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  if (existsSync(join(root, LEGACY_STATE))) return JSON.parse(readFileSync(join(root, LEGACY_STATE), "utf8"));
  return null;
}

function saveState(root, state) {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(join(root, STATE_DIR, STATE_FILE), JSON.stringify(state, null, 2));
}

/**
 * Merge CLI args with the persisted scan config. A `changes`/`update` call with
 * no explicit --include/--exclude must reuse the config that produced the state,
 * or every previously-excluded file reads as newly added.
 */
function resolveScanArgs(root, args) {
  const prev = loadState(root);
  if (!prev) return args;
  const merged = { ...args };
  if (!args.include.length && prev.include?.length) merged.include = prev.include;
  if (prev.exclude?.length) {
    merged.exclude = [...new Set([...args.exclude, ...prev.exclude])];
  }
  return merged;
}

function scan(root, args) {
  const all = walk(root, args.exclude);
  const inc = args.include.length ? args.include.map(toRegex) : null;
  const files = {};
  for (const rel of all) {
    const norm = rel.split(sep).join("/");
    // The cartography artifact itself is never tracked.
    if (norm === MAP_FILE || norm.endsWith("/" + MAP_FILE)) continue;
    if (inc) {
      // Explicit --include is authoritative: accept exactly what it matches.
      if (!inc.some((r) => r.test(norm))) continue;
    } else {
      // Default heuristic: source code + root-level manifests only.
      const ext = "." + (norm.split(".").pop() || "");
      const isRootManifest = /^[^/]+\.(json|toml|ya?ml|lock)$/i.test(norm);
      if (!CODE_EXT.has(ext) && !isRootManifest) continue;
    }
    files[norm] = hashFile(join(root, rel));
  }
  return files;
}

const MAP_TEMPLATE = (folder) => `# ${folder}/

## Responsibility
<!-- What role does this directory play? Use standard terms: Service Layer, DAO, Middleware, Facade. -->

## Design Patterns
<!-- Name concrete patterns: Observer, Factory, Strategy, Repository. Detail abstractions/interfaces. -->

## Data & Control Flow
<!-- How does data enter and leave? Trace function call sequences and state transitions. -->

## Integration Points
<!-- Dependencies and consumers. Name hooks, events, API endpoints, shared types. -->
`;

function cmdInit(root, args) {
  if (loadState(root)) { console.log("State exists — running change detection instead."); return cmdChanges(root, args); }
  const files = scan(root, args);
  const folders = new Set(["."]);
  for (const f of Object.keys(files)) {
    let d = dirname(f);
    while (d && d !== "." && d !== "/") { folders.add(d); d = dirname(d); }
  }
  let created = 0;
  for (const folder of folders) {
    const mapPath = join(root, folder === "." ? "" : folder, MAP_FILE);
    if (!existsSync(mapPath)) { writeFileSync(mapPath, MAP_TEMPLATE(folder === "." ? "<root>" : folder)); created++; }
  }
  saveState(root, { version: 1, generatedAt: new Date().toISOString(), include: args.include, exclude: args.exclude, files });
  console.log(`init: ${Object.keys(files).length} files tracked, ${folders.size} folders, ${created} ${MAP_FILE} templates created.`);
  console.log("Next: delegate one Fixer per folder to fill in its CODEMAP.md, then run `codemap.mjs update`.");
}

function cmdChanges(root, args) {
  const prev = loadState(root);
  if (!prev) { console.error("No state. Run `init` first."); return; }
  const curr = scan(root, resolveScanArgs(root, args));
  const added = [], removed = [], modified = [];
  for (const [f, h] of Object.entries(curr)) {
    if (!(f in prev.files)) added.push(f);
    else if (prev.files[f] !== h) modified.push(f);
  }
  for (const f of Object.keys(prev.files)) if (!(f in curr)) removed.push(f);
  const affected = new Set();
  for (const f of [...added, ...modified, ...removed]) {
    const dir = dirname(f).split(sep).join("/");
    affected.add(dir === "." || dir === "" ? "<root>" : dir);
  }
  console.log(`changes: +${added.length} ~${modified.length} -${removed.length}`);
  if (added.length) console.log("  added:\n" + added.map((f) => "    " + f).join("\n"));
  if (modified.length) console.log("  modified:\n" + modified.map((f) => "    " + f).join("\n"));
  if (removed.length) console.log("  removed:\n" + removed.map((f) => "    " + f).join("\n"));
  console.log(`  affected folders (delegate one Fixer each): ${[...affected].sort().join(", ") || "none"}`);
}

function cmdUpdate(root, args) {
  const merged = resolveScanArgs(root, args);
  const files = scan(root, merged);
  saveState(root, { version: 1, generatedAt: new Date().toISOString(), include: merged.include, exclude: merged.exclude, files });
  console.log(`update: state saved (${Object.keys(files).length} files).`);
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const cmd = args._[0];
if (cmd === "init") cmdInit(args.root, args);
else if (cmd === "changes") cmdChanges(args.root, args);
else if (cmd === "update") cmdUpdate(args.root, args);
else {
  console.log("codemap.mjs — hierarchical repository cartography\n");
  console.log("  node codemap.mjs init --root . --include 'src/**/*.ts' --exclude 'dist/**'");
  console.log("  node codemap.mjs changes --root .");
  console.log("  node codemap.mjs update --root .");
}
