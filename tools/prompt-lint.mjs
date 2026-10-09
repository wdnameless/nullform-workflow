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
 *   sizes       — report prompt size budgets
 *   skills      — structural skill and reference validation (--json, --check)
 *
 * Escape hatch: put `prompt-lint:allow` anywhere on a line to exempt it.
 *
 * Zero dependencies. Node 18+ / Bun.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdSkills, auditSkills } from "./skill-audit.mjs";

export { auditSkills };

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
  // A prompt surface ships with '<HARNESS>'; a resolved path to the HARNESS ROOT in the
  // template means someone promoted a live copy back into the repo (or hand-edited one in).
  // On another host that path points nowhere.
  //
  // Scope is deliberately narrow. These are NOT flagged, because they are portable:
  //   - drive-letter paths and /home|/Users/<name> are host-specific -> FLAGGED
  //   - container-internal paths (/var/lib/postgresql/data), URLs, relative paths,
  //     /usr, /etc, /tmp -> legitimate documentation examples, NOT flagged.
  // A line can opt out with `prompt-lint:allow`.
  ["machine-abs-path", /(?:^|[\s"'(=:])(?:[A-Za-z]:[\\/]|\/(?:home|Users)\/[^\s"')]+)/g,
                       "machine-specific absolute path — ships broken on another host"],
  ["js-clock",       /\b(?:Date\.now|performance\.now)\s*\(/g,  "wall-clock read"],
  ["js-new-date",    /\bnew\s+Date\s*\(/g,                      "wall-clock read"],
  ["js-random",      /\bMath\.random\s*\(/g,                    "non-deterministic"],
  ["js-randomuuid",  /\brandomUUID\s*\(/g,                      "unique per render"],
  ["env-timestamp",  /\$\{?(?:CI_)?(?:TIMESTAMP|BUILD_DATE|NOW)\}?/g, "build-time value"],
];

/* ----------------------------------------------------------------- utilities */

const CLI_FLAGS = {
  "--root": { key: "root" },
  "--json": { bool: true, key: "json" },
  "--check": { bool: true, key: "check" },
  "-h": { bool: true, key: "help" },
  "--help": { bool: true, key: "help" },
};

function parseArgs(argv) {
  const out = { _: [], root: null, json: false, check: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const spec = CLI_FLAGS[name];

    if (!spec) {
      if (arg.startsWith("-")) {
        // Опечатка в флаге раньше становилась позиционным аргументом и молча
        // выключала проверку (`--chek` → обычный прогон без гейта).
        out.errors.push(`неизвестный флаг ${arg}`);
      } else {
        out._.push(arg);
      }
      continue;
    }

    if (spec.bool) {
      if (inline !== null) {
        out.errors.push(`флаг ${name} не принимает значение`);
        continue;
      }
      out[spec.key] = true;
      continue;
    }

    const value = inline !== null ? inline : argv[i + 1];
    if (value === undefined || (inline === null && value.startsWith("-"))) {
      out.errors.push(`флаг ${name} требует значение`);
      continue;
    }
    if (inline === null) i++;
    out[spec.key] = value;
  }
  return out;
}

/** Every `<dir>/<skill>/SKILL.md` under a skills root. */
function skillFilesIn(skillsDir) {
  const out = [];
  if (!existsSync(skillsDir)) return out;
  for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(skillsDir, d.name, "SKILL.md");
    if (existsSync(p)) out.push(p);
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

  // rules/ and skills/ ship from the repo tree too, and a resolved machine path in
  // them is the same defect as in agent/. Without these the tripwire only ever
  // guarded agent/ while the other two template kinds went unchecked.
  const rulesDir = join(root, "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir)) if (f.endsWith(".md")) push(join(rulesDir, f));
  }
  out.push(...skillFilesIn(join(root, "skills")));

  return out;
}

/** Surfaces installed outside the harness root (rules and skills). */
function collectInstalled(home) {
  const out = [];
  const rulesDir = join(home, ".agents", "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir)) if (f.endsWith(".md")) out.push(join(rulesDir, f));
  }
  out.push(...skillFilesIn(join(home, ".agents", "skills")));
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
const DEFAULT_BUDGETS = {
  always: { maxBytes: 16384, maxLines: 200 },
  "role-defs": { maxBytes: 65536, maxLines: 1200 },
  rules: { maxBytes: 16384, maxLines: 250 },
  skills: { maxBytes: 32768, maxLines: 400 },
};

export function parseSkillFrontmatterText(text) {
  // BOM в начале файла (частая реальность на Windows) ломает проверку `^---`,
  // из-за чего весь frontmatter молча считался пустым (0 байт вместо реального размера).
  const norm = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(norm);
  if (!m) return "";
  const lines = m[1].split("\n");
  const matched = [];
  for (const line of lines) {
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
      const key = line.slice(0, line.indexOf(":")).trim();
      if (key === "name" || key === "description") {
        matched.push(line);
      }
    }
  }
  return matched.length ? matched.join("\n") + "\n" : "";
}

/**
 * Применяет конфиг бюджетов к дефолтам. Всё, что не удалось применить,
 * попадает в `warnings`: молчаливая потеря операторского бюджета — ложный зелёный.
 */
function mergeBudgets(target, source, label, warnings) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    warnings.push(`${label}: ожидался объект с группами бюджетов — ignored`);
    return;
  }
  for (const [group, conf] of Object.entries(source)) {
    if (!target[group]) {
      warnings.push(`${label}: неизвестная группа '${group}' — ignored`);
      continue;
    }
    if (!conf || typeof conf !== "object" || Array.isArray(conf)) {
      warnings.push(`${label}: группа '${group}' должна быть объектом — ignored`);
      continue;
    }
    for (const key of ["maxBytes", "maxLines"]) {
      const value = conf[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        warnings.push(`${label}: ${group}.${key} должен быть неотрицательным числом, получено ${JSON.stringify(value)} — ignored`);
        continue;
      }
      target[group][key] = value;
    }
  }
}

export function collectSizes(root, home, customBudgets = null) {
  const baseRoot = root || process.cwd();
  const userHome = home || process.env.USERPROFILE || process.env.HOME || "";

  let mergedBudgets = {
    always: { ...DEFAULT_BUDGETS.always },
    "role-defs": { ...DEFAULT_BUDGETS["role-defs"] },
    rules: { ...DEFAULT_BUDGETS.rules },
    skills: { ...DEFAULT_BUDGETS.skills },
  };

  const warnings = [];
  const budgetFile = join(baseRoot, ".prompt-lint", "budget.json");
  if (existsSync(budgetFile)) {
    try {
      mergeBudgets(mergedBudgets, JSON.parse(readFileSync(budgetFile, "utf8")), ".prompt-lint/budget.json", warnings);
    } catch (err) {
      warnings.push(`.prompt-lint/budget.json: некорректный JSON (${err.message}) — ignored, применены дефолтные бюджеты`);
    }
  }

  if (customBudgets) {
    mergeBudgets(mergedBudgets, customBudgets, "customBudgets", warnings);
  }

  const groups = {
    always: { bytes: 0, lines: 0, files: [] },
    "role-defs": { bytes: 0, lines: 0, files: [] },
    rules: { bytes: 0, lines: 0, files: [] },
    skills: { bytes: 0, lines: 0, files: [] },
  };

  // 1. always: agent/AGENTS.md
  const agentsMd = join(baseRoot, "agent", "AGENTS.md");
  if (existsSync(agentsMd)) {
    const content = readText(agentsMd);
    const bytes = Buffer.byteLength(content, "utf8");
    const lines = content.length === 0 ? 0 : content.split("\n").length;
    groups.always.bytes += bytes;
    groups.always.lines += lines;
    groups.always.files.push(agentsMd);
  }

  // 2. role-defs: agent/agents/*.md
  const agentsDir = join(baseRoot, "agent", "agents");
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const p = join(agentsDir, f);
      const content = readText(p);
      const bytes = Buffer.byteLength(content, "utf8");
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      groups["role-defs"].bytes += bytes;
      groups["role-defs"].lines += lines;
      groups["role-defs"].files.push(p);
    }
  }

  // 3. rules: root/rules or ~/.agents/rules
  const rootRulesDir = join(baseRoot, "rules");
  const homeRulesDir = userHome ? join(userHome, ".agents", "rules") : null;
  const chosenRulesDir = existsSync(rootRulesDir) ? rootRulesDir : (homeRulesDir && existsSync(homeRulesDir) ? homeRulesDir : null);
  if (chosenRulesDir) {
    const files = readdirSync(chosenRulesDir).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const p = join(chosenRulesDir, f);
      const content = readText(p);
      const bytes = Buffer.byteLength(content, "utf8");
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      groups.rules.bytes += bytes;
      groups.rules.lines += lines;
      groups.rules.files.push(p);
    }
  }

  // 4. skills: root/skills or ~/.agents/skills (frontmatter name + description only)
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
        const content = readText(p);
        const fm = parseSkillFrontmatterText(content);
        const bytes = Buffer.byteLength(fm, "utf8");
        const lines = fm ? fm.split("\n").filter(Boolean).length : 0;
        groups.skills.bytes += bytes;
        groups.skills.lines += lines;
        groups.skills.files.push(p);
      }
    }
  }

  const results = {};
  let ok = true;

  for (const groupName of ["always", "role-defs", "rules", "skills"]) {
    const data = groups[groupName];
    const budget = mergedBudgets[groupName];
    const groupOk = data.bytes <= budget.maxBytes && data.lines <= budget.maxLines;
    if (!groupOk) ok = false;
    results[groupName] = {
      bytes: data.bytes,
      maxBytes: budget.maxBytes,
      lines: data.lines,
      maxLines: budget.maxLines,
      ok: groupOk,
      fileCount: data.files.length,
    };
  }

  return { ok, groups: results, warnings };
}

function cmdSizes(root, home, asJson, checkMode) {
  const res = collectSizes(root, home);

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("prompt-lint: prompt size budget analysis\n");
    for (const [group, info] of Object.entries(res.groups)) {
      const kb = (info.bytes / 1024).toFixed(1);
      const maxKb = (info.maxBytes / 1024).toFixed(1);
      const status = info.ok ? "OK" : "EXCEEDED";
      const bStr = `${kb} KB / max ${maxKb} KB`;
      const lStr = `${info.lines} lines / max ${info.maxLines} lines`;
      console.log(`  ${group.padEnd(12)} ${bStr.padEnd(25)} ${lStr.padEnd(25)} ${status}`);
    }
    if (!res.ok) {
      console.log("\nSome prompt size budgets were exceeded.");
    }
  }

  for (const w of res.warnings || []) {
    console.error(`prompt-lint: ${w}`);
  }
  // Неприменённый конфиг бюджетов — не молчаливый зелёный: сообщаем и падаем.
  if ((res.warnings || []).length > 0) {
    return 2;
  }

  if (checkMode && !res.ok) {
    return 1;
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
  const installed = new Set(collectInstalled(home));
  const files = [...collectSurfaces(root), ...collectInstalled(home)];
  let hits = 0;
  const perFile = [];

  for (const f of files) {
    // The installer deliberately substitutes <HARNESS> with this machine's
    // absolute path. A UUID-like segment in a sandbox/user path is not volatile
    // prompt content: it is the stable install root for that installation.
    const normalised = normaliseHarnessRoot(readText(f), root);
    const lines = normalised.split("\n");
    const found = [];
    // A path that survives normalisation is a defect only in a TEMPLATE surface (the
    // repo tree, which ships to other hosts). An installed copy under ~/.agents holds
    // the resolved path by design — flagging it would make every install fail.
    const isTemplate = !installed.has(f);
    lines.forEach((line, i) => {
      if (line.includes("prompt-lint:allow")) return;
      // Fenced code blocks are illustrative, not injected text — but only skip
      // when the pattern looks like an example we deliberately show.
      for (const [name, re, why] of VOLATILE) {
        // Two scopes of pattern:
        //   machine-abs-path — only a defect in a TEMPLATE surface; an installed copy
        //     under ~/.agents holds the resolved path by design.
        //   js-clock/js-random — a wall-clock or random call inside a third-party
        //     skill's example code (an animation snippet) is documentation, not
        //     prompt content. Scanning installed copies for it fails the audit for
        //     skills we do not ship.
        const templateOnly = name === "machine-abs-path";
        const runtimeExample = name === "js-clock" || name === "js-new-date" ||
                               name === "js-random" || name === "js-randomuuid";
        if (!isTemplate && (templateOnly || runtimeExample)) continue;
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
  let base;
  try {
    base = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`prompt-lint: baseline is unreadable (${err.message}). Re-run \`baseline\`.`);
    return 2;
  }
  if (!base || typeof base !== "object" || !base.surfaces || typeof base.surfaces !== "object") {
    console.error(`prompt-lint: baseline is corrupt (missing "surfaces" object). Re-run \`baseline\`.`);
    return 2;
  }
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

  if (args.errors.length > 0) {
    for (const err of args.errors) {
      console.error(`prompt-lint: ${err}.`);
    }
    printUsage();
    return 2;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  // Несуществующий --root раньше молча давал зелёный результат по чужому дереву
  // (или по пустому набору поверхностей) — для гейта это ложный зелёный.
  if (args.root && !(existsSync(root) && statSync(root).isDirectory())) {
    console.error(`prompt-lint: --root '${args.root}' is not an existing directory.`);
    return 2;
  }

  switch (args._[0]) {
    case "scan":        return cmdScan(root, home);
    case "baseline":    return cmdBaseline(root, home);
    case "check":       return cmdCheck(root, home);
    case "fingerprint": return cmdFingerprint(root, home, args.json);
    case "sizes":       return cmdSizes(root, home, args.json, args.check);
    case "skills":      return cmdSkills(root, home, args.json, args.check);
    case undefined:     printUsage();
                        return 0;
    default:
      console.error(`prompt-lint: unknown command '${args._[0]}'.`);
      printUsage();
      return 1;
  }
}

function printUsage() {
  console.log("prompt-lint.mjs — prompt-cache safety\n");
  console.log("  node prompt-lint.mjs scan        --root <harness>   # volatile literals");
  console.log("  node prompt-lint.mjs baseline    --root <harness>   # record golden hashes");
  console.log("  node prompt-lint.mjs check       --root <harness>   # fail on drift");
  console.log("  node prompt-lint.mjs fingerprint --root <harness> [--json] # layered fingerprints");
  console.log("  node prompt-lint.mjs sizes       --root <harness> [--json] [--check] # size budgets");
  console.log("  node prompt-lint.mjs skills      --root <harness> [--json] [--check] # structural skill audit");
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main();
}
