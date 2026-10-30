#!/usr/bin/env node
/**
 * tools/memory-cadence.mjs — Контроль регулярной каденции ревизии памяти Hindsight.
 *
 * Проверяет свежесть ревизии банка памяти Hindsight, фиксирует проведенные
 * ревизии, выявляет просроченные интервалы (> max-days).
 *
 * Экспорты:
 *   - loadConfig(configPath)
 *   - loadCadenceState(statePath)
 *   - recordCadenceReview(statePath, details)
 *   - recordCadenceDecision(statePath, details)
 *   - buildSessionPack(packOrMemories, stateOrDecisions)
 *   - checkCadenceStatus(configPath, statePath, maxDays)
 *   - formatCadenceReport(status)
 *   - parseArgs(argv)
 *   - resolvePath(filePath)
 *   - cleanYamlValue(val)
 *   - main(argv)
 *
 * CLI:
 *   node tools/memory-cadence.mjs [--status] [--check] [--record] [--record-decision] [--id <id>] [--decision <keep|reject|defer>] [--reason <text>] [--json] [--config <path>] [--state <path>] [--max-days <n>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");
export const DEFAULT_STATE_PATH = join(process.cwd(), ".workflow", "memory-cadence.json");
export const DEFAULT_MAX_DAYS = 7;

/**
 * Разворачивает ~ и преобразует путь в абсолютный.
 * @param {string} filePath
 * @returns {string}
 */
export function resolvePath(filePath) {
  if (!filePath) return filePath;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\") || filePath === "~") {
    return join(homedir(), filePath.slice(1));
  }
  return resolve(filePath);
}

/**
 * Очищает строковое значение YAML от кавычек и хвостовых комментариев.
 * @param {any} val
 * @returns {string}
 */
export function cleanYamlValue(val) {
  if (val === undefined || val === null) return "";
  const v = String(val).trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  if (v.startsWith('"') || v.startsWith("'")) {
    const quoteChar = v[0];
    const closeIdx = v.indexOf(quoteChar, 1);
    if (closeIdx !== -1) {
      return v.slice(1, closeIdx);
    }
  }
  const hashIdx = v.indexOf("#");
  if (hashIdx !== -1) {
    return v.slice(0, hashIdx).trim();
  }
  return v;
}

/**
 * Читает config.yml, извлекая настройки hindsight (apiUrl, bankId) и memory.backend.
 * При отсутствии файла возвращает объект с exists: false без исключений.
 *
 * @param {string} [configPath]
 * @returns {{
 *   exists: boolean,
 *   path: string,
 *   hindsight: { apiUrl: string|null, bankId: string|null, apiToken?: string|null },
 *   memory: { backend: string|null }
 * }}
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolved = resolvePath(configPath);
  if (!existsSync(resolved)) {
    return {
      exists: false,
      path: resolved,
      hindsight: {
        apiUrl: null,
        bankId: null,
        apiToken: null,
      },
      memory: {
        backend: null,
      },
    };
  }

  const content = readFileSync(resolved, "utf8");

  // Если конфиг в формате JSON — используем JSON.parse
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        return {
          exists: true,
          path: resolved,
          hindsight: {
            apiUrl: parsed.hindsight?.apiUrl ? String(parsed.hindsight.apiUrl) : null,
            bankId: parsed.hindsight?.bankId ? String(parsed.hindsight.bankId) : null,
            apiToken: parsed.hindsight?.apiToken ? String(parsed.hindsight.apiToken) : null,
          },
          memory: {
            backend: parsed.memory?.backend
              ? String(parsed.memory.backend)
              : typeof parsed.memory === "string"
              ? parsed.memory
              : null,
          },
        };
      }
    } catch {
      // Игнорируем и переходим к парсингу YAML
    }
  }

  const lines = content.split(/\r?\n/);
  let currentSection = null;
  let memoryBackend = null;
  let hindsightApiUrl = null;
  let hindsightBankId = null;
  let hindsightApiToken = null;

  for (let rawLine of lines) {
    const indentMatch = rawLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    const lineNoComment = rawLine.replace(/\s+#.*$/, "");
    if (!lineNoComment.trim()) continue;

    // Секция верхнего уровня (отступ 0)
    const topSectionMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*$/);
    if (topSectionMatch && indent === 0) {
      currentSection = topSectionMatch[1];
      continue;
    }

    // Ключ-значение верхнего уровня (отступ 0)
    const topKeyValueMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (topKeyValueMatch && indent === 0) {
      currentSection = null;
      const key = topKeyValueMatch[1];
      const val = cleanYamlValue(topKeyValueMatch[2]);
      if (key === "memory") {
        memoryBackend = val || null;
      }
      continue;
    }

    // Вложенные ключи
    if (indent > 0 && currentSection) {
      const childMatch = rawLine.trim().match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (childMatch) {
        const key = childMatch[1];
        const val = cleanYamlValue(childMatch[2]) || null;
        if (currentSection === "memory") {
          if (key === "backend") memoryBackend = val;
        } else if (currentSection === "hindsight") {
          if (key === "apiUrl") hindsightApiUrl = val;
          else if (key === "bankId") hindsightBankId = val;
          else if (key === "apiToken") hindsightApiToken = val;
        }
      }
    }
  }

  return {
    exists: true,
    path: resolved,
    hindsight: {
      apiUrl: hindsightApiUrl,
      bankId: hindsightBankId,
      apiToken: hindsightApiToken,
    },
    memory: {
      backend: memoryBackend,
    },
  };
}

/**
 * Читает файл состояния каденции (.workflow/memory-cadence.json).
 *
 * @param {string} [statePath]
 * @returns {{
 *   exists: boolean,
 *   path: string,
 *   version?: number,
 *   lastReview: { date: string, reviewer: string, status: string, notes?: string }|null,
 *   history: Array<any>,
 *   decisions?: Array<{ id: string, decision: string, reason: string, at: string }>
 */
export function loadCadenceState(statePath = DEFAULT_STATE_PATH) {
  const resolved = resolvePath(statePath);
  if (!existsSync(resolved)) {
    return { exists: false, path: resolved, lastReview: null, history: [], decisions: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    return {
      exists: true,
      path: resolved,
      version: parsed.version || 1,
      lastReview: parsed.lastReview || null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch (err) {
    return { exists: true, corrupt: true, error: err.message, path: resolved, lastReview: null, history: [], decisions: [] };
  }
}

function saveCadenceState(resolvedPath, state) {
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolvedPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Записывает дату и метаданные проведённой ревизии памяти.
 *
 * @param {string} [statePath]
 * @param {object} [details]
 * @returns {object} Записанная ревизия
 */
export function recordCadenceReview(statePath = DEFAULT_STATE_PATH, details = {}) {
  const resolved = resolvePath(statePath);
  const current = loadCadenceState(resolved);

  const nowIso = new Date().toISOString();
  const review = {
    date: details.date || nowIso,
    reviewer: details.reviewer || process.env.OMP_AGENT_NAME || process.env.USER || process.env.USERNAME || "agent",
    status: details.status || "completed",
    notes: details.notes || "",
    ...details,
  };

  review.date = review.date || nowIso;
  review.reviewer = review.reviewer || "agent";
  review.status = review.status || "completed";

  const history = Array.isArray(current.history) ? [...current.history] : [];
  history.push(review);

  const newState = {
    version: current.version || 1,
    lastReview: review,
    history,
    decisions: Array.isArray(current.decisions) ? current.decisions : [],
  };

  saveCadenceState(resolved, newState);
  return review;
}

/**
 * Записывает решение по элементу памяти (keep, reject, defer) с обоснованием (≥10 символов).
 *
 * @param {string} [statePath]
 * @param {object} [details]
 * @returns {{ id: string, decision: 'keep'|'reject'|'defer', reason: string, at: string }}
 */
export function recordCadenceDecision(statePath = DEFAULT_STATE_PATH, details = {}) {
  const id = details.id != null ? String(details.id).trim() : "";
  if (!id) throw new Error("Decision id is required");
  const decision = details.decision != null ? String(details.decision).trim().toLowerCase() : "";
  if (!["keep", "reject", "defer"].includes(decision)) {
    throw new Error(`Decision must be one of: keep, reject, defer (got: ${JSON.stringify(details.decision)})`);
  }
  const reason = details.reason != null ? String(details.reason).trim() : "";
  if (reason.length < 10) {
    throw new Error(`Decision reason must be at least 10 characters (got: ${reason.length})`);
  }

  const decisionRecord = { id, decision, reason, at: details.at || new Date().toISOString() };
  const resolved = resolvePath(statePath);
  const current = loadCadenceState(resolved);
  const decisions = [...current.decisions];
  const idx = decisions.findIndex((d) => d && String(d.id) === id);
  if (idx !== -1) decisions[idx] = decisionRecord;
  else decisions.push(decisionRecord);

  saveCadenceState(resolved, {
    version: current.version || 1,
    lastReview: current.lastReview || null,
    history: Array.isArray(current.history) ? current.history : [],
    decisions,
  });
  return decisionRecord;
}

function resolveDecisionsMap(source) {
  const map = new Map();
  const list = typeof source === "string"
    ? (loadCadenceState(source).decisions || [])
    : Array.isArray(source)
    ? source
    : (source?.decisions || []);
  for (const item of list) {
    if (item?.id != null) map.set(String(item.id), item);
  }
  return map;
}

/**
 * Формирует сессионный пакет памяти с учетом решений ревизии.
 *
 * @param {Array<object>|object} packOrMemories
 * @param {string|object} [stateOrPath]
 * @returns {Array<object>|object}
 */
export function buildSessionPack(packOrMemories, stateOrPath) {
  if (!packOrMemories) return packOrMemories;
  const decisionsMap = resolveDecisionsMap(stateOrPath);
  const transform = (item) => {
    if (!item) return { include: true, item };
    const id = item.id != null ? String(item.id) : (item._id != null ? String(item._id) : null);
    const dec = id ? decisionsMap.get(id) : null;
    if (!dec) return { include: true, item };
    const d = String(dec.decision || "").toLowerCase();
    if (d === "reject") return { include: false, item: null };
    if (d === "defer" && typeof item === "object") {
      return { include: true, item: { ...item, deferred: true, ...(dec.reason ? { deferReason: dec.reason } : {}) } };
    }
    return { include: true, item };
  };
  const filterList = (arr) => arr.map(transform).filter((r) => r.include).map((r) => r.item);

  if (Array.isArray(packOrMemories)) return filterList(packOrMemories);
  if (typeof packOrMemories === "object") {
    const key = Array.isArray(packOrMemories.memories)
      ? "memories"
      : (Array.isArray(packOrMemories.items) ? "items" : null);
    if (key) return { ...packOrMemories, [key]: filterList(packOrMemories[key]) };
  }
  return packOrMemories;
}
/**
 * Вычисляет daysSinceReview, isOverdue, hindsightConfigured.
 *
 * @param {string} [configPath]
 * @param {string} [statePath]
 * @param {number} [maxDays]
 * @returns {{
 *   daysSinceReview: number|null,
 *   isOverdue: boolean,
 *   hindsightConfigured: boolean,
 *   maxDays: number,
 *   lastReview: object|null,
 *   config: object,
 *   state: object
 * }}
 */
export function checkCadenceStatus(
  configPath = DEFAULT_CONFIG_PATH,
  statePath = DEFAULT_STATE_PATH,
  maxDays = DEFAULT_MAX_DAYS
) {
  const cfg = loadConfig(configPath);
  const state = loadCadenceState(statePath);
  const maxInterval = typeof maxDays === "number" && !isNaN(maxDays) ? maxDays : DEFAULT_MAX_DAYS;

  const hindsightConfigured = Boolean(
    (cfg.hindsight && (cfg.hindsight.apiUrl || cfg.hindsight.bankId)) ||
    (cfg.memory && cfg.memory.backend && cfg.memory.backend !== "off")
  );

  let daysSinceReview = null;
  let isOverdue = true;

  if (state.lastReview && state.lastReview.date) {
    const reviewTime = new Date(state.lastReview.date).getTime();
    if (!isNaN(reviewTime)) {
      const now = Date.now();
      const diffMs = Math.max(0, now - reviewTime);
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      daysSinceReview = Number(diffDays.toFixed(2));
      isOverdue = diffDays > maxInterval;
    }
  }

  return {
    daysSinceReview,
    isOverdue,
    hindsightConfigured,
    maxDays: maxInterval,
    lastReview: state.lastReview || null,
    config: {
      exists: cfg.exists,
      path: cfg.path,
      hindsight: cfg.hindsight,
      memory: cfg.memory,
    },
    state: {
      exists: state.exists,
      path: state.path,
      totalReviews: state.history ? state.history.length : (state.lastReview ? 1 : 0),
    },
  };
}

/**
 * Форматирует человекочитаемый отчет о статусе ревизии памяти.
 *
 * @param {object} status
 * @returns {string}
 */
export function formatCadenceReport(status) {
  const lines = [
    "============================================================",
    "              СТАТУС КАДЕНЦИИ ПАМЯТИ (HINDSIGHT)",
    "============================================================",
  ];

  const statusLabel = status.isOverdue ? "ПРОСРОЧЕНА (OVERDUE)" : "В НОРМЕ (FRESH)";
  lines.push(`Статус каденции:        ${statusLabel}`);
  lines.push(`Макс. интервал:         ${status.maxDays} дн.`);

  if (status.daysSinceReview === null) {
    lines.push("Дней с прошлой ревизии: нет данных (ревизия никогда не проводилась)");
    lines.push("Дата прошлой ревизии:   никогда");
  } else {
    lines.push(`Дней с прошлой ревизии: ${status.daysSinceReview} дн.`);
    lines.push(`Дата прошлой ревизии:   ${status.lastReview?.date || "n/a"}`);
    if (status.lastReview?.reviewer) {
      lines.push(`Ревьюер:                ${status.lastReview.reviewer}`);
    }
    if (status.lastReview?.status) {
      lines.push(`Статус ревизии:         ${status.lastReview.status}`);
    }
    if (status.lastReview?.notes) {
      lines.push(`Заметки:                ${status.lastReview.notes}`);
    }
  }

  lines.push("------------------------------------------------------------");
  lines.push("Конфигурация Hindsight:");
  lines.push(`  Настроен:             ${status.hindsightConfigured ? "ДА" : "НЕТ"}`);
  if (status.config?.hindsight) {
    lines.push(`  Bank ID:              ${status.config.hindsight.bankId || "не указан"}`);
    lines.push(`  API URL:              ${status.config.hindsight.apiUrl || "не указан"}`);
  }
  if (status.config?.memory) {
    lines.push(`  Memory Backend:       ${status.config.memory.backend || "не указан"}`);
  }
  lines.push(`  Конфиг:               ${status.config?.path || "n/a"} (${status.config?.exists ? "найден" : "отсутствует"})`);
  lines.push(`  Файл состояния:       ${status.state?.path || "n/a"} (${status.state?.exists ? "найден" : "отсутствует"})`);

  lines.push("------------------------------------------------------------");
  if (status.isOverdue) {
    lines.push("Рекомендация: ТРЕБУЕТСЯ РЕВИЗИЯ ПАМЯТИ");
    lines.push("  - Проведите ревизию банка Hindsight (очистка устаревших воспоминаний,");
    lines.push("    перенос долгосрочных архитектурных решений в docs/adr/).");
    lines.push("  - Зафиксируйте выполнение: node tools/memory-cadence.mjs --record");
  } else {
    const remainingDays = Math.max(0, Number((status.maxDays - (status.daysSinceReview || 0)).toFixed(1)));
    lines.push(`Рекомендация: Ревизия актуальна. Следующая проверка через ~${remainingDays} дн.`);
  }
  lines.push("============================================================");

  return lines.join("\n");
}

/**
 * Парсер аргументов командной строки.
 * @param {string[]} argv
 * @returns {object}
 */
export const KNOWN_FLAGS = new Set([
  "config", "state", "root", "max-days", "record", "check",
  "status", "json", "help", "reviewer", "notes", "review-status",
  "record-decision", "id", "decision", "reason"
]);

const HELP_TEXT = `memory-cadence.mjs — Контроль свежести ревизии памяти Hindsight

Использование:
  node tools/memory-cadence.mjs [параметры]

Параметры:
  --config <path>     Путь к config.yml (по умолчанию: ~/.omp/agent/config.yml)
  --state <path>      Путь к файлу состояния (по умолчанию: .workflow/memory-cadence.json)
  --max-days <n>      Максимальный интервал между ревизиями в днях (по умолчанию: 7)
  --record            Записать факт проведённой ревизии
  --record-decision   Записать решение по элементу памяти (--id, --decision, --reason)
  --id <id>           ID элемента памяти
  --decision <d>      Решение: keep, reject, defer
  --reason <text>     Обоснование решения (не менее 10 символов)
  --reviewer <name>   Имя ревьюера/агента (при --record)
  --notes <text>      Заметки о ревизии (при --record)
  --review-status <s> Статус ревизии (по умолчанию: completed)
  --check             Проверить свежесть ревизии (exit 1 если просрочена/отсутствует, exit 0 если свежая)
  --status            Подробный статус памяти и каденции (дефолтный режим)
  --json              Вывод в формате JSON
  -h, --help          Показать эту справку
`;

function extractFlag(arg, argv, i, flag) {
  if (arg === `--${flag}`) return { val: argv[i + 1], nextI: i + 1 };
  if (arg.startsWith(`--${flag}=`)) return { val: arg.slice(flag.length + 3), nextI: i };
  return null;
}

function parseDecisionArgs(arg, argv, i, options) {
  if (arg === "--record-decision") {
    options.recordDecision = true;
    return i;
  }
  for (const flag of ["id", "decision", "reason"]) {
    const hit = extractFlag(arg, argv, i, flag);
    if (hit) {
      options[flag] = hit.val;
      return hit.nextI;
    }
  }
  return null;
}

function validateDecisionArgs(options) {
  if (!options.recordDecision) return;
  if (!options.id) options.errors.push("--record-decision требует --id <id>");
  const d = options.decision;
  if (!d) {
    options.errors.push("--record-decision требует --decision <keep|reject|defer>");
  } else if (!["keep", "reject", "defer"].includes(String(d).trim().toLowerCase())) {
    options.errors.push(`--decision должен быть одним из: keep, reject, defer (получено: ${JSON.stringify(d)})`);
  }
  const r = options.reason;
  if (!r || typeof r !== "string" || r.trim().length < 10) {
    options.errors.push(`--reason требует не менее 10 символов (получено: ${JSON.stringify(r)})`);
  }
}

function parseMaxDays(arg, argv, i, options) {
  const hit = extractFlag(arg, argv, i, "max-days");
  if (!hit) return null;
  const parsed = Number.parseFloat(hit.val);
  if (!Number.isFinite(parsed) || parsed < 1) {
    options.errors.push(`--max-days требует число >= 1 (получено: ${JSON.stringify(hit.val)})`);
  } else {
    options.maxDays = parsed;
  }
  return hit.nextI;
}

export function parseArgs(argv = []) {
  const options = {
    config: null, state: null, root: null, maxDays: 7,
    record: false, recordDecision: false, id: null, decision: null, reason: null,
    check: false, status: false, json: false, help: false,
    reviewer: null, notes: null, reviewStatus: "completed", errors: [],
  };

  const strFlags = [
    ["root", "root"], ["config", "config"], ["state", "state"],
    ["reviewer", "reviewer"], ["notes", "notes"], ["review-status", "reviewStatus"],
  ];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const decIdx = parseDecisionArgs(arg, argv, i, options);
    if (decIdx !== null) { i = decIdx; continue; }
    if (arg === "-h" || arg === "--help") { options.help = true; continue; }
    if (arg === "--record") { options.record = true; continue; }
    if (arg === "--check") { options.check = true; continue; }
    if (arg === "--status") { options.status = true; continue; }
    if (arg === "--json") { options.json = true; continue; }

    const maxDaysIdx = parseMaxDays(arg, argv, i, options);
    if (maxDaysIdx !== null) { i = maxDaysIdx; continue; }

    let matched = false;
    for (const [flag, prop] of strFlags) {
      const hit = extractFlag(arg, argv, i, flag);
      if (hit) {
        options[prop] = hit.val;
        i = hit.nextI;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (!KNOWN_FLAGS.has(name)) options.errors.push(`неизвестный параметр: ${arg}`);
    }
  }

  validateDecisionArgs(options);
  return options;
}

function runRecordDecision(statePath, opts) {
  const recorded = recordCadenceDecision(statePath, {
    id: opts.id,
    decision: opts.decision,
    reason: opts.reason,
  });
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ action: "recorded-decision", decision: recorded }, null, 2) + "\n"
    );
  } else {
    process.stdout.write(
      `Решение по памяти успешно записано.\nID: ${recorded.id}\nРешение: ${recorded.decision}\nПричина: ${recorded.reason}\nДата: ${recorded.at}\nФайл: ${statePath}\n`
    );
  }
  return 0;
}

function runRecordReview(statePath, configPath, maxDays, opts) {
  const recorded = recordCadenceReview(statePath, {
    reviewer: opts.reviewer,
    notes: opts.notes || "",
    status: opts.reviewStatus || "completed",
  });
  const status = checkCadenceStatus(configPath, statePath, maxDays);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ action: "recorded", review: recorded, status }, null, 2) + "\n"
    );
  } else {
    process.stdout.write(
      `Ревизия памяти успешно записана.\nДата: ${recorded.date}\nРевьюер: ${recorded.reviewer}\nСтатус: ${recorded.status}\nФайл: ${statePath}\n`
    );
  }
  return opts.check && status.isOverdue ? 1 : 0;
}

/**
 * Главная точка входа.
 * @param {string[]} [argv]
 * @returns {number} Exit code
 */
export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.errors.length > 0) {
    for (const err of opts.errors) process.stderr.write(`Ошибка: ${err}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const baseDir = opts.root ? resolve(opts.root) : process.cwd();
  const statePath = opts.state || join(baseDir, ".workflow", "memory-cadence.json");
  const configPath = opts.config || join(homedir(), ".omp", "agent", "config.yml");
  const maxDays = Number.isNaN(opts.maxDays) ? DEFAULT_MAX_DAYS : opts.maxDays;

  if (opts.recordDecision) return runRecordDecision(statePath, opts);
  if (opts.record) return runRecordReview(statePath, configPath, maxDays, opts);

  const status = checkCadenceStatus(configPath, statePath, maxDays);
  if (opts.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatCadenceReport(status) + "\n");
  }
  return opts.check && status.isOverdue ? 1 : 0;
}

// Запуск при прямом вызове
const isDirectRun = Boolean(process.argv[1]) && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (isDirectRun) {
  const exitCode = main(process.argv.slice(2));
  process.exitCode = typeof exitCode === "number" ? exitCode : 0;
}
