#!/usr/bin/env node
/**
 * prompt-lint.mjs — prompt-cache safety for the harness.
 *
 * Provider prompt caches are exact BYTE-PREFIX matches over the rendered
 * request. Two things destroy that prefix and silently re-bill the whole
 * session at full price:
 *
 *   1. VOLATILE CONTENT baked into a prompt surface. A literal date, timestamp,
 *      UUID, or random value in an agent file / rule / skill means the prefix
 *      differs on every render.
 *   2. AN EDIT to a prompt surface mid-session. Byte-prefix stability breaks at
 *      that point and every subsequent turn misses the cache.
 *
 * Commands:
 *   scan        — report volatile literals in prompt surfaces (no state needed)
 *   baseline    — record golden hashes of every surface
 *   check       — fail if a surface drifted from the baseline
 *   fingerprint — layered deterministic prompt fingerprints (--json, fixed keys)
 *
 * Escape hatch: put `prompt-lint:allow` anywhere on a line to exempt it.
 *
 * Zero dependencies. Node 18+ / Bun.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_DIR = ".prompt-lint";
const BASELINE = "baseline.json";

/* ------------------------------------------------------------------ patterns */

// Each entry: [label, regex, why]. Ordered most-specific first so the report
// names the real cause rather than a sub-match.
const VOLATILE = [
  ["iso-timestamp",  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g,      "renders differently every session"],
  ["today-literal",  /\btoday\s+is\s+\d{4}-\d{2}-\d{2}/gi,     "hardcoded current date"],
  ["uuid",           /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "unique per render"],
  ["long-hex",       /\b[0-9a-f]{16,}\b/g,                      "hash/id — verify it is a stable example, not generated"],
  ["js-clock",       /\b(?:Date\.now|performance\.now)\s*\(/g,  "wall-clock read"],
  ["js-new-date",    /\bnew\s+Date\s*\(/g,                      "wall-clock read"],
  ["js-random",      /\bMath\.random\s*\(/g,                    "non-deterministic"],
  ["js-randomuuid",  /\brandomUUID\s*\(/g,                      "unique per render"],
  ["env-timestamp",  /\$\{?(?:CI_)?(?:TIMESTAMP|BUILD_DATE|NOW)\}?/g, "build-time value"],
];

/* ----------------------------------------------------------------- utilities */

function parseArgs(argv) {
  const out = { _: [], root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = argv[++i];
    else if (argv[i] === "--json") out.json = true;
    else out._.push(argv[i]);
  }
  return out;
}

/** Prompt surfaces, in the order OMP loads them. */
function collectSurfaces(root) {
  const out = [];
  const push = (p) => { if (existsSync(p)) out.push(p); };

  push(join(root, "agent", "AGENTS.md"));

  const agentsDir = join(root, "agent", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith(".md")) push(join(agentsDir, f));
    }
  }
  return out;
}

/** Surfaces installed outside the harness root (rules and skills). */
function collectInstalled(home) {
  const out = [];
  const rulesDir = join(home, ".agents", "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir)) if (f.endsWith(".md")) out.push(join(rulesDir, f));
  }
  const skillsDir = join(home, ".agents", "skills");
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(skillsDir, d.name, "SKILL.md");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function readText(p) {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

function sha(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function label(root, p) {
  const rel = relative(root, p);
  return rel.startsWith("..") ? p : rel.split(sep).join("/");
}

/** Collect deterministic four layers from sorted files */
export function collectFingerprint(root, home) {
  const baseRoot = root || process.cwd();
  const userHome = home || process.env.USERPROFILE || process.env.HOME || "";

  const toRel = (p) => {
    const rel = relative(baseRoot, p);
    return rel.split(sep).join("/");
  };

  const layerMap = {
    baseInstructions: [],
    agentRoles: [],
    rules: [],
    skills: [],
  };

  // 1. baseInstructions: agent/AGENTS.md
  const agentsMd = join(baseRoot, "agent", "AGENTS.md");
  if (existsSync(agentsMd)) {
    layerMap.baseInstructions.push(agentsMd);
  }

  // 2. agentRoles: agent/agents/*.md sorted
  const agentsDir = join(baseRoot, "agent", "agents");
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      layerMap.agentRoles.push(join(agentsDir, f));
    }
  }

  // 3. rules: root/rules or ~/.agents/rules sorted; prefer root for repo command
  const rootRulesDir = join(baseRoot, "rules");
  const homeRulesDir = userHome ? join(userHome, ".agents", "rules") : null;
  const chosenRulesDir = existsSync(rootRulesDir) ? rootRulesDir : (homeRulesDir && existsSync(homeRulesDir) ? homeRulesDir : null);
  if (chosenRulesDir) {
    const files = readdirSync(chosenRulesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      layerMap.rules.push(join(chosenRulesDir, f));
    }
  }

  // 4. skills: root/skills or ~/.agents/skills sorted; prefer root for repo command
  const rootSkillsDir = join(baseRoot, "skills");
  const homeSkillsDir = userHome ? join(userHome, ".agents", "skills") : null;
  const chosenSkillsDir = existsSync(rootSkillsDir) ? rootSkillsDir : (homeSkillsDir && existsSync(homeSkillsDir) ? homeSkillsDir : null);
  if (chosenSkillsDir) {
    const dirs = readdirSync(chosenSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const d of dirs) {
      const p = join(chosenSkillsDir, d, "SKILL.md");
      if (existsSync(p)) {
        layerMap.skills.push(p);
      }
    }
  }

  const layers = {};
  const allFiles = [];

  for (const layerName of ["baseInstructions", "agentRoles", "rules", "skills"]) {
    const fileList = layerMap[layerName];
    const layerEntries = [];
    let combinedSha = "";
    const hasher = createHash("sha256");

    for (const filePath of fileList) {
      const content = readText(filePath);
      const fileSha = sha(content);
      const relPath = toRel(filePath);
      const entry = {
        layer: layerName,
        path: relPath,
        sha: fileSha,
      };
      layerEntries.push(entry);
      allFiles.push(entry);
      hasher.update(content, "utf8");
    }
    combinedSha = layerEntries.length > 0 ? hasher.digest("hex").slice(0, 16) : "";
    layers[layerName] = {
      sha: combinedSha,
      count: layerEntries.length,
    };
  }

  const compositeHasher = createHash("sha256");
  for (const layerName of ["baseInstructions", "agentRoles", "rules", "skills"]) {
    compositeHasher.update(`${layerName}:${layers[layerName].sha}\n`, "utf8");
  }
  const compositeSha = compositeHasher.digest("hex").slice(0, 16);

  return {
    version: 1,
    combined: compositeSha,
    compositeSha,
    layers,
    files: allFiles,
  };
}

function cmdFingerprint(root, home, asJson) {
  const res = collectFingerprint(root, home);
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`prompt-lint fingerprint: ${res.compositeSha}`);
    for (const [layer, info] of Object.entries(res.layers)) {
      console.log(`  ${layer.padEnd(18)} sha:${info.sha || "none"} count:${info.count}`);
    }
    console.log(`\nFiles (${res.files.length}):`);
    for (const f of res.files) {
      console.log(`  [${f.layer}] ${f.path} (${f.sha})`);
    }
  }
  return 0;
}

/* -------------------------------------------------------------------- command */

function normaliseHarnessRoot(text, root) {
  if (!root) return text;
  const slash = root.split("\\").join("/");
  return text.split(root).join("<HARNESS>").split(slash).join("<HARNESS>");
}

function cmdScan(root, home) {
  const files = [...collectSurfaces(root), ...collectInstalled(home)];
  let hits = 0;
  const perFile = [];

  for (const f of files) {
    // The installer deliberately substitutes <HARNESS> with this machine's
    // absolute path. A UUID-like segment in a sandbox/user path is not volatile
    // prompt content: it is the stable install root for that installation.
    const lines = normaliseHarnessRoot(readText(f), root).split("\n");
    const found = [];
    lines.forEach((line, i) => {
      if (line.includes("prompt-lint:allow")) return;
      // Fenced code blocks are illustrative, not injected text — but only skip
      // when the pattern looks like an example we deliberately show.
      for (const [name, re, why] of VOLATILE) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) found.push({ line: i + 1, name, sample: m[0].slice(0, 48), why });
      }
    });
    if (found.length) { hits += found.length; perFile.push({ file: label(root, f), found }); }
  }

  if (!hits) {
    console.log(`prompt-lint: no volatile literals in ${files.length} prompt surfaces.`);
    return 0;
  }

  console.log(`prompt-lint: ${hits} volatile literal(s) across ${perFile.length} file(s)\n`);
  for (const { file, found } of perFile) {
    console.log(`  ${file}`);
    for (const h of found) {
      console.log(`    ${String(h.line).padStart(5)}  ${h.name.padEnd(14)} ${JSON.stringify(h.sample)}  — ${h.why}`);
    }
  }
  console.log("\nExempt a legitimate example with `prompt-lint:allow` on its line.");
  return 1;
}

function cmdBaseline(root, home) {
  const files = [...collectSurfaces(root), ...collectInstalled(home)];
  const surfaces = {};
  for (const f of files) surfaces[label(root, f)] = sha(readText(f));

  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BASELINE), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    surfaces,
  }, null, 2));

  console.log(`prompt-lint: baseline written for ${files.length} surfaces.`);
  console.log(`  Any edit to these files now invalidates provider prompt caches once.`);
  return 0;
}

function cmdCheck(root, home) {
  const p = join(root, STATE_DIR, BASELINE);
  if (!existsSync(p)) {
    console.error("prompt-lint: no baseline. Run `baseline` first.");
    return 2;
  }
  const base = JSON.parse(readFileSync(p, "utf8"));
  const files = [...collectSurfaces(root), ...collectInstalled(home)];
  const current = {};
  for (const f of files) current[label(root, f)] = sha(readText(f));

  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(current)) {
    if (!(k in base.surfaces)) added.push(k);
    else if (base.surfaces[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(base.surfaces)) if (!(k in current)) removed.push(k);

  if (!changed.length && !added.length && !removed.length) {
    console.log(`prompt-lint: ${files.length} prompt surfaces match the baseline.`);
    return 0;
  }

  console.log("prompt-lint: prompt surfaces drifted from baseline\n");
  for (const c of changed) console.log(`  CHANGED  ${c}`);
  for (const a of added)   console.log(`  ADDED    ${a}`);
  for (const r of removed) console.log(`  REMOVED  ${r}`);
  console.log("\nEach changed surface invalidates provider prompt caches once for every");
  console.log("live session. If the edit is intentional, re-run `baseline` and commit");
  console.log("the updated .prompt-lint/baseline.json so the change is visible in review.");
  return 1;
}

/* ----------------------------------------------------------------------- main */

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = args.root || process.cwd();
  const home = process.env.USERPROFILE || process.env.HOME || "";
  switch (args._[0]) {
    case "scan":        return cmdScan(root, home);
    case "baseline":    return cmdBaseline(root, home);
    case "check":       return cmdCheck(root, home);
    case "fingerprint": return cmdFingerprint(root, home, args.json);
    default:
      console.log("prompt-lint.mjs — prompt-cache safety\n");
      console.log("  node prompt-lint.mjs scan        --root <harness>   # volatile literals");
      console.log("  node prompt-lint.mjs baseline    --root <harness>   # record golden hashes");
      console.log("  node prompt-lint.mjs check       --root <harness>   # fail on drift");
      console.log("  node prompt-lint.mjs fingerprint --root <harness> [--json] # layered fingerprints");
      return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
