import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { homedir } from "node:os";
import { parseArgs as utilParseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/**
 * usage-audit.mjs — аудит использования MCP-серверов, встроенных тулов и скиллов
 * на основе сессионных логов (.jsonl).
 *
 * CLI опции:
 *   --sessions <dir>  Каталог с сессиями (по умолчанию ~/.omp/agent/sessions)
 *   --days <n>        Фильтр сессий по возрасту в днях (по умолчанию 30)
 *   --mcp <path>      Путь к mcp.json (по умолчанию ~/.omp/agent/mcp.json)
 *   --skills <dir>    Каталог установленных скиллов (по умолчанию ~/.agents/skills)
 *   --json            Машиночитаемый вывод JSON
 *   --help, -h        Справка
 */

/** Объявленные опции CLI; всё остальное — опечатка, которую нельзя проглатывать. */
const KNOWN_OPTIONS = new Set(["sessions", "days", "top", "mcp", "skills", "json", "help"]);

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

export function parseCliArgs(args = process.argv.slice(2)) {
  const defaultHome = homedir();
  const defaultSessions = join(defaultHome, ".omp", "agent", "sessions");
  const defaultMcp = join(defaultHome, ".omp", "agent", "mcp.json");
  const defaultSkills = join(defaultHome, ".agents", "skills");

  const { values } = utilParseArgs({
    args,
    options: {
      sessions: { type: "string", default: defaultSessions },
      days: { type: "string", default: "30" },
      top: { type: "string", default: "15" },
      mcp: { type: "string", default: defaultMcp },
      skills: { type: "string", default: defaultSkills },
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
    json: values.json,
    help: values.help,
    errors,
  };
}

/**
 * Рекурсивный поиск всех .jsonl файлов в директории.
 */
export function findJsonlFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;

  function traverse(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
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
export function loadMcpServers(mcpFilePath, notes = []) {
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
export function loadInstalledSkills(skillsDirPath) {
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

/**
 * Анализ сессий.
 */
export function auditUsage(options) {
  const {
    sessionsDir,
    days = 30,
    mcpPath,
    skillsDir,
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
    };
  }

  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  let scannedFiles = 0;
  let totalLines = 0;
  let malformedLines = 0;

  const mcpCounts = {};
  const builtinCounts = {};
  const skillCounts = {};
  const mcpServersUsed = new Set();
  const skillsUsed = new Set();

  function recordMcp(toolName, serverName) {
    mcpCounts[toolName] = (mcpCounts[toolName] || 0) + 1;
    if (serverName) mcpServersUsed.add(serverName);
  }

  function recordBuiltin(toolName) {
    builtinCounts[toolName] = (builtinCounts[toolName] || 0) + 1;
  }

  function recordSkill(skillName) {
    skillCounts[skillName] = (skillCounts[skillName] || 0) + 1;
    skillsUsed.add(skillName);
  }

  for (const filePath of allFiles) {
    try {
      const stat = statSync(filePath);
      const fileAgeMs = now - stat.mtimeMs;
      if (fileAgeMs > maxAgeMs) {
        continue;
      }
    } catch {
      continue;
    }

    scannedFiles++;
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      totalLines++;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLines++;
        continue;
      }

      // Извлечение tool_use / toolCall
      // 1) message.content (Array)
      const contentList = Array.isArray(record?.message?.content)
        ? record.message.content
        : Array.isArray(record?.content)
        ? record.content
        : [];

      // 2) одиночные поля типа record.tool_use или record.toolCall
      const candidates = [...contentList];
      if (record.type === "toolCall" || record.type === "tool_use") {
        candidates.push(record);
      }

      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        const isTool =
          item.type === "toolCall" ||
          item.type === "tool_use" ||
          item.type === "tool" ||
          Boolean(item.name && (item.input || item.arguments));

        if (!isTool && !item.name) continue;

        const name = item.name;
        if (!name || typeof name !== "string") continue;

        const args = item.arguments || item.input || {};

        // Проверяем skill:// в аргументах (например, read({ path: "skill://<name>" }))
        const argPath = typeof args.path === "string" ? args.path : "";
        if (argPath.startsWith("skill://")) {
          const match = argPath.match(/^skill:\/\/([^/\s?#]+)/);
          if (match && match[1]) {
            recordSkill(match[1]);
          }
        }

        // Проверяем xd://mcp__... в вызовах write
        if (argPath.startsWith("xd://mcp__")) {
          const mcpTarget = argPath.slice("xd://mcp__".length);
          // mcpTarget: например hindsight_recall или codebase_index_index_status
          // Попытаемся определить server и tool
          const mcpFullName = "mcp__" + mcpTarget;
          const parts = mcpTarget.split("_");
          // serverName приблизительно - первое слово или mcpTarget
          recordMcp(mcpFullName, parts[0]);
          continue;
        }

        // Прямые MCP вызовы: имя начинается с mcp__ или mcp: или mcp_
        if (name.startsWith("mcp__")) {
          const target = name.slice(5);
          const parts = target.split("_");
          recordMcp(name, parts[0]);
        } else if (name.startsWith("mcp:") || name.startsWith("mcp/")) {
          const parts = name.slice(4).split(/[:/]/);
          recordMcp(name, parts[0]);
        } else {
          // Встроенный тул
          recordBuiltin(name);
        }
      }
    }
  }

  const configuredMcpServers = loadMcpServers(mcpPath, notes);
  const installedSkills = loadInstalledSkills(skillsDir);

  // Неиспользуемые MCP-серверы
  // Сопоставляем configuredMcpServers с используемыми серверами
  const unusedMcp = configuredMcpServers.filter((server) => {
    // Проверяем, встречалось ли имя сервера как префикс в mcpCounts или в mcpServersUsed
    if (mcpServersUsed.has(server)) return false;
    const normalized = server.replace(/[-_]/g, "");
    for (const used of mcpServersUsed) {
      if (used.replace(/[-_]/g, "") === normalized) return false;
    }
    for (const toolName of Object.keys(mcpCounts)) {
      if (toolName.includes(server) || toolName.replace(/[-_]/g, "").includes(normalized)) {
        return false;
      }
    }
    return true;
  });

  // Неиспользуемые установленные скиллы
  const unusedSkills = installedSkills.filter((skill) => !skillsUsed.has(skill));

  notes.push(`Обработано файлов: ${scannedFiles} из ${allFiles.length}`);
  notes.push(`Всего строк: ${totalLines}`);
  if (malformedLines > 0) {
    notes.push(`Битых строк JSON: ${malformedLines}`);
  }

  return {
    empty: false,
    stats: {
      totalFiles: allFiles.length,
      scannedFiles,
      totalLines,
      malformedLines,
      days,
    },
    tools: {
      mcp: mcpCounts,
      builtins: builtinCounts,
      skills: skillCounts,
    },
    unusedMcp: unusedMcp.sort(),
    unusedSkills: unusedSkills.sort(),
    notes,
  };
}

/**
 * Текстовое RU форматирование отчёта.
 */
export function formatAuditReport(data, { top = 15 } = {}) {
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

  if (data.notes && data.notes.length > 0) {
    lines.push("\n--- ЗАМЕТКИ ---");
    for (const n of data.notes) {
      lines.push(`- ${n}`);
    }
  }

  return lines.join("\n");
}

// Запуск при прямом вызове CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const USAGE = `Использование: node tools/usage-audit.mjs [параметры]

Параметры:
  --sessions <dir>  Каталог с сессиями (по умолчанию ~/.omp/agent/sessions)
  --days <n>        Фильтр сессий по возрасту в днях, >= 1 (по умолчанию 30)
  --top <n>         Ограничить ранжированные списки в текстовом отчёте, >= 1 (по умолчанию 15)
  --mcp <path>      Путь к mcp.json (по умолчанию ~/.omp/agent/mcp.json)
  --skills <dir>    Каталог установленных скиллов (по умолчанию ~/.agents/skills)
  --json            Машиночитаемый вывод JSON (полные счётчики, без ограничения --top)
  --help, -h        Справка
`;

  let options;
  try {
    options = parseCliArgs();
  } catch (err) {
    console.error(`Ошибка разбора аргументов: ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // Неверный/опечатанный параметр раньше молча менял окно аудита (--day 30 → 30 дней).
  if (options.errors.length > 0) {
    for (const err of options.errors) {
      console.error(`Ошибка: ${err}.`);
    }
    console.error(USAGE);
    process.exit(2);
  }

  const auditResult = auditUsage(options);

  if (options.json) {
    console.log(JSON.stringify(auditResult, null, 2));
  } else {
    console.log(formatAuditReport(auditResult, { top: options.top }));
  }

  process.exit(0);
}
