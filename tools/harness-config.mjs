#!/usr/bin/env node
/**
 * tools/harness-config.mjs — Preservation, preflighting, and managed block utilities
 * for cross-harness adapter configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

export const MANAGED_START = "<!-- BEGIN NULLFORM WORKFLOW -->";
export const MANAGED_END = "<!-- END NULLFORM WORKFLOW -->";
export const RUNTIME_PARSER_DEPS = Object.freeze(["yaml", "json5", "jsonc-parser"]);

const loadedModules = new Map();

function isWithinOrPrefix(candidatePath, baseRoot) {
  const normBase = resolve(baseRoot);
  const allowedRoots = [normBase];
  if (basename(dirname(normBase)) === "node_modules") {
    allowedRoots.push(dirname(normBase));
  }
  for (const root of allowedRoots) {
    const rel = relative(root, resolve(candidatePath));
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Resolves the physical package directory for a runtime parser dependency
 * from the current source/installed package without escaping into unrelated user libraries.
 */
export function resolveRuntimePackageDir(name, baseRoot = REPO_ROOT) {
  const roots = [resolve(baseRoot)];
  if (resolve(baseRoot) !== REPO_ROOT) roots.push(REPO_ROOT);

  const directCandidates = [];
  for (const r of roots) {
    directCandidates.push(join(r, "tools", "node_modules", name), join(r, "node_modules", name));
    if (basename(dirname(r)) === "node_modules") {
      directCandidates.push(join(dirname(r), name));
    }
  }
  for (const dir of directCandidates) {
    if (existsSync(join(dir, "package.json"))) return dir;
  }

  for (const r of roots) {
    const pkgJson = join(r, "package.json");
    if (!existsSync(pkgJson)) continue;
    try {
      const req = createRequire(pkgJson);
      const entry = req.resolve(name);
      let cur = dirname(entry);
      while (cur && cur !== dirname(cur)) {
        const pj = join(cur, "package.json");
        if (existsSync(pj)) {
          const parsed = JSON.parse(readFileSync(pj, "utf8"));
          if (parsed?.name === name && isWithinOrPrefix(cur, r)) return cur;
        }
        cur = dirname(cur);
      }
    } catch {}
  }
  for (const r of roots) {
    const altFile = join(r, ".git", "objects", "info", "alternates");
    if (existsSync(altFile)) {
      try {
        const altLine = readFileSync(altFile, "utf8").split(/\r?\n/)[0]?.trim().replace(/^\\\\\?\\/, "");
        if (altLine) {
          const altPkg = join(resolve(altLine, "..", ".."), "node_modules", name);
          if (existsSync(join(altPkg, "package.json"))) return altPkg;
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Robust runtime loader for packages (yaml, json5, jsonc-parser) from current package.
 */
function loadRuntimeModule(name) {
  if (loadedModules.has(name)) return loadedModules.get(name);
  const pkgDir = resolveRuntimePackageDir(name, REPO_ROOT);
  if (pkgDir) {
    try {
      const req = createRequire(join(pkgDir, "package.json"));
      const mod = req(pkgDir);
      loadedModules.set(name, mod);
      return mod;
    } catch {}
  }
  try {
    const req = createRequire(join(REPO_ROOT, "tools", "harness-config.mjs"));
    const mod = req(name);
    loadedModules.set(name, mod);
    return mod;
  } catch {}

  throw new Error(`Preflight failed: runtime dependency '${name}' not found`);
}

export function loadYaml() {
  return loadRuntimeModule("yaml");
}

export function loadJson5() {
  return loadRuntimeModule("json5");
}

export function loadJsonc() {
  return loadRuntimeModule("jsonc-parser");
}
/**
 * Extracts a safe line/col error location without leaking document contents or secrets.
 */
export function safeJsonErrorMessage(err) {
  if (!err) return "syntax error";
  const msg = String(err.message || "");
  const lineMatch = msg.match(/line (\d+)(?:.*?column (\d+))?/i);
  if (lineMatch) {
    return `syntax error at line ${lineMatch[1]}${lineMatch[2] ? `, column ${lineMatch[2]}` : ""}`;
  }
  const posMatch = msg.match(/at position (\d+)/i);
  if (posMatch) {
    return `syntax error at position ${posMatch[1]}`;
  }
  return "syntax error";
}

/**
 * Extracts a safe JSON5 error location without leaking document contents.
 */
export function safeJson5ErrorMessage(err) {
  if (!err) return "syntax error";
  if (err.lineNumber) {
    return `syntax error at line ${err.lineNumber}${err.columnNumber ? `, column ${err.columnNumber}` : ""}`;
  }
  return safeJsonErrorMessage(err);
}

/**
 * Extracts a safe JSONC error location (code, line, column) without leaking document contents.
 */
export function safeJsoncErrorMessage(content, err, jsonc) {
  if (!err || typeof err !== "object") return "syntax error";
  const code =
    typeof jsonc?.printParseErrorCode === "function" && typeof err.error === "number"
      ? jsonc.printParseErrorCode(err.error)
      : "syntax error";
  if (typeof content === "string" && typeof err.offset === "number" && err.offset >= 0) {
    const prefix = content.slice(0, err.offset);
    const lines = prefix.split(/\r?\n/);
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    return `syntax error ${code} at line ${line}, column ${col}`;
  }
  return `syntax error (${code})`;
}
/**
 * Reads a text file safely, validating existence and stripping BOM/nulls.
 */
function readSafeText(filePath, formatName) {
  if (!filePath || !existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  if (content.includes("\0")) {
    throw new Error(`Preflight failed: binary or null characters in ${formatName} file ${filePath}`);
  }
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Preflights a JSON configuration file.
 * Validates mapping/object structure, strips BOM, and hides sensitive source fragments.
 */
export function preflightJsonConfig(filePath) {
  const content = readSafeText(filePath, "JSON");
  if (content === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Preflight failed: malformed JSON in ${filePath} (${safeJsonErrorMessage(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Preflight failed: JSON config in ${filePath} must be an object mapping`);
  }
  return parsed;
}

/**
 * Preflights a JSONC configuration file (e.g. OpenCode opencode.json / opencode.jsonc).
 * Uses jsonc-parser with allowTrailingComma: true, checking the errors array strictly.
 */
export function preflightJsoncConfig(filePath) {
  const content = readSafeText(filePath, "JSONC");
  if (content === null) return null;
  const jsonc = loadJsonc();
  const errors = [];
  let parsed;
  try {
    parsed = jsonc.parse(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: false,
    });
  } catch (err) {
    throw new Error(`Preflight failed: malformed JSONC in ${filePath} (${safeJsonErrorMessage(err)})`);
  }
  if (errors.length > 0) {
    throw new Error(
      `Preflight failed: malformed JSONC in ${filePath} (${safeJsoncErrorMessage(content, errors[0], jsonc)})`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Preflight failed: JSONC config in ${filePath} must be an object mapping`);
  }
  return parsed;
}

/**
 * Returns OpenCode config file target(s) in a directory, respecting existing opencode.jsonc
 * so it is never shadowed by a newly created opencode.json.
 */
export function resolveOpencodeConfigPaths(dir) {
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  const hasJson = existsSync(jsonPath);
  const hasJsonc = existsSync(jsoncPath);
  if (hasJson && hasJsonc) return [jsonPath, jsoncPath];
  if (hasJsonc) return [jsoncPath];
  return [jsonPath];
}
/**
 * Preflights a JSON5 configuration file (e.g. OpenClaw).
 * Accepts comments, trailing commas, and unquoted keys.
 */
export function preflightJson5Config(filePath) {
  const content = readSafeText(filePath, "JSON5");
  if (content === null) return null;
  const JSON5 = loadJson5();
  let parsed;
  try {
    parsed = JSON5.parse(content);
  } catch (err) {
    throw new Error(`Preflight failed: malformed JSON5 in ${filePath} (${safeJson5ErrorMessage(err)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Preflight failed: JSON5 config in ${filePath} must be an object mapping`);
  }
  return parsed;
}

/**
 * Preflights a YAML configuration file using real yaml parseDocument.
 * Validates syntax, anchors, multiline strings, and mapping structure.
 */
export function preflightYamlConfig(filePath) {
  const content = readSafeText(filePath, "YAML");
  if (content === null) return null;
  const yaml = loadYaml();
  let doc;
  try {
    doc = yaml.parseDocument(content, { keepSourceTokens: true });
  } catch {
    throw new Error(`Preflight failed: malformed YAML in ${filePath} (syntax error)`);
  }
  if (doc.errors && doc.errors.length > 0) {
    const err = doc.errors[0];
    const line = err.linePos?.[0]?.line;
    const col = err.linePos?.[0]?.col;
    const posMsg = line ? `at line ${line}${col ? `, column ${col}` : ""}` : "syntax error";
    throw new Error(`Preflight failed: malformed YAML in ${filePath} (${posMsg})`);
  }
  if (content.trim() !== "") {
    const js = doc.toJS();
    if (js === null || typeof js !== "object" || Array.isArray(js)) {
      throw new Error(`Preflight failed: YAML config in ${filePath} must be a mapping/object`);
    }
  }
  return content;
}

/**
 * Validates that managed delimiters in a markdown file are well-formed.
 */
export function preflightManagedMarkers(filePath, content) {
  if (!content) return;
  const hasStart = content.includes(MANAGED_START);
  const hasEnd = content.includes(MANAGED_END);
  if (!hasStart && !hasEnd) return;

  const startCount = (content.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  const endCount = (content.match(new RegExp(MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Preflight failed: malformed managed markers in ${filePath} (mismatched or duplicate delimiters)`);
  }
  const startIdx = content.indexOf(MANAGED_START);
  const endIdx = content.indexOf(MANAGED_END);
  if (startIdx > endIdx) {
    throw new Error(`Preflight failed: malformed managed markers in ${filePath} (end marker precedes start marker)`);
  }
}

/**
 * Extracts the content of the workflow-owned managed section from a markdown file.
 * Returns null if no delimiters are present.
 * Validates that markers are well-formed (fails closed on malformed markers).
 */
export function extractManagedSection(content, filePath = "markdown") {
  if (!content) return null;
  const hasStart = content.includes(MANAGED_START);
  const hasEnd = content.includes(MANAGED_END);
  if (!hasStart && !hasEnd) return null;
  preflightManagedMarkers(filePath, content);
  const startIdx = content.indexOf(MANAGED_START);
  const endIdx = content.indexOf(MANAGED_END);
  return content.slice(startIdx + MANAGED_START.length, endIdx).trim();
}

/**
 * Preflights all existing configuration and instruction files before any writes occur.
 */
export function preflightAllConfigs({ harnesses, targetRoot, projectRoot, userHome }) {
  const configsToPreflight = [];
  const markdownsToPreflight = [];

  for (const h of harnesses) {
    const is = (target) => h === target || h === "all";
    if (is("claude")) markdownsToPreflight.push(join(targetRoot, "CLAUDE.md"), join(userHome, ".claude", "CLAUDE.md"));
    if (is("codex")) markdownsToPreflight.push(join(targetRoot, "AGENTS.md"), join(userHome, ".codex", "AGENTS.md"));
    if (is("opencode")) {
      for (const dir of [targetRoot, join(userHome, ".config", "opencode"), join(userHome, ".opencode")]) {
        configsToPreflight.push({ path: join(dir, "opencode.json"), type: "jsonc" }, { path: join(dir, "opencode.jsonc"), type: "jsonc" });
        markdownsToPreflight.push(join(dir, "AGENTS.md"));
      }
    }
    if (is("cursor")) {
      const cursorBase = projectRoot || targetRoot;
      markdownsToPreflight.push(join(cursorBase, ".cursor", "rules", "00-workflow.mdc"), join(userHome, ".cursor", "rules", "00-workflow.mdc"));
      if (cursorBase !== targetRoot) markdownsToPreflight.push(join(targetRoot, ".cursor", "rules", "00-workflow.mdc"));
    }
    if (is("openclaw")) {
      configsToPreflight.push({ path: join(targetRoot, "openclaw.json"), type: "json5" }, { path: join(userHome, ".openclaw", "openclaw.json"), type: "json5" });
      markdownsToPreflight.push(join(targetRoot, "AGENTS.md"), join(targetRoot, "SOUL.md"), join(targetRoot, "USER.md"), join(userHome, ".openclaw", "AGENTS.md"));
    }
    if (is("hermes")) {
      configsToPreflight.push({ path: join(targetRoot, "config.yaml"), type: "yaml" }, { path: join(userHome, ".hermes", "config.yaml"), type: "yaml" });
      if (process.env.HERMES_HOME) configsToPreflight.push({ path: join(process.env.HERMES_HOME, "config.yaml"), type: "yaml" });
      markdownsToPreflight.push(join(targetRoot, "AGENTS.md"), join(userHome, ".hermes", "SOUL.md"), join(userHome, ".hermes", "AGENTS.md"));
    }
    if (is("openhuman")) {
      markdownsToPreflight.push(join(targetRoot, "AGENTS.md"), join(targetRoot, "agents", "workflow", "AGENTS.md"), join(userHome, ".openhuman", "AGENTS.md"));
    }
    if (is("omp")) {
      configsToPreflight.push({ path: join(userHome, ".omp", "agent", "mcp.json"), type: "json" });
      markdownsToPreflight.push(join(targetRoot, "agent", "AGENTS.md"), join(userHome, ".omp", "agent", "AGENTS.md"));
    }
  }

  const preflighters = { json: preflightJsonConfig, jsonc: preflightJsoncConfig, json5: preflightJson5Config, yaml: preflightYamlConfig };
  for (const item of configsToPreflight) {
    if (existsSync(item.path)) preflighters[item.type]?.(item.path);
  }

  for (const mdPath of markdownsToPreflight) {
    if (existsSync(mdPath)) preflightManagedMarkers(mdPath, readFileSync(mdPath, "utf8"));
  }
}

/**
 * Safely inserts or replaces a workflow-owned managed block in a markdown file.
 * Preserves unrelated user instructions, comments, and rules.
 * Migrates exact prior known adapter content while preserving appended human content.
 * Never deletes content based on heuristic headings.
 */
export function applyManagedSection(existingContent, newManagedContent, defaultPrefix = "", legacyPrefixes = []) {
  const trimmedManaged = newManagedContent.trim();
  const managedBlock = `${MANAGED_START}\n${trimmedManaged}\n${MANAGED_END}`;

  if (!existingContent || existingContent.trim() === "") {
    const prefix = defaultPrefix ? defaultPrefix.trimEnd() + "\n\n" : "";
    return `${prefix}${managedBlock}\n`;
  }

  const hasStart = existingContent.includes(MANAGED_START);
  const hasEnd = existingContent.includes(MANAGED_END);

  if (hasStart || hasEnd) {
    const startCount = (existingContent.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const endCount = (existingContent.match(new RegExp(MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const startIdx = existingContent.indexOf(MANAGED_START);
    const endIdx = existingContent.indexOf(MANAGED_END);

    if (startCount !== 1 || endCount !== 1 || startIdx > endIdx) {
      throw new Error("Malformed managed markers: mismatched or duplicate delimiters");
    }

    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + MANAGED_END.length);
    return `${before}${managedBlock}${after}`;
  }

  // Check for explicit caller-provided legacy prefixes
  for (const legacyPrefix of legacyPrefixes) {
    if (typeof legacyPrefix === "string" && legacyPrefix.length > 0 && existingContent.startsWith(legacyPrefix)) {
      const appended = existingContent.slice(legacyPrefix.length).trimStart();
      const prefix = defaultPrefix ? defaultPrefix.trimEnd() + "\n\n" : "";
      return appended ? `${prefix}${managedBlock}\n\n${appended}` : `${prefix}${managedBlock}\n`;
    }
  }

  // Exact prior known un-marked markdown adapter / law block migration
  const legacyBlockRules = [
      {
        matchStart: s => {
          const text = s.replace(/\r\n/g, '\n');
          const match = /^# ([^\n]+)\n\nПолный свод законов и протокол оркестратора: ([^\n]+)\/agent\/AGENTS\.md\n/.exec(text);
          return Boolean(match && text.startsWith(getMarkdownAdapter(match[2], match[1]).trimEnd()));
        },
        endMarker: '- Возвратный контракт (≤25 строк): STATUS | FILES | TESTS было->стало | CONCERNS.',
      },
      {
        matchStart: s => (() => { const text = s.replace(/\r\n/g, '\n'), known = trimmedManaged.replace(/\r\n/g, '\n'); const pattern = /^Full protocol: `([^`\n]+)\/agent\/agents\/orchestrator\.md`/m; const oldRoot = pattern.exec(text)?.[1], newRoot = pattern.exec(known)?.[1]; return Boolean(oldRoot && newRoot && text.startsWith(known.split(newRoot).join(oldRoot))); })(),
        endMarker: 'before `skill://<name>` resolves (its rules may already be embedded in the agent files above).',
      },
      {
        matchStart: s => {
          const text = s.replace(/\r\n/g, '\n');
          const match = /^- Law reference: (.+)\/agent\/AGENTS\.md$/m.exec(text);
          return Boolean(match && text.startsWith(getOpenclawSoul(match[1]).trimEnd()));
        },
        endMarker: '- Return contract: STATUS | FILES | TESTS было->стало | CONCERNS (<=25 lines).',
      },
      {
        matchStart: s => {
          const text = s.replace(/\r\n/g, '\n');
          const match = /^Target workspace: (.+)$/m.exec(text);
          return Boolean(match && text.startsWith(getOpenclawUser(match[1]).trimEnd()));
        },
        endMarker: '- Verification: verify all fixes before final response.',
      },
    ];

  for (const rule of legacyBlockRules) {
    const contractIdx = existingContent.indexOf(rule.endMarker);
    if (rule.matchStart(existingContent) && contractIdx !== -1) {
      let cutoff = contractIdx + rule.endMarker.length;
      if (existingContent.slice(cutoff, cutoff + 2) === "\r\n") cutoff += 2;
      else if (existingContent.slice(cutoff, cutoff + 1) === "\n") cutoff += 1;

      const appendedHumanContent = existingContent.slice(cutoff).trimStart();
      const prefix = defaultPrefix ? defaultPrefix.trimEnd() + "\n\n" : "";
      return appendedHumanContent
        ? `${prefix}${managedBlock}\n\n${appendedHumanContent}`
        : `${prefix}${managedBlock}\n`;
    }
  }
  // User has existing instructions or rules: preserve them completely and append managed section
  return `${existingContent.trimEnd()}\n\n${managedBlock}\n`;
}

/**
 * Applies managed section to Cursor .mdc file, preserving YAML frontmatter if present.
 */
export function applyCursorMdc(existingContent, adapterBody) {
  const defaultFrontmatter = [
    "---",
    "description: NULLFORM WORKFLOW Rules",
    "alwaysApply: true",
    "---",
  ].join("\n");

  if (!existingContent || existingContent.trim() === "") {
    return `${defaultFrontmatter}\n\n${MANAGED_START}\n${adapterBody.trim()}\n${MANAGED_END}\n`;
  }

  const fmMatch = existingContent.match(/^(---\r?\n[\s\S]*?\r?\n---)(?:\r?\n|$)/);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    const body = existingContent.slice(fmMatch[0].length);
    const managedBody = applyManagedSection(body, adapterBody);
    return `${frontmatter}\n\n${managedBody.trimStart()}`;
  }

  return applyManagedSection(existingContent, adapterBody, defaultFrontmatter);
}

/**
 * Updates opencode.json / opencode.jsonc using jsonc-parser modify/applyEdits
 * to preserve comments, trailing commas, unknown fields, and credentials.
 */
export function updateOpencodeJson(existingPath, preflightedJson) {
  if (existingPath && existsSync(existingPath)) {
    const rawText = readSafeText(existingPath, "JSONC");
    if (rawText && rawText.trim() !== "") {
      const cfg = preflightedJson || preflightJsoncConfig(existingPath);
      if (!cfg["$schema"]) {
        const jsonc = loadJsonc();
        const edits = jsonc.modify(rawText, ["$schema"], "https://opencode.ai/config.json", {
          formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
          getInsertionIndex: () => 0,
        });
        const updated = jsonc.applyEdits(rawText, edits);
        return updated.endsWith("\n") ? updated : `${updated}\n`;
      }
      return rawText.endsWith("\n") ? rawText : `${rawText}\n`;
    }
  }

  const cfg = preflightedJson ? structuredClone(preflightedJson) : {};
  if (!cfg["$schema"]) {
    cfg["$schema"] = "https://opencode.ai/config.json";
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * Updates openclaw.json using JSON5, registering canonical agents.entries.workflow
 * without injecting unverified root keys that trigger gateway refusal.
 */
export function updateOpenclawJson(existingPath, preflightedJson, slashRoot) {
  const JSON5 = loadJson5();
  const cfg = preflightedJson ? structuredClone(preflightedJson) : {};

  if (!cfg.agents || typeof cfg.agents !== "object" || Array.isArray(cfg.agents)) cfg.agents = {};
  if (!cfg.agents.entries || typeof cfg.agents.entries !== "object" || Array.isArray(cfg.agents.entries)) {
    cfg.agents.entries = {};
  }

  const existingWorkflow =
    cfg.agents.entries.workflow &&
    typeof cfg.agents.entries.workflow === "object" &&
    !Array.isArray(cfg.agents.entries.workflow)
      ? cfg.agents.entries.workflow
      : {};
  cfg.agents.entries.workflow = {
    ...existingWorkflow,
    workspace: slashRoot,
  };

  return JSON5.stringify(cfg, null, 2) + "\n";
}

export function getMarkdownAdapter(slashRoot, title = "NULLFORM WORKFLOW Adapter") {
  return [
    `# ${title}`,
    "",
    `Полный свод законов и протокол оркестратора: ${slashRoot}/agent/AGENTS.md`,
    "",
    "## 1. Запуск задачи и гейты (T0–T3)",
    "Перед изменением любых файлов определите tier и зафиксируйте задачу:",
    `- \`node '${slashRoot}/tools/workflow.mjs' start --tier <T0|T1|T2|T3> --task "<описание>"\``,
    `- \`node '${slashRoot}/tools/workflow.mjs' check\` (exit 1 при отсутствии обязательных артефактов)`,
    `- \`node '${slashRoot}/tools/workflow.mjs' close\` (фиксирует завершение задачи)`,
    "",
    "Уровни (Lanes):",
    "- `⚡ [T0 FAST]`: 1–2 известных файла, точечные правки, без OpenSpec/интервью/oracle.",
    "- `🔧 [T1 STANDARD]`: 3+ файлов, микро-план в чате, 1–2 специалиста.",
    "- `🚀 [T2 HEAVY]`: архитектура/новые модули. 4-Wave SDD: Wave 0 (интервью) -> манифест (R##) -> OpenSpec -> TDD build -> blind Oracle.",
    "- `🌌 [T3 PROGRAM]`: мульти-фича программа (T2 на каждый слайс).",
    "",
    "## 2. Фиксация артефактов",
    `- Манифест требований: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind manifest --path openspec/changes/<id>/manifest.md\``,
    `- Спецификация/OpenSpec: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind openspec --path openspec/changes/<id>\``,
    `- Границы и интерфейсы: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind interfaces --path openspec/changes/<id>/interfaces.md\``,
    `- Вердикт оракула: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind oracle --detail "ACCEPT: <причина>"\``,
    "",
    "## 3. Дашборд наблюдаемости",
    "При `workflow.mjs start` автоматически запускается фоновый дашборд.",
    "- URL хранится в `.workflow/dashboard.json`",
    `- Получить URL: \`node '${slashRoot}/tools/dashboard.mjs' --url\``,
    "",
    "## 4. Базовые законы",
    "- Честность: никаких заявлений о готовности без выполненных проверок.",
    "- Анализ до кода: инвентаризация существующего кода (reuse > extend > create).",
    "- Ladder решений: reuse -> stdlib -> platform -> installed dep -> 1 line -> minimum.",
    "- Возвратный контракт (≤25 строк): STATUS | FILES | TESTS было->стало | CONCERNS.",
    "",
  ].join("\n");
}

export function getOpenclawSoul(slashRoot) {
  return [
    "# OpenClaw SOUL: NULLFORM WORKFLOW",
    "",
    "Identity: Orchestrator agent operating under NULLFORM WORKFLOW protocols.",
    `- Law reference: ${slashRoot}/agent/AGENTS.md`,
    "- Core stance: Correctness first, then maintainability. Minimal diffs.",
    "- Scientific diagnosis: Tight reproducible red test before inspecting code.",
    "- Ladder: reuse -> stdlib -> platform -> installed dep -> 1 line -> minimum.",
    "- Return contract: STATUS | FILES | TESTS было->стало | CONCERNS (<=25 lines).",
    "",
  ].join("\n");
}

export function getOpenclawUser(slashRoot) {
  return [
    "# OpenClaw USER: Context & Operating Preferences",
    "",
    `Target workspace: ${slashRoot}`,
    "- Workflow execution: use `node tools/workflow.mjs` for task gating.",
    "- Observability: dashboard URL available in `.workflow/dashboard.json`.",
    "- Verification: verify all fixes before final response.",
    "",
  ].join("\n");
}

/**
 * Updates Hermes config.yaml using real yaml Document AST.
 * Preserves user comments, anchors, models, and custom settings.
 * Registers MCP servers under top-level mcp_servers without creating fake profiles.
 */
export function updateHermesConfigYaml(existingPath, preflightedContent, slashRoot, mcpExamplePath, translateStdioEntry) {
  const yaml = loadYaml();
  let doc;
  if (!preflightedContent || preflightedContent.trim() === "") {
    doc = new yaml.Document({});
    doc.commentBefore = " Hermes Agent Configuration — NULLFORM WORKFLOW";
  } else {
    doc = yaml.parseDocument(preflightedContent, { keepSourceTokens: true });
    if (doc.errors && doc.errors.length > 0) {
      throw new Error(`Preflight failed: malformed YAML in ${existingPath}`);
    }
  }

  if (mcpExamplePath && existsSync(mcpExamplePath)) {
    try {
      const ex = JSON.parse(readFileSync(mcpExamplePath, "utf8"));
      if (ex.mcpServers && typeof ex.mcpServers === "object") {
        if (!doc.has("mcp_servers")) {
          doc.set("mcp_servers", doc.createNode({}));
        }
        for (const [name, entry] of Object.entries(ex.mcpServers)) {
          if (!JSON.stringify(entry).includes("__")) {
            if (!doc.hasIn(["mcp_servers", name])) {
              const translated = translateStdioEntry ? translateStdioEntry(entry) : entry;
              const serverObj = {};
              if (translated.command) serverObj.command = translated.command;
              if (Array.isArray(translated.args) && translated.args.length > 0) {
                serverObj.args = translated.args;
              }
              if (translated.env && typeof translated.env === "object" && Object.keys(translated.env).length > 0) {
                serverObj.env = translated.env;
              }
              doc.setIn(["mcp_servers", name], doc.createNode(serverObj));
            }
          }
        }
      }
    } catch {}
  }

  return doc.toString();
}

/**
 * Calculates a SHA-256 hash of text content.
 */
export function hashContent(content) {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(content)) {
    hash.update(content);
  } else {
    hash.update(String(content), "utf8");
  }
  return hash.digest("hex");
}

/**
 * Checks whether an executable command is present in PATH.
 */
export function isCommandInPath(cmd) {
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = pathEnv.split(sep);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = join(dir, cmd + ext);
      try {
        if (existsSync(full)) return true;
      } catch {}
    }
  }
  return false;
}
