import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs as utilParseArgs } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * usage-audit.mjs — аудит использования MCP-серверов, встроенных тулов и скиллов
 * на основе сессионных логов (.jsonl).
 *
 * CLI опции:
 *   --sessions <dir>  Каталог с сессиями (по умолчанию ~/.omp/agent/sessions)
 *   --days <n>        Фильтр сессий по возрасту в днях (по умолчанию 30)
 *   --mcp <path>      Путь к mcp.json (по умолчанию ~/.omp/agent/mcp.json)
 *   --skills <dir>    Каталог установленных скиллов (по умолчанию ~/.agents/skills)
 *   --plugins <path>  Манифест OMP-плагинов (по умолчанию ~/.omp/agent/plugins.json)
 *   --json            Машиночитаемый вывод JSON
 *   --help, -h        Справка
 */

/** Объявленные опции CLI; всё остальное — опечатка, которую нельзя проглатывать. */
const KNOWN_OPTIONS = new Set(["sessions", "days", "top", "mcp", "skills", "plugins", "json", "help"]);

/**
 * Инструменты и слэш-команды 14 OMP-плагинов манифеста `agent/plugins.json`.
 * Ключ — имя плагина, значение — маркеры, по которым видно его использование в
 * сессии: имена тулов и слэш-команды. Аудит ищет именно эти маркеры.
 */
const KNOWN_PLUGIN_TOOLS = {
  "oh-my-pi-plugin-morph": ["fast_edit", "fastcompact", "codebase_warpsearch"],
  "pi-lens": ["pi_lens_activate_tools", "lens_diagnostics", "/lens"],
  "pi-goal-x": ["goal_", "/goal"],
  "pi-qq": ["/qq"],
  "pi-prompt-shelf": ["/shelf", "/prompt-shelf"],
  "pi-bar": ["/bar"],
  "pi-gh-cli": ["/gh"],
  "@dietrichgebert/ponytail": ["/ponytail"],
  "omp-plugin-duplicate-detector": ["duplicate-detector", "jscpd"],
  "omp-typescript-complexity-evaluator": ["complexity-evaluator"],
  "omp-url-pin": ["url-pin"],
  "@plannotator/pi-extension": ["plannotator"],
  "pi-linter": ["linter", "/linter"],
  "oh-my-pi-plugin-grok-build": ["grok-build"],
};

/**
 * Разбирает числовой параметр CLI. Молчаливая подмена значения (0 → 1, -5 → 30,
 * "abc" → дефолт) искажала отчёт, поэтому неверное значение — явная ошибка.
 */
function parseCount(raw, flag, min, errors) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${flag} требует целое число >= ${min} (получено: ${JSON.stringify(raw)})`);
    return null;
  }
  return value;
}

function parseCliArgs(args = process.argv.slice(2)) {
  const defaultHome = homedir();
  const defaultSessions = join(defaultHome, ".omp", "agent", "sessions");
  const defaultMcp = join(defaultHome, ".omp", "agent", "mcp.json");
  const defaultSkills = join(defaultHome, ".agents", "skills");
  const userPlugins = join(defaultHome, ".omp", "agent", "plugins.json");
  const repoPlugins = join(process.cwd(), "agent", "plugins.json");
  const defaultPlugins = existsSync(userPlugins) ? userPlugins : (existsSync(repoPlugins) ? repoPlugins : userPlugins);

  const { values } = utilParseArgs({
    args,
    options: {
      sessions: { type: "string", default: defaultSessions },
      days: { type: "string", default: "30" },
      top: { type: "string", default: "15" },
      mcp: { type: "string", default: defaultMcp },
      skills: { type: "string", default: defaultSkills },
      plugins: { type: "string", default: defaultPlugins },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  const errors = [];
  for (const key of Object.keys(values)) {
    if (!KNOWN_OPTIONS.has(key)) {
      errors.push(`неизвестный параметр --${key}`);
    }
  }

  const days = parseCount(values.days, "--days", 1, errors);
  const top = parseCount(values.top, "--top", 1, errors);

  for (const [flag, value] of [
    ["--sessions", values.sessions],
    ["--mcp", values.mcp],
    ["--skills", values.skills],
    ["--plugins", values.plugins],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${flag} требует непустой путь (получено: ${JSON.stringify(value)})`);
    }
  }

  return {
    sessionsDir: values.sessions,
    days: days ?? 30,
    top: top ?? 15,
    mcpPath: values.mcp,
    skillsDir: values.skills,
    pluginsPath: values.plugins,
    json: values.json,
    help: values.help,
    errors,
  };
}

/**
 * Рекурсивный поиск всех .jsonl файлов в директории.
 */
function findJsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true })
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Загрузка списка сконфигурированных MCP-серверов из mcp.json.
 * Ошибки конфигурации не проглатываются: они попадают в `notes` вызывающего,
 * иначе битый mcp.json выглядел как «конфиг пуст, все серверы используются».
 *
 * @param {string} mcpFilePath
 * @param {string[]} [notes]
 * @returns {string[]}
 */
function loadMcpServers(mcpFilePath, notes = []) {
  if (!mcpFilePath || typeof mcpFilePath !== "string" || !existsSync(mcpFilePath)) return [];
  try {
    const raw = readFileSync(mcpFilePath, "utf8");
    const data = JSON.parse(raw);
    const servers = data?.mcpServers ?? data?.servers ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      notes.push(`mcp.json: список серверов имеет неверный тип — конфигурация не прочитана: ${mcpFilePath}`);
      return [];
    }
    return Object.keys(servers);
  } catch (err) {
    notes.push(`mcp.json не читается (${err.message}) — раздел неиспользуемых MCP-серверов неполон: ${mcpFilePath}`);
    return [];
  }
}

/**
 * Загрузка списка установленных скиллов из каталога скиллов.
 */
function loadInstalledSkills(skillsDirPath) {
  if (!skillsDirPath || !existsSync(skillsDirPath)) return [];
  const skills = [];
  try {
    const entries = readdirSync(skillsDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillName = entry.name;
        // Проверяем наличие SKILL.md / skill.md или просто наличие директории
        const md1 = join(skillsDirPath, skillName, "SKILL.md");
        const md2 = join(skillsDirPath, skillName, "skill.md");
        if (existsSync(md1) || existsSync(md2)) {
          skills.push(skillName);
        } else {
          // Если файл отсутствует, все равно считаем скиллом, если это директория
          skills.push(skillName);
        }
      }
    }
  } catch {
    // игнорируем ошибки доступа
  }
  return skills.sort();
}

/** Имя пакета без версии: `pi-lens@^4.2.1` → `pi-lens`, `@scope/pkg@1.0.0` → `@scope/pkg`. */
function barePluginName(name) {
  const at = name.indexOf("@", 1);
  return at === -1 ? name : name.slice(0, at);
}

/**
 * Загрузка имён установленных OMP-плагинов. Поддерживает три формата:
 *   - манифест харнесса `agent/plugins.json`: `{ plugins: [{ name, spec }] }` / `[{ name, spec }]`;
 *   - вывод `omp plugin list --json`: `{ npm: [{ name, enabled }] }`;
 *   - `package.json`: `{ dependencies: { "<name>": "<range>" } }`.
 * Ошибки конфигурации не проглатываются (как и в `loadMcpServers`): иначе битый
 * манифест выглядел бы как «плагинов нет, значит ничего не используется».
 *
 * @param {string} pluginsPath
 * @param {string[]} [notes]
 * @returns {string[]} отсортированные уникальные имена плагинов
 */
function loadPlugins(pluginsPath, notes = []) {
  if (!pluginsPath || typeof pluginsPath !== "string" || !existsSync(pluginsPath)) return [];

  let data;
  try {
    data = JSON.parse(readFileSync(pluginsPath, "utf8"));
  } catch (err) {
    notes.push(`plugins.json не читается (${err.message}) — раздел плагинов неполон: ${pluginsPath}`);
    return [];
  }

  let entries;
  if (Array.isArray(data)) entries = data;
  else if (Array.isArray(data?.plugins)) entries = data.plugins;
  else if (Array.isArray(data?.npm)) entries = data.npm;
  else if (data?.dependencies && typeof data.dependencies === "object" && !Array.isArray(data.dependencies)) {
    entries = Object.keys(data.dependencies);
  } else {
    notes.push(`plugins.json: неизвестный формат (нет plugins/npm/dependencies) — конфигурация не прочитана: ${pluginsPath}`);
    return [];
  }

  const names = entries
    .map((entry) => (typeof entry === "string" ? entry : typeof entry?.name === "string" ? entry.name : ""))
    .map((name) => barePluginName(name.trim()))
    .filter((name) => name !== "");

  return [...new Set(names)].sort();
}

/**
 * Анализ сессий.
 */
function auditUsage(options) {
  const {
    sessionsDir,
    days = 30,
    mcpPath,
    skillsDir,
    pluginsPath,
    now = Date.now(),
  } = options;

  const notes = [];
  if (!sessionsDir || !existsSync(sessionsDir)) {
    return {
      empty: true,
      reason: "Сессий не найдено",
      notes: ["Каталог сессий не существует: " + (sessionsDir || "не указан")],
      stats: { totalFiles: 0, scannedFiles: 0, totalLines: 0, malformedLines: 0 },
      tools: { mcp: {}, builtins: {}, skills: {} },
      unusedMcp: [],
      unusedSkills: [],
      pluginStats: {},
      unusedPlugins: [],
    };
  }

  const allFiles = findJsonlFiles(sessionsDir);
  if (allFiles.length === 0) {
    return {
      empty: true,
      reason: "Сессий не найдено",
      notes: ["В каталоге сессий нет .jsonl файлов"],
      stats: { totalFiles: 0, scannedFiles: 0, totalLines: 0, malformedLines: 0 },
      tools: { mcp: {}, builtins: {}, skills: {} },
      unusedMcp: [],
      unusedSkills: [],
      pluginStats: {},
      unusedPlugins: [],
    };
  }

  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const configuredMcpServers = loadMcpServers(mcpPath, notes);
  const installedSkills = loadInstalledSkills(skillsDir);
  const installedPlugins = loadPlugins(pluginsPath, notes);

  const state = {
    scannedFiles: 0,
    totalLines: 0,
    malformedLines: 0,
    mcpCounts: {},
    builtinCounts: {},
    skillCounts: {},
    mcpServersUsed: new Set(),
    skillsUsed: new Set(),
    pluginCallCounts: {},
  };
  for (const name of Object.keys(KNOWN_PLUGIN_TOOLS)) {
    state.pluginCallCounts[name] = 0;
  }
  for (const name of installedPlugins) {
    if (!(name in state.pluginCallCounts)) {
      state.pluginCallCounts[name] = 0;
    }
  }

  for (const filePath of allFiles) {
    processSessionFile(filePath, state, now, maxAgeMs);
  }

  const { unusedMcp, unusedSkills, pluginStats, unusedPlugins } = computeUnused(
    state,
    configuredMcpServers,
    installedSkills,
    installedPlugins
  );

  notes.push(`Обработано файлов: ${state.scannedFiles} из ${allFiles.length}`);
  notes.push(`Всего строк: ${state.totalLines}`);
  if (state.malformedLines > 0) {
    notes.push(`Битых строк JSON: ${state.malformedLines}`);
  }

  return {
    empty: false,
    stats: {
      totalFiles: allFiles.length,
      scannedFiles: state.scannedFiles,
      totalLines: state.totalLines,
      malformedLines: state.malformedLines,
      days,
    },
    tools: {
      mcp: state.mcpCounts,
      builtins: state.builtinCounts,
      skills: state.skillCounts,
    },
    unusedMcp,
    unusedSkills,
    pluginStats,
    unusedPlugins,
    notes,
  };
}

function recordMcpTool(name, serverName, state) {
  state.mcpCounts[name] = (state.mcpCounts[name] || 0) + 1;
  if (serverName) state.mcpServersUsed.add(serverName);
}

function recordBuiltinTool(name, state) {
  state.builtinCounts[name] = (state.builtinCounts[name] || 0) + 1;
}

function recordSkillTool(skillName, state) {
  state.skillCounts[skillName] = (state.skillCounts[skillName] || 0) + 1;
  state.skillsUsed.add(skillName);
}

function matchMarker(name, argPath, marker) {
  if (marker.endsWith("_")) return name.startsWith(marker) || Boolean(argPath && argPath.includes(marker));
  if (marker.startsWith("/")) return name === marker || name === marker.slice(1);
  return (
    name === marker ||
    name.endsWith("__" + marker) ||
    argPath === "xd://" + marker ||
    argPath.startsWith("xd://" + marker + "?") ||
    argPath.includes("/" + marker)
  );
}
function matchPlugin(name, argPath, markers) {
  for (const marker of markers) {
    if (matchMarker(name, argPath, marker)) return true;
  }
  return false;
}

function matchKnownPluginTools(name, argPath, state, pluginsCalledInRecord) {
  for (const [pluginName, markers] of Object.entries(KNOWN_PLUGIN_TOOLS)) {
    if (matchPlugin(name, argPath, markers)) {
      state.pluginCallCounts[pluginName] = (state.pluginCallCounts[pluginName] || 0) + 1;
      pluginsCalledInRecord.add(pluginName);
    }
  }
}

function scanToolItem(item, state, pluginsCalledInRecord) {
  if (!item || typeof item !== "object") return;
  const isTool =
    item.type === "toolCall" ||
    item.type === "tool_use" ||
    item.type === "tool" ||
    Boolean(item.name && (item.input || item.arguments));

  if (!isTool && !item.name) return;
  const name = item.name;
  if (!name || typeof name !== "string") return;

  const args = item.arguments || item.input || {};
  const argPath = typeof args.path === "string" ? args.path : "";

  matchKnownPluginTools(name, argPath, state, pluginsCalledInRecord);

  if (argPath.startsWith("skill://")) {
    const match = argPath.match(/^skill:\/\/([^/\s?#]+)/);
    if (match && match[1]) {
      recordSkillTool(match[1], state);
    }
  }

  if (argPath.startsWith("xd://mcp__")) {
    const mcpTarget = argPath.slice("xd://mcp__".length);
    const mcpFullName = "mcp__" + mcpTarget;
    const parts = mcpTarget.split("_");
    recordMcpTool(mcpFullName, parts[0], state);
    return;
  }

  if (name.startsWith("mcp__")) {
    const target = name.slice(5);
    const parts = target.split("_");
    recordMcpTool(name, parts[0], state);
  } else if (name.startsWith("mcp:") || name.startsWith("mcp/")) {
    const parts = name.slice(4).split(/[:/]/);
    recordMcpTool(name, parts[0], state);
  } else {
    recordBuiltinTool(name, state);
  }
}
function extractRecordTexts(record) {
  const texts = [];
  const rawContent = record?.message?.content ?? record?.content;
  if (typeof rawContent === "string") {
    texts.push(rawContent);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (typeof block === "string") texts.push(block);
      else if (typeof block?.text === "string") texts.push(block.text);
    }
  }
  if (typeof record?.text === "string") texts.push(record.text);
  if (typeof record?.command === "string") texts.push(record.command);
  return texts;
}

function countMarkerMatches(text, marker, alreadyCalled) {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (marker.startsWith("/")) {
    const re = new RegExp(`(?:^|[\\s"'\`])${esc}(?=[\\s"'\`\\r\\n]|$|[?.,!])`, "g");
    return text.match(re)?.length || 0;
  }
  if (!alreadyCalled) {
    const re = marker.endsWith("_") ? new RegExp(`\\b${esc}\\w*`, "i") : new RegExp(`\\b${esc}\\b`, "i");
    if (re.test(text)) return 1;
  }
  return 0;
}

function countPluginMentions(text, markers, alreadyCalled) {
  let count = 0;
  for (const marker of markers) {
    count += countMarkerMatches(text, marker, alreadyCalled);
  }
  return count;
}

function scanTextMentions(record, state, pluginsCalledInRecord) {
  const role = record?.message?.role || record?.role;
  if (role === "toolResult") return;

  const texts = extractRecordTexts(record);
  for (const text of texts) {
    if (!text || typeof text !== "string") continue;
    for (const [pluginName, markers] of Object.entries(KNOWN_PLUGIN_TOOLS)) {
      const mentions = countPluginMentions(text, markers, pluginsCalledInRecord.has(pluginName));
      if (mentions > 0) {
        state.pluginCallCounts[pluginName] = (state.pluginCallCounts[pluginName] || 0) + mentions;
        pluginsCalledInRecord.add(pluginName);
      }
    }
  }
}

function processSessionLine(line, state) {
  if (!line.trim()) return;
  state.totalLines++;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    state.malformedLines++;
    return;
  }
  const contentList = Array.isArray(record?.message?.content)
    ? record.message.content
    : Array.isArray(record?.content) ? record.content : [];
  const candidates = [...contentList];
  if (record.type === "toolCall" || record.type === "tool_use") candidates.push(record);
  const pluginsCalledInRecord = new Set();
  for (const item of candidates) scanToolItem(item, state, pluginsCalledInRecord);
  scanTextMentions(record, state, pluginsCalledInRecord);
}

function isFileFresh(filePath, now, maxAgeMs) {
  try {
    return now - statSync(filePath).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

function processSessionFile(filePath, state, now, maxAgeMs) {
  if (!isFileFresh(filePath, now, maxAgeMs)) return;
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  state.scannedFiles++;
  for (const line of content.split("\n")) processSessionLine(line, state);
}

function computeUnused(state, configuredMcpServers, installedSkills, installedPlugins) {
  const unusedMcp = configuredMcpServers.filter((server) => {
    if (state.mcpServersUsed.has(server)) return false;
    const normalized = server.replace(/[-_]/g, "");
    for (const used of state.mcpServersUsed) {
      if (used.replace(/[-_]/g, "") === normalized) return false;
    }
    for (const toolName of Object.keys(state.mcpCounts)) {
      if (toolName.includes(server) || toolName.replace(/[-_]/g, "").includes(normalized)) {
        return false;
      }
    }
    return true;
  });

  const unusedSkills = installedSkills.filter((skill) => !state.skillsUsed.has(skill));
  const allPluginNames = new Set([
    ...Object.keys(KNOWN_PLUGIN_TOOLS),
    ...installedPlugins,
  ]);

  const pluginStats = {};
  for (const name of allPluginNames) {
    const calls = state.pluginCallCounts[name] || 0;
    pluginStats[name] = { calls, used: calls > 0 };
  }

  const unusedPlugins = installedPlugins
    .filter((name) => (pluginStats[name]?.calls || 0) === 0)
    .sort();

  return {
    unusedMcp: unusedMcp.sort(),
    unusedSkills: unusedSkills.sort(),
    pluginStats,
    unusedPlugins,
  };
}

/**
 * Текстовое RU форматирование отчёта.
 */
function formatAuditReport(data, { top = 15 } = {}) {
  if (data.empty) {
    const lines = [data.reason || "Сессий не найдено"];
    if (data.notes && data.notes.length > 0) {
      for (const n of data.notes) lines.push(`- ${n}`);
    }
    return lines.join("\n");
  }

  const lines = [];
  lines.push("=== АУДИТ ИСПОЛЬЗОВАНИЯ ТУЛОВ И СКИЛЛОВ ===");
  lines.push(`Период: за последние ${data.stats.days} дн.`);
  lines.push(`Просканировано сессий: ${data.stats.scannedFiles} (всего файлов: ${data.stats.totalFiles})`);
  lines.push(`Обработано строк: ${data.stats.totalLines}${data.stats.malformedLines > 0 ? ` (битых: ${data.stats.malformedLines})` : ""}`);

  const ranked = (title, counts, pad, emptyText) => {
    lines.push(`\n${title}`);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      lines.push(emptyText);
      return;
    }
    for (const [name, count] of sorted.slice(0, top)) {
      lines.push(`  ${name.padEnd(pad)} : ${count}`);
    }
    if (sorted.length > top) {
      lines.push(`  ... ещё ${sorted.length - top} поз. (ограничение --top ${top})`);
    }
  };

  ranked("--- ВСТРОЕННЫЕ ТУЛЫ ---", data.tools.builtins, 20, "(вызовов не обнаружено)");
  ranked("--- MCP ТУЛЫ ---", data.tools.mcp, 35, "(вызовов не обнаружено)");
  ranked("--- СКИЛЛЫ (skill://) ---", data.tools.skills, 30, "(обращений не обнаружено)");

  lines.push("\n--- НЕИСПОЛЬЗУЕМЫЕ MCP СЕРВЕРЫ (из mcp.json) ---");
  if (data.unusedMcp.length === 0) {
    lines.push("(все сконфигурированные серверы используются или конфиг пуст)");
  } else {
    for (const s of data.unusedMcp) {
      lines.push(`  - ${s}`);
    }
  }

  lines.push("\n--- НЕИСПОЛЬЗУЕМЫЕ УСТАНОВЛЕННЫЕ СКИЛЛЫ ---");
  if (data.unusedSkills.length === 0) {
    lines.push("(все установленные скиллы вызывались или каталог пуст)");
  } else {
    for (const s of data.unusedSkills) {
      lines.push(`  - ${s}`);
    }
  }

  const pluginCalls = {};
  if (data.pluginStats) {
    for (const [name, stat] of Object.entries(data.pluginStats)) {
      if (stat.calls > 0) {
        pluginCalls[name] = stat.calls;
      }
    }
  }
  ranked("--- ИСПОЛЬЗОВАНИЕ ПЛАГИНОВ OMP ---", pluginCalls, 38, "(вызовов не обнаружено)");

  lines.push(`\n--- НЕИСПОЛЬЗУЕМЫЕ ПЛАГИНЫ (0 вызовов за ${data.stats?.days ?? 30} дней) ---`);
  if (!data.unusedPlugins || data.unusedPlugins.length === 0) {
    lines.push("(все установленные плагины используются или список пуст)");
  } else {
    for (const p of data.unusedPlugins) {
      lines.push(`  - ${p} (рекомендация: omp plugin disable ${p})`);
    }
  }

  if (data.notes && data.notes.length > 0) {
    lines.push("\n--- ЗАМЕТКИ ---");
    for (const n of data.notes) {
      lines.push(`- ${n}`);
    }
  }

  return lines.join("\n");
}

// Точка входа CLI
export function main(argv = process.argv.slice(2)) {
  const USAGE = `Использование: node tools/usage-audit.mjs [параметры]

Параметры:
  --sessions <dir>  Каталог с сессиями (по умолчанию ~/.omp/agent/sessions)
  --days <n>        Фильтр сессий по возрасту в днях, >= 1 (по умолчанию 30)
  --top <n>         Ограничить ранжированные списки в текстовом отчёте, >= 1 (по умолчанию 15)
  --mcp <path>      Путь к mcp.json (по умолчанию ~/.omp/agent/mcp.json)
  --skills <dir>    Каталог установленных скиллов (по умолчанию ~/.agents/skills)
  --plugins <path>  Манифест OMP-плагинов (по умолчанию ~/.omp/agent/plugins.json)
  --json            Машиночитаемый вывод JSON (полные счётчики, без ограничения --top)
  --help, -h        Справка
`;

  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    console.error(`Ошибка разбора аргументов: ${err.message}`);
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  // Неверный/опечатанный параметр раньше молча менял окно аудита (--day 30 → 30 дней).
  if (options.errors.length > 0) {
    for (const err of options.errors) {
      console.error(`Ошибка: ${err}.`);
    }
    console.error(USAGE);
    return 2;
  }

  const auditResult = auditUsage(options);

  if (options.json) {
    console.log(JSON.stringify(auditResult, null, 2));
  } else {
    console.log(formatAuditReport(auditResult, { top: options.top }));
  }

  return 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main();
}
