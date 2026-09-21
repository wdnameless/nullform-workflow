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
 *   - checkCadenceStatus(configPath, statePath, maxDays)
 *   - formatCadenceReport(status)
 *   - parseArgs(argv)
 *   - resolvePath(filePath)
 *   - cleanYamlValue(val)
 *   - main(argv)
 *
 * CLI:
 *   node tools/memory-cadence.mjs [--status] [--check] [--record] [--json] [--config <path>] [--state <path>] [--max-days <n>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 *   history: Array<any>
 * }}
 */
export function loadCadenceState(statePath = DEFAULT_STATE_PATH) {
  const resolved = resolvePath(statePath);
  if (!existsSync(resolved)) {
    return {
      exists: false,
      path: resolved,
      lastReview: null,
      history: [],
    };
  }

  try {
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    return {
      exists: true,
      path: resolved,
      version: parsed.version || 1,
      lastReview: parsed.lastReview || null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (err) {
    return {
      exists: true,
      corrupt: true,
      error: err.message,
      path: resolved,
      lastReview: null,
      history: [],
    };
  }
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
  };

  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(resolved, JSON.stringify(newState, null, 2) + "\n", "utf8");
  return review;
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
  "status", "json", "help", "reviewer", "notes", "review-status"
]);

export function parseArgs(argv = []) {
  const options = {
    config: null,
    state: null,
    root: null,
    maxDays: 7,
    record: false,
    check: false,
    status: false,
    json: false,
    help: false,
    reviewer: null,
    notes: null,
    reviewStatus: "completed",
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--record") {
      options.record = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--status") {
      options.status = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root") {
      options.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--config") {
      options.config = argv[++i];
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
    } else if (arg === "--state") {
      options.state = argv[++i];
    } else if (arg.startsWith("--state=")) {
      options.state = arg.slice("--state=".length);
    } else if (arg === "--max-days" || arg.startsWith("--max-days=")) {
      const raw = arg.startsWith("--max-days=") ? arg.slice("--max-days=".length) : argv[++i];
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        options.errors.push(`--max-days требует число >= 1 (получено: ${JSON.stringify(raw)})`);
      } else {
        options.maxDays = parsed;
      }
    } else if (arg === "--reviewer" || arg.startsWith("--reviewer=")) {
      options.reviewer = arg.startsWith("--reviewer=") ? arg.slice("--reviewer=".length) : argv[++i];
    } else if (arg === "--notes") {
      options.notes = argv[++i];
    } else if (arg.startsWith("--notes=")) {
      options.notes = arg.slice("--notes=".length);
    } else if (arg === "--review-status") {
      options.reviewStatus = argv[++i];
    } else if (arg.startsWith("--review-status=")) {
      options.reviewStatus = arg.slice("--review-status=".length);
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (!KNOWN_FLAGS.has(name)) {
        options.errors.push(`неизвестный параметр: ${arg}`);
      }
    }
  }

  return options;
}

/**
 * Главная точка входа.
 * @param {string[]} [argv]
 * @returns {number} Exit code
 */
export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.errors.length > 0) {
    for (const err of opts.errors) {
      process.stderr.write(`Ошибка: ${err}\n`);
    }
    return 2;
  }
  if (opts.help) {
    const helpText = `memory-cadence.mjs — Контроль свежести ревизии памяти Hindsight

Использование:
  node tools/memory-cadence.mjs [параметры]

Параметры:
  --config <path>     Путь к config.yml (по умолчанию: ~/.omp/agent/config.yml)
  --state <path>      Путь к файлу состояния (по умолчанию: .workflow/memory-cadence.json)
  --max-days <n>      Максимальный интервал между ревизиями в днях (по умолчанию: 7)
  --record            Записать факт проведённой ревизии
  --reviewer <name>   Имя ревьюера/агента (при --record)
  --notes <text>      Заметки о ревизии (при --record)
  --review-status <s> Статус ревизии (по умолчанию: completed)
  --check             Проверить свежесть ревизии (exit 1 если просрочена/отсутствует, exit 0 если свежая)
  --status            Подробный статус памяти и каденции (дефолтный режим)
  --json              Вывод в формате JSON
  -h, --help          Показать эту справку
`;
    process.stdout.write(helpText);
    return 0;
  }

  const baseDir = opts.root ? resolve(opts.root) : process.cwd();
  const defaultStatePath = join(baseDir, ".workflow", "memory-cadence.json");
  const defaultConfigPath = join(homedir(), ".omp", "agent", "config.yml");

  const statePath = opts.state || defaultStatePath;
  const configPath = opts.config || defaultConfigPath;
  const maxDays = Number.isNaN(opts.maxDays) ? DEFAULT_MAX_DAYS : opts.maxDays;

  if (opts.record) {
    const recordDetails = {
      reviewer: opts.reviewer,
      notes: opts.notes || "",
      status: opts.reviewStatus || "completed",
    };
    const recorded = recordCadenceReview(statePath, recordDetails);
    const status = checkCadenceStatus(configPath, statePath, maxDays);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            action: "recorded",
            review: recorded,
            status,
          },
          null,
          2
        ) + "\n"
      );
    } else {
      process.stdout.write(
        `Ревизия памяти успешно записана.\nДата: ${recorded.date}\nРевьюер: ${recorded.reviewer}\nСтатус: ${recorded.status}\nФайл: ${statePath}\n`
      );
    }

    if (opts.check) {
      return status.isOverdue ? 1 : 0;
    }
    return 0;
  }

  const status = checkCadenceStatus(configPath, statePath, maxDays);

  if (opts.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    process.stdout.write(formatCadenceReport(status) + "\n");
  }

  if (opts.check) {
    return status.isOverdue ? 1 : 0;
  }

  return 0;
}

// Запуск при прямом вызове
const isDirectRun =
  Boolean(process.argv[1]) &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href ||
    process.argv[1].endsWith("memory-cadence.mjs"));

if (isDirectRun) {
  const exitCode = main(process.argv.slice(2));
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}
