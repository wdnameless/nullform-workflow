#!/usr/bin/env node
/**
 * glossary.mjs — CONTEXT.md bootstrap and vocabulary-drift check.
 *
 * The Oracle's Vocabulary Drift Gate rejects a diff that introduces a public
 * domain symbol absent from CONTEXT.md. That gate is only satisfiable if the
 * glossary can be bootstrapped and its drift measured mechanically — otherwise
 * it degrades into an opinion. This tool does both.
 *
 * It NEVER invents definitions. `draft` emits the symbol NAMES it found with
 * empty definition slots; deciding what a term means is the human/agent's job.
 *
 * Commands:
 *   draft  --root <dir> [--out CONTEXT.md]   write a skeleton (refuses to clobber)
 *   check  --root <dir>                      report public symbols missing from CONTEXT.md
 *
 * Exit: 0 clean, 1 drift found, 2 cannot run.
 * Zero dependencies. Node 18+ / Bun.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep, dirname, basename, extname } from "node:path";

/* --------------------------------------------------------------- extraction */

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
  "coverage", "__pycache__", ".venv", "venv", ".codemap", "vendor", ".turbo",
  "test", "tests", "__tests__", "spec", "specs", "fixtures", "migrations",
]);

/**
 * Per-language extractors. Each returns the names of symbols a CONSUMER of the
 * module must know: exported types/classes/interfaces and exported functions
 * that model domain behaviour. Deliberately excludes private/local symbols —
 * a glossary of internals is noise.
 *
 * These are regex extractors, not full parsers. They are intentionally narrow
 * so a miss is a missing suggestion, never a fabricated term.
 */
const EXTRACTORS = {
  ".ts": (src) => [
    ...matches(src, /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/g),
  ],
  ".tsx": (src) => [
    ...matches(src, /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/g),
  ],
  ".py": (src) => [
    ...matches(src, /^class\s+([A-Z][A-Za-z0-9_]*)/gm),
    // Module-level dataclasses / TypedDicts are the usual domain nouns.
    ...matches(src, /^([A-Z][A-Za-z0-9_]*)\s*=\s*(?:TypedDict|NamedTuple)/gm),
  ],
  ".rs": (src) => [
    ...matches(src, /pub\s+(?:struct|enum|trait)\s+([A-Z][A-Za-z0-9_]*)/g),
  ],
  ".go": (src) => [
    ...matches(src, /^type\s+([A-Z][A-Za-z0-9_]*)\s+(?:struct|interface)/gm),
  ],
  ".java": (src) => [...matches(src, /public\s+(?:final\s+)?(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)/g)],
  ".kt": (src) => [...matches(src, /^(?:data\s+)?(?:sealed\s+)?(?:class|interface|object|enum class)\s+([A-Z][A-Za-z0-9_]*)/gm)],
  ".cs": (src) => [...matches(src, /public\s+(?:sealed\s+|abstract\s+)?(?:class|interface|enum|record|struct)\s+([A-Z][A-Za-z0-9_]*)/g)],
  ".sql": (src) => [
    ...matches(src, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([a-z][a-z0-9_]*)["`\]]?/gi),
  ],
  ".swift": (src) => [...matches(src, /^(?:public\s+)?(?:struct|class|enum|protocol)\s+([A-Z][A-Za-z0-9_]*)/gm)],
  ".dart": (src) => [...matches(src, /^(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/gm)],
};

function matches(src, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** HTTP routes are domain surface too — a new endpoint is a new public symbol. */
function extractRoutes(src, ext) {
  if (![".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".rs"].includes(ext)) return [];
  const out = [];
  const res = [
    /\b(?:app|router|server|api)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const re of res) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

function walk(root, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(full, out, depth + 1);
    } else if (e.isFile()) {
      if (EXTRACTORS[extname(e.name)] || [".js", ".mjs", ".cjs"].includes(extname(e.name))) out.push(full);
    }
  }
  return out;
}

function collect(root) {
  const symbols = new Map();   // name -> Set(source files)
  const routes = new Map();

  for (const file of walk(root)) {
    const ext = extname(file);
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    // Skip generated files — their symbols are not domain concepts.
    if (/@generated|DO NOT EDIT|auto-generated/i.test(src.slice(0, 400))) continue;

    const rel = relative(root, file).split(sep).join("/");
    const ex = EXTRACTORS[ext];
    const names = ex ? ex(src) : [];
    // Only treat JS as a domain source when it actually declares types via JSDoc.
    if (!ex && ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") continue;

    for (const n of names) {
      if (!symbols.has(n)) symbols.set(n, new Set());
      symbols.get(n).add(rel);
    }
    for (const r of extractRoutes(src, ext)) routes.set(r, rel);
  }
  return { symbols, routes };
}

/* ------------------------------------------------------------ CONTEXT parsing */

/**
 * Terms genuinely documented in CONTEXT.md.
 *
 * A term counts ONLY when it carries a real definition. The bootstrap skeleton
 * writes `- **Order** — <!-- TODO: ... -->`, and treating that placeholder as
 * documentation would make `check` pass on an unfilled glossary — exactly the
 * failure the gate exists to prevent. So: strip HTML comments first, then
 * require a non-empty definition after the term.
 */
function documentedTerms(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  // Remove HTML comments entirely: TODOs and editorial notes are not definitions.
  const text = raw.replace(/<!--[\s\S]*?-->/g, "");
  const terms = new Set();

  for (const line of text.split("\n")) {
    // Bullet entries: `- **Term** — definition`
    const bullet = /^\s*[-*]\s+\*\*([^*]+)\*\*\s*(.*)$/.exec(line);
    if (bullet) {
      const term = bullet[1].trim().replace(/^`|`$/g, "");
      const definition = bullet[2].replace(/^[—:–-]+\s*/, "").trim();
      if (definition) terms.add(term);
      continue;
    }
    // Headings name a group, not a term with a definition — skip them.
  }

  // Backticked identifiers count only when they appear in a real definition
  // line (already filtered of comments), not in the skeleton's TODO block.
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_./:-]*)`/g)) terms.add(m[1]);

  return terms;
}

/* ------------------------------------------------------------------- commands */

function cmdDraft(root, out) {
  if (existsSync(out)) { console.error(`glossary: ${out} already exists — refusing to clobber. Edit it, or delete it first.`); return 2; }
  const { symbols, routes } = collect(root);

  // Group by source directory so the skeleton mirrors the codebase.
  const byDir = new Map();
  for (const [name, files] of [...symbols].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dir = dirname([...files][0]) === "." ? "<root>" : dirname([...files][0]);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }

  const lines = [
    "# CONTEXT.md — Domain Glossary",
    "",
    "Definitions describe what a term MEANS in the domain, not how it is implemented.",
    "Every row below was extracted from the code and still needs a definition.",
    "Delete terms that are not domain concepts (framework plumbing, DTOs, utilities).",
    "",
    `Generated from ${symbols.size} symbols and ${routes.size} routes. Every definition is a TODO.`,
    "",
  ];

  for (const [dir, names] of [...byDir].sort()) {
    lines.push(`## ${dir}`, "");
    for (const n of names) lines.push(`- **${n}** — <!-- TODO: what is this in the domain? what is it NOT? -->`);
    lines.push("");
  }

  if (routes.size) {
    lines.push("## HTTP surface", "");
    for (const [r] of [...routes].sort()) lines.push(`- **\`${r}\`** — <!-- TODO: what does this endpoint do, for whom? -->`);
    lines.push("");
  }

  lines.push("## Flagged", "", "<!-- Terms used two ways, or synonyms the project should stop using. -->", "");

  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`glossary: drafted ${out} — ${symbols.size} symbols, ${routes.size} routes, all definitions TODO.`);
  console.log("  Next: fill the definitions (a human or @oracle decides meaning), then delete");
  console.log("  non-domain rows, and run `glossary.mjs check` to confirm the gate is satisfiable.");
  return 0;
}

function cmdCheck(root) {
  const contextPath = join(root, "CONTEXT.md");
  const terms = documentedTerms(contextPath);
  if (terms === null) { console.error(`glossary: no CONTEXT.md at ${contextPath}. Run \`draft\` first.`); return 2; }

  const { symbols, routes } = collect(root);
  const missing = [];
  for (const name of [...symbols.keys()].sort()) {
    if (!terms.has(name)) missing.push(name);
  }

  const total = symbols.size + routes.size;
  if (!total) { console.log("glossary: no public domain symbols found in scope."); return 0; }

  if (!missing.length) {
    console.log(`glossary: all ${symbols.size} public symbols + ${routes.size} routes are documented in CONTEXT.md.`);
    return 0;
  }

  console.log(`glossary: ${missing.length}/${symbols.size} public symbols are NOT in CONTEXT.md\n`);
  for (const m of missing) {
    const files = [...symbols.get(m)].slice(0, 2).join(", ");
    console.log(`  ${m.padEnd(36)} ${files}`);
  }
  console.log("\nEach is a candidate for the Oracle Vocabulary Drift Gate. Either document it");
  console.log("in CONTEXT.md, or confirm it is plumbing and extract it out of glossary scope.");
  return 1;
}

/* ----------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
let root = process.cwd(), out = null, scope = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") root = argv[++i];
  else if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--scope") scope = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  else positional.push(argv[i]);
}
const cmd = positional[0];
out = out || join(root, "CONTEXT.md");

// A glossary describes the PROJECT's domain, not vendored tooling. Without an
// explicit scope the scan would pull symbols out of bundled third-party
// scripts and demand definitions for code the project does not own.
if (scope) {
  const roots = scope
    .map((s) => join(root, s))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  if (!roots.length) { console.error(`glossary: --scope matched no directories under ${root}`); process.exit(2); }

  const baseCollect = collect;   // capture BEFORE rebinding, or scopedCollect recurses into itself
  collect = () => {
    const merged = { symbols: new Map(), routes: new Map() };
    for (const dir of roots) {
      const part = baseCollect(dir);
      for (const [k, v] of part.symbols) {
        if (!merged.symbols.has(k)) merged.symbols.set(k, new Set());
        for (const f of v) merged.symbols.get(k).add(relative(root, join(dir, f)).split(sep).join("/"));
      }
      for (const [k, v] of part.routes) merged.routes.set(k, relative(root, join(dir, v)).split(sep).join("/"));
    }
    return merged;
  };
}

let code;
switch (cmd) {
  case "draft": code = cmdDraft(root, out); break;
  case "check": code = cmdCheck(root); break;
  default:
    console.log("glossary.mjs — CONTEXT.md bootstrap + vocabulary-drift check\n");
    console.log("  node glossary.mjs draft --root .            # skeleton from real symbols");
    console.log("  node glossary.mjs check --root .            # symbols missing from CONTEXT.md");
    code = 0;
}
process.exit(code);
