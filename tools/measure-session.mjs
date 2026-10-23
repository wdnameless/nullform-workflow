/**
 * measure-session.mjs — замер сессии Nullform из реальных артефактов.
 * Входы: .workflow/state.json (startedAt/closedAt/waits), metrics.jsonl (если есть), usageLog.
 * Нормировка через normalizedCost из tools/cost-snapshot.mjs.
 * Время через honestTime/beats из tools/journal.mjs (waits вычитаются).
 * Детерминирован: одинаковый вход = одинаковый выход. Без сети и платных вызовов.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizedCost } from "./cost-snapshot.mjs";
import { honestTime } from "./journal.mjs";
import { parseJsonSafe, readJsonlSafe, resolveLogFile as resolveFile } from "./session-log.mjs";


/**
 * Замер метрик сессии из артефактов рабочего каталога и лога использования.
 *
 * @param {string} root Путь к корневой директории сессии или проекта
 * @param {object} [options]
 * @param {Array|object|string} [options.usageLog] Лог использования или путь к JSON-файлу
 * @param {Array|object|string} [options.usage] Алиас для usageLog
 * @param {string} [options.usageFile] Путь к JSON-файлу с usage
 * @param {number} [options.tests] Явное число тестов (перекрывает извлечение)
 * @returns {{ roles: Record<string, any>, total: number, wallMs: number, activeMs: number, tests: number, ms: number }}
 */
export function measureSession(root = process.cwd(), options = {}) {
  const rootDir = resolve(root);

  // 1. Чтение .workflow/state.json
  const statePath = resolveFile(rootDir, [".workflow/state.json", "state.json"]);
  const state = statePath ? (parseJsonSafe(readFileSync(statePath, "utf8")) || {}) : {};

  // 2. Чтение metrics.jsonl
  const metricsPath = resolveFile(rootDir, [".workflow/metrics.jsonl", "metrics.jsonl"]);
  const metrics = metricsPath ? readJsonlSafe(metricsPath) : [];

  // 3. Чтение events.jsonl
  const eventsPath = resolveFile(rootDir, [".workflow/events.jsonl", "events.jsonl"]);
  const events = eventsPath ? readJsonlSafe(eventsPath) : [];

  // 4. Определение временных границ (startedAt / closedAt)
  let startedAt = state.startedAt || state.started || null;
  let closedAt = state.closedAt || state.closed || null;

  // Если closedAt отсутствует, ищем в metrics.jsonl
  if (!closedAt && metrics.length > 0) {
    let matchedMetric = null;
    if (startedAt) {
      matchedMetric = metrics.find((m) => m && m.startedAt === startedAt);
    }
    if (!matchedMetric && state.task) {
      matchedMetric = metrics.find((m) => m && m.task === state.task);
    }
    if (!matchedMetric && state.status === "closed") {
      matchedMetric = metrics[metrics.length - 1];
    }
    if (matchedMetric) {
      closedAt = matchedMetric.closedAt || null;
      if (!startedAt) startedAt = matchedMetric.startedAt || null;
    }
  }

  // Если все еще нет closedAt, проверяем события events.jsonl
  if (!closedAt && events.length > 0) {
    const closeEvent = events.find((e) => e && e.kind === "close");
    if (closeEvent && closeEvent.at) {
      closedAt = closeEvent.at;
    } else if (state.status === "closed") {
      const lastEvent = events[events.length - 1];
      if (lastEvent && lastEvent.at) closedAt = lastEvent.at;
    }
  }

  // Wall time
  let wallMs = 0;
  if (startedAt && closedAt) {
    const s = new Date(startedAt).getTime();
    const e = new Date(closedAt).getTime();
    if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) {
      wallMs = e - s;
    }
  } else if (typeof state.durationMs === "number" && state.durationMs >= 0) {
    wallMs = state.durationMs;
  }

  // 5. Определение beats и waits для honestTime
  let beats = [];
  if (Array.isArray(state.beats)) {
    beats = state.beats;
  } else if (Array.isArray(state.journal?.beats)) {
    beats = state.journal.beats;
  } else {
    const beatSet = new Set();
    if (startedAt) beatSet.add(startedAt);
    if (closedAt) beatSet.add(closedAt);

    if (state.artifacts && typeof state.artifacts === "object") {
      for (const art of Object.values(state.artifacts)) {
        if (art && art.at) beatSet.add(art.at);
      }
    }

    if (events.length > 0) {
      const sTime = startedAt ? new Date(startedAt).getTime() : -Infinity;
      const eTime = closedAt ? new Date(closedAt).getTime() : Infinity;
      for (const ev of events) {
        if (ev && ev.at) {
          const evTime = new Date(ev.at).getTime();
          if (!Number.isNaN(evTime) && evTime >= sTime && evTime <= eTime) {
            beatSet.add(ev.at);
          }
        }
      }
    }

    beats = Array.from(beatSet).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  }

  const waits = Array.isArray(state.waits)
    ? state.waits
    : (Array.isArray(state.journal?.waits) ? state.journal.waits : []);

  const activeMs = honestTime({ beats, waits });

  // 6. Разбор usageLog
  let rawUsage = options.usageLog ?? options.usage;
  if (!rawUsage && options.usageFile) {
    const p = resolve(rootDir, options.usageFile);
    if (existsSync(p)) {
      rawUsage = parseJsonSafe(readFileSync(p, "utf8"));
    }
  }

  if (typeof rawUsage === "string") {
    const p = resolve(rootDir, rawUsage);
    if (existsSync(p)) {
      rawUsage = parseJsonSafe(readFileSync(p, "utf8"));
    }
  }

  let entries = [];
  if (Array.isArray(rawUsage)) {
    entries = rawUsage;
  } else if (rawUsage && typeof rawUsage === "object") {
    if (Array.isArray(rawUsage.usageLog)) {
      entries = rawUsage.usageLog;
    } else if (rawUsage.roles && typeof rawUsage.roles === "object") {
      entries = Object.entries(rawUsage.roles).map(([role, val]) => ({ role, ...(val || {}) }));
    } else {
      entries = Object.entries(rawUsage).map(([role, val]) => ({ role, ...(val || {}) }));
    }
  }

  const roleAggregates = new Map();
  let totalTestsFromLog = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const roleName = String(entry.role || entry.name || "default");
    const calls = Number(entry.calls ?? 1);
    const out = Number(entry.output ?? entry.out ?? 0);
    const write = Number(entry.cacheWrite ?? entry.write ?? 0);
    const read = Number(entry.cacheRead ?? entry.read ?? 0);
    const duration = Number(entry.ms ?? entry.durationMs ?? 0);
    const roleTests = Number(entry.tests ?? 0);
    totalTestsFromLog += roleTests;

    let agg = roleAggregates.get(roleName);
    if (!agg) {
      agg = { role: roleName, calls: 0, output: 0, cacheWrite: 0, cacheRead: 0, ms: 0, tests: 0 };
      roleAggregates.set(roleName, agg);
    }
    agg.calls += calls;
    agg.output += out;
    agg.cacheWrite += write;
    agg.cacheRead += read;
    agg.ms += duration;
    agg.tests += roleTests;
  }

  const roles = {};
  let totalUnits = 0;

  for (const [roleName, agg] of roleAggregates.entries()) {
    const cost = normalizedCost({
      output: agg.output,
      cacheWrite: agg.cacheWrite,
      cacheRead: agg.cacheRead,
    }, roleName);

    roles[roleName] = {
      role: roleName,
      calls: agg.calls,
      output: agg.output,
      cacheWrite: agg.cacheWrite,
      cacheRead: agg.cacheRead,
      units: Math.round(cost.units * 100) / 100,
      cacheChurn: cost.cacheChurn,
      ms: agg.ms,
      tests: agg.tests,
    };

    totalUnits += cost.units;
  }

  const total = Math.round(totalUnits * 100) / 100;

  let testsCount = 0;
  if (typeof options.tests === "number") {
    testsCount = options.tests;
  } else if (typeof state.tests === "number") {
    testsCount = state.tests;
  } else {
    testsCount = totalTestsFromLog;
  }

  return {
    roles,
    total,
    wallMs,
    activeMs,
    tests: testsCount,
    ms: activeMs,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  let usagePath = null;
  let root = process.cwd();
  let json = false;

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--usage" && args[idx + 1]) usagePath = args[++idx];
    else if (arg.startsWith("--usage=")) usagePath = arg.slice(8);
    else if (arg === "--root" && args[idx + 1]) root = args[++idx];
    else if (arg.startsWith("--root=")) root = arg.slice(7);
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("-")) root = arg;
  }

  let usageLog = null;
  if (usagePath) {
    const target = resolve(process.cwd(), usagePath);
    if (!existsSync(target)) {
      process.stderr.write(`Usage file missing: ${target}\n`);
      process.exit(1);
    }
    usageLog = parseJsonSafe(readFileSync(target, "utf8"));
  }

  const summary = measureSession(root, { usageLog });
  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(`Session: total=${summary.total} units, wall=${summary.wallMs}ms, active=${summary.activeMs}ms, tests=${summary.tests}\n`);
    for (const [name, r] of Object.entries(summary.roles)) {
      process.stdout.write(`  ${name}: ${r.units} units (${r.calls} calls, churn=${r.cacheChurn})\n`);
    }
  }
}
