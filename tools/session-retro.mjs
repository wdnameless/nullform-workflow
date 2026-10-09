#!/usr/bin/env node
/**
 * tools/session-retro.mjs — ретроспектива по сессиям агентов.
 *
 * Сканирует .jsonl логи сессий и выделяет сессии с признаками скрытых
 * неэффективностей: ошибки/ретраи, крупные чтения, повторяющиеся команды,
 * длинные сессии. Вывод — ранжированный список кандидатов для разбора
 * человеком (skill://session-retro). Сам инструмент исправлений НЕ вносит:
 * находки применяются вручную через обычные workflow-лейны.
 *
 * Экспорты:
 *   - findJsonlFiles(dir)
 *   - parseSessionFile(path)
 *   - scoreSession(summary)
 *   - scanSessions(sessionsDir, { days, limit, now })
 *   - formatRetroReport(result, { limit })
 *   - recordRetroReview(statePath, details)
 *   - loadRetroState(statePath)
 *   - parseArgs(argv)
 *
 * CLI:
 *   node tools/session-retro.mjs scan [--sessions <dir>] [--days <n>] [--limit <n>] [--json]
 *   node tools/session-retro.mjs record [--state <path>] [--detail <text>]
 *   node tools/session-retro.mjs status [--state <path>] [--max-days <n>]
 */

import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
export const DEFAULT_STATE_PATH = join(process.cwd(), ".workflow", "session-retro.json");
export const DEFAULT_MAX_DAYS = 7;

/** Рекурсивный поиск .jsonl файлов. */
export function findJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findJsonlFiles(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * Парсит один .jsonl файл сессии в компактную сводку сигналов.
 * Формат строк терпимый: пропускаем пустые и битые строки.
 */
export function parseSessionFile(path) {
  const summary = {
    path,
    lines: 0,
    malformed: 0,
    toolCalls: 0,
    errors: 0,
    retries: 0,
    readBytes: 0,
    readCalls: 0,
    bashCalls: 0,
    failedBash: 0,
    lastCommandCounts: new Map(),
    errorSamples: [],
  };
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return summary;
  }
  let prevFailCommand = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    summary.lines++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      summary.malformed++;
      continue;
    }
    const text = JSON.stringify(rec);
    const lower = text.toLowerCase();
    const isError =
      lower.includes('"exitcode":1') ||
      lower.includes('"exit_code":1') ||
      lower.includes("error") ||
      lower.includes("failed") ||
      lower.includes("exception") ||
      lower.includes("timeout");
    if (isError) {
      summary.errors++;
      if (summary.errorSamples.length < 3 && text.length < 500) summary.errorSamples.push(text.slice(0, 300));
    }
    const blocks = Array.isArray(rec?.message?.content)
      ? rec.message.content
      : Array.isArray(rec?.content)
        ? rec.content
        : [];
    const candidates = [...blocks];
    if (rec?.type === "toolCall" || rec?.type === "tool_use") candidates.push(rec);
    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const name = item.name;
      if (!name || typeof name !== "string") continue;
      summary.toolCalls++;
      if (name === "read") {
        summary.readCalls++;
        const args = item.arguments || item.input || {};
        if (typeof args.content === "string") summary.readBytes += args.content.length;
        // Эвристика крупного чтения: диапазон на сотни строк или полный файл без селектора.
        const p = typeof args.path === "string" ? args.path : "";
        if (/:\d+-\d+/.test(p)) {
          const m = /:(\d+)-(\d+)/.exec(p);
          if (m && Number(m[2]) - Number(m[1]) > 300) summary.readBytes += 20000;
        } else if (p && !p.includes(":") && !p.startsWith("skill://")) {
          summary.readBytes += 8000;
        }
      }
      if (name === "bash") {
        summary.bashCalls++;
        const args = item.arguments || item.input || {};
        const cmd = typeof args.command === "string" ? args.command.slice(0, 80) : "";
        if (cmd) summary.lastCommandCounts.set(cmd, (summary.lastCommandCounts.get(cmd) || 0) + 1);
        if (isError) {
          summary.failedBash++;
          if (prevFailCommand && cmd && prevFailCommand === cmd) summary.retries++;
          prevFailCommand = cmd || null;
        } else if (cmd) {
          prevFailCommand = null;
        }
      }
    }
  }
  return summary;
}

/**
 * Оценивает сводку сессии: чем выше score, тем приоритетнее разбор человеком.
 * Эвристики намеренно грубые — финальное слово за человеком (skill://session-retro).
 */
export function scoreSession(s) {
  const signals = [];
  let score = 0;
  if (s.errors >= 5) {
    score += Math.min(30, s.errors * 2);
    signals.push(`errors:${s.errors}`);
  }
  if (s.retries > 0) {
    score += Math.min(25, s.retries * 8);
    signals.push(`retries:${s.retries}`);
  }
  if (s.failedBash >= 3) {
    score += Math.min(20, s.failedBash * 4);
    signals.push(`failed-bash:${s.failedBash}`);
  }
  if (s.readBytes > 100000) {
    score += 15;
    signals.push(`heavy-reads:~${Math.round(s.readBytes / 1000)}kb`);
  } else if (s.readCalls > 40) {
    score += 10;
    signals.push(`many-reads:${s.readCalls}`);
  }
  if (s.toolCalls > 300) {
    score += 15;
    signals.push(`long-session:${s.toolCalls}-calls`);
  } else if (s.toolCalls > 120) {
    score += 7;
    signals.push(`medium-session:${s.toolCalls}-calls`);
  }
  if (s.malformed > s.lines / 2 && s.lines > 0) {
    score += 5;
    signals.push(`malformed-log:${s.malformed}`);
  }
  // Повтор одной команды 3+ раз — запах зацикливания.
  for (const [cmd, n] of s.lastCommandCounts) {
    if (n >= 3) {
      score += 10;
      signals.push(`repeat-x${n}:${cmd.slice(0, 50)}`);
      break;
    }
  }
  // Категории-подсказки для разбора по skill://session-retro.
  const hints = [];
  if (s.retries > 0 || s.failedBash >= 3) hints.push("guardrail/tool-economy");
  if (s.readBytes > 100000 || s.readCalls > 40) hints.push("navigate/tokens");
  if (s.toolCalls > 300) hints.push("compaction/instructions");
  if (s.errors >= 5) hints.push("standards/context");
  return { score, signals, hints: [...new Set(hints)] };
}

/** Сканирует каталог сессий, возвращает ранжированных кандидатов. */
export function scanSessions(sessionsDir, { days = 30, limit = 10, now = Date.now() } = {}) {
  if (!sessionsDir || !existsSync(sessionsDir)) {
    return { empty: true, reason: "Каталог сессий не существует: " + (sessionsDir || "не указан"), candidates: [] };
  }
  const files = findJsonlFiles(sessionsDir);
  if (files.length === 0) {
    return { empty: true, reason: "В каталоге сессий нет .jsonl файлов", candidates: [] };
  }
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const candidates = [];
  let scanned = 0;
  for (const f of files) {
    try {
      if (now - statSync(f).mtimeMs > maxAgeMs) continue;
    } catch {
      continue;
    }
    scanned++;
    const summary = parseSessionFile(f);
    const { score, signals, hints } = scoreSession(summary);
    if (score > 0) candidates.push({ file: f, score, signals, hints, lines: summary.lines, toolCalls: summary.toolCalls });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { empty: candidates.length === 0, reason: candidates.length === 0 ? "Сигналов неэффективности не найдено" : "", scanned, candidates: candidates.slice(0, limit) };
}

/** Текстовый отчёт для человека. */
export function formatRetroReport(result, { limit = 10 } = {}) {
  if (result.empty) return `session-retro: ${result.reason || "нечего разбирать"}`;
  const rows = result.candidates.slice(0, limit).map((c, i) => {
    const name = basename(c.file);
    return `${i + 1}. [score ${c.score}] ${name}\n   сигналы: ${c.signals.join(", ") || "—"}\n   куда смотреть: ${c.hints.join(", ") || "общий разбор"}\n   файл: ${c.file}`;
  });
  return [
    `session-retro: просканировано сессий: ${result.scanned}, кандидатов к разбору: ${result.candidates.length}`,
    ``,
    ...rows,
    ``,
    `Дальше — skill://session-retro: разобрать топ-кандидатов вручную, находки подтвердить у человека.`,
  ].join("\n");
}
export const SERVICE_COMMAND_PATTERNS = [
  /^git\s+(status|diff|log|show|branch|rev-parse)\b/i,
  /^(ls|dir|pwd|echo|cat|head|tail|which|where|whoami|date)\b/i,
];

export function isServiceOrReadonlyCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  return SERVICE_COMMAND_PATTERNS.some((pat) => pat.test(trimmed));
}

export function extractCmdPrefix(cmd) {
  if (!cmd) return "<cmd-prefix>";
  const parts = cmd.trim().split(/\s+/);
  const prefix = parts.slice(0, 3).join(" ");
  return prefix.replace(/[|&;]+$/, "").trim() || cmd.trim();
}

export function sanitizeErrorSample(sample) {
  if (!sample || typeof sample !== "string") return "";
  let extracted = "";

  try {
    const obj = JSON.parse(sample);
    if (typeof obj === "string") {
      extracted = obj;
    } else if (obj && typeof obj === "object") {
      if (typeof obj.error === "string") extracted = obj.error;
      else if (typeof obj.error?.message === "string") extracted = obj.error.message;
      else if (typeof obj.result?.error === "string") extracted = obj.result.error;
      else if (typeof obj.result?.output === "string") extracted = obj.result.output;
      else if (typeof obj.output === "string") extracted = obj.output;
      else if (typeof obj.message === "string") extracted = obj.message;
      else if (typeof obj.message?.content === "string") extracted = obj.message.content;
      else if (Array.isArray(obj.message?.content)) {
        const textItem = obj.message.content.find((c) => c && typeof c.text === "string");
        if (textItem) extracted = textItem.text;
      } else if (Array.isArray(obj.content)) {
        const textItem = obj.content.find((c) => c && typeof c.text === "string");
        if (textItem) extracted = textItem.text;
      } else if (typeof obj.stderr === "string") extracted = obj.stderr;
      else if (typeof obj.details === "string") extracted = obj.details;
      else if (typeof obj.reason === "string") extracted = obj.reason;
    }
  } catch {
    // Non-JSON or truncated JSON
  }

  // 2. Если из объекта не извлекли (или JSON был обрезан), ищем ключевые поля по регулярке
  if (!extracted) {
    const fieldMatch = sample.match(/"(?:output|error|message|text|stderr|details|reason)"\s*:\s*"([^"\r\n]+)/i);
    if (fieldMatch) {
      extracted = fieldMatch[1];
    }
  }

  // 3. Если всё ещё не извлекли, очищаем от любых JSON-ключей, двоеточий, скобок
  if (!extracted) {
    extracted = sample
      .replace(/"[a-zA-Z0-9_-]+"\s*:/g, " ")
      .replace(/[{}\[\]"]/g, " ");
  }

  let cleaned = extracted
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\t/g, " ")
    .replace(/\\r/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = cleaned.replace(/^[\s{}[\]"':,]+|[\s{}[\]"':,]+$/g, "");

  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 80).trim();
    cleaned = cleaned.replace(/[\s{}[\]"':,]+$/g, "");
  }

  return cleaned;
}

export function ruleForRepeat(type, cmd) {
  if (type === "repeat-bash") {
    const p = extractCmdPrefix(cmd);
    return `guardrail: ${p} — проверять <условие> до повтора`;
  }
  if (type === "many-reads") {
    return "navigate: читать <паттерн> через диапазон строк вместо полного файла";
  }
  if (type === "long-session") {
    return "compaction: разбивать задачи >N вызовов";
  }
  if (type === "retries/errors") {
    return "preflight: <команда> --dry-run перед выполнением";
  }
  return "guardrail: <условие>";
}
/** Агрегирует повторы по сессиям и генерирует однострочные шаблоны правил. */
export function suggestSessions(sessionsDir, { days = 30, limit = 5, now = Date.now() } = {}) {
  if (!sessionsDir || !existsSync(sessionsDir)) return [];
  const files = findJsonlFiles(sessionsDir);
  if (files.length === 0) return [];
  const maxAgeMs = typeof days === "number" && days > 0 ? days * 24 * 60 * 60 * 1000 : Infinity;
  const validFiles = [];
  for (const f of files) {
    try {
      if (maxAgeMs !== Infinity && now - statSync(f).mtimeMs > maxAgeMs) continue;
      validFiles.push(f);
    } catch {
      continue;
    }
  }
  if (validFiles.length === 0) return [];
  const totalSessions = validFiles.length;

  const aggregated = new Map();

  for (const f of validFiles) {
    const summary = parseSessionFile(f);
    const scored = scoreSession(summary);
    const sessionRepeats = new Map();

    // 1. Повторяющиеся bash-команды (исключая служебные/ридонли команды)
    for (const [cmd, n] of summary.lastCommandCounts) {
      if (n >= 2 && !isServiceOrReadonlyCommand(cmd)) {
        const key = `repeat-bash: ${cmd}`;
        sessionRepeats.set(key, { repeat: key, type: "repeat-bash", cmd });
      }
    }

    // 2. many-reads
    if (
      summary.readCalls > 40 ||
      summary.readBytes > 100000 ||
      scored.signals.some((s) => s.startsWith("many-reads") || s.startsWith("heavy-reads"))
    ) {
      sessionRepeats.set("many-reads", { repeat: "many-reads", type: "many-reads" });
    }

    // 3. long-session
    if (
      summary.toolCalls > 120 ||
      scored.signals.some((s) => s.startsWith("long-session") || s.startsWith("medium-session"))
    ) {
      sessionRepeats.set("long-session", { repeat: "long-session", type: "long-session" });
    }

    // 4. retries / errors / errorSamples
    if (summary.retries > 0 || summary.errors >= 5 || summary.errorSamples.length > 0) {
      let added = false;
      if (summary.errorSamples.length > 0) {
        for (const sample of summary.errorSamples) {
          const sampleText = sanitizeErrorSample(sample);
          if (sampleText) {
            const key = `retries/errors: ${sampleText}`;
            sessionRepeats.set(key, { repeat: key, type: "retries/errors" });
            added = true;
          }
        }
      }
      if (!added) {
        sessionRepeats.set("retries/errors", { repeat: "retries/errors", type: "retries/errors" });
      }
    }

    for (const [key, item] of sessionRepeats) {
      const prev = aggregated.get(key);
      if (prev) {
        prev.sessions++;
      } else {
        aggregated.set(key, { ...item, sessions: 1 });
      }
    }
  }

  const result = [];
  for (const item of aggregated.values()) {
    result.push({
      repeat: item.repeat,
      sessions: item.sessions,
      totalSessions,
      rule: ruleForRepeat(item.type, item.cmd),
    });
  }

  result.sort((a, b) => b.sessions - a.sessions || a.repeat.localeCompare(b.repeat));
  return result.slice(0, limit);
}

/** Текстовый отчёт с нумерованным топ-5 повторов и правил. */
export function formatSuggestReport(result) {
  const items = Array.isArray(result) ? result : (result?.suggestions || []);
  if (items.length === 0) return "";
  return items
    .map((item, i) => `${i + 1}. ${item.repeat} (встречается в ${item.sessions} сессий из ${item.totalSessions}) → ${item.rule}`)
    .join("\n");
}

export function loadRetroState(statePath = DEFAULT_STATE_PATH) {
  try {
    if (!existsSync(statePath)) return { reviews: [] };
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { reviews: [] };
  }
}

export function recordRetroReview(statePath = DEFAULT_STATE_PATH, details = {}) {
  const resolved = resolve(statePath);
  mkdirSync(dirname(resolved), { recursive: true });
  const state = loadRetroState(resolved);
  if (!Array.isArray(state.reviews)) state.reviews = [];
  state.reviews.push({ at: new Date().toISOString(), ...details });
  writeFileSync(resolved, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

export function parseArgs(argv) {
  const hasCmd = Boolean(argv[0] && !argv[0].startsWith("--"));
  const cmd = hasCmd ? argv[0] : "scan";
  const rest = hasCmd ? argv.slice(1) : argv;
  const opts = { cmd, sessions: DEFAULT_SESSIONS_DIR, days: 30, limit: cmd === "suggest" || rest.includes("--suggest") ? 5 : 10, json: false, state: DEFAULT_STATE_PATH, maxDays: DEFAULT_MAX_DAYS, detail: "", help: false, errors: [] };
  const known = new Set(["sessions", "days", "limit", "json", "state", "max-days", "detail", "help", "suggest"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      opts.errors.push(`неожиданный аргумент: ${a}`);
      continue;
    }
    const key = a.slice(2).split("=")[0];
    if (!known.has(key)) {
      opts.errors.push(`неизвестный параметр: ${a}`);
      continue;
    }
    if (key === "suggest") {
      opts.cmd = "suggest";
      continue;
    }
    if (key === "json" || key === "help") {
      opts[key === "help" ? "help" : key] = true;
      continue;
    }
    const val = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
    if (key === "sessions") opts.sessions = val || opts.sessions;
    else if (key === "state") opts.state = val || opts.state;
    else if (key === "detail") opts.detail = val || "";
    else if (key === "days" || key === "limit" || key === "max-days") {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) opts.errors.push(`--${key} должен быть положительным числом`);
      else opts[key === "max-days" ? "maxDays" : key] = Math.floor(n);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`session-retro.mjs — ретроспектива по сессиям агентов

Использование:
  node tools/session-retro.mjs scan [--sessions <dir>] [--days <n>] [--limit <n>] [--json]
  node tools/session-retro.mjs suggest [--sessions <dir>] [--days <n>] [--limit <n>] [--json]
  node tools/session-retro.mjs record [--state <path>] [--detail <text>]
  node tools/session-retro.mjs status [--state <path>] [--max-days <n>]

scan выделяет сессии-кандидаты для ручного разбора (skill://session-retro).
suggest агрегирует повторы по сессиям и предлагает правила.
record фиксирует проведённый разбор. status проверяет свежесть каденции.
`);
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (opts.errors.length > 0) {
    for (const e of opts.errors) process.stderr.write(`Ошибка: ${e}\n`);
    process.exit(2);
  }
  if (opts.cmd === "suggest") {
    const res = suggestSessions(opts.sessions, { days: opts.days, limit: opts.limit });
    if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else {
      const rep = formatSuggestReport(res);
      if (rep) process.stdout.write(rep + "\n");
    }
    process.exit(0);
  } else if (opts.cmd === "scan") {
    const res = scanSessions(opts.sessions, { days: opts.days, limit: opts.limit });
    if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else process.stdout.write(formatRetroReport(res, { limit: opts.limit }) + "\n");
    process.exit(0);
  } else if (opts.cmd === "record") {
    recordRetroReview(opts.state, { detail: opts.detail });
    process.stdout.write(`session-retro: разбор зафиксирован (${resolve(opts.state)})\n`);
    process.exit(0);
  } else if (opts.cmd === "status") {
    const state = loadRetroState(resolve(opts.state));
    const last = Array.isArray(state.reviews) && state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;
    const ageDays = last ? (Date.now() - new Date(last.at).getTime()) / 86400000 : Infinity;
    if (!last) {
      process.stdout.write(`session-retro: разборы ещё не проводились (порог ${opts.maxDays} дн.)\n`);
      process.exit(1);
    } else if (ageDays > opts.maxDays) {
      process.stdout.write(`session-retro: последний разбор ${last.at} — просрочен (>${opts.maxDays} дн.)\n`);
      process.exit(1);
    } else {
      process.stdout.write(`session-retro: последний разбор ${last.at} — в норме\n`);
      process.exit(0);
    }
  } else {
    process.stderr.write(`Ошибка: неизвестная команда: ${opts.cmd} (scan|suggest|record|status)\n`);
    process.exit(2);
  }
}
