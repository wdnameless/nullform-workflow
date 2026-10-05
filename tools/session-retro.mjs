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
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "scan";
  const rest = cmd === argv[0] && !argv[0]?.startsWith("--") ? argv.slice(1) : argv;
  const opts = { cmd, sessions: DEFAULT_SESSIONS_DIR, days: 30, limit: 10, json: false, state: DEFAULT_STATE_PATH, maxDays: DEFAULT_MAX_DAYS, detail: "", help: false, errors: [] };
  const known = new Set(["sessions", "days", "limit", "json", "state", "max-days", "detail", "help"]);
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
  node tools/session-retro.mjs record [--state <path>] [--detail <text>]
  node tools/session-retro.mjs status [--state <path>] [--max-days <n>]

scan выделяет сессии-кандидаты для ручного разбора (skill://session-retro).
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
  if (opts.cmd === "scan") {
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
    process.stderr.write(`Ошибка: неизвестная команда: ${opts.cmd} (scan|record|status)\n`);
    process.exit(2);
  }
}
