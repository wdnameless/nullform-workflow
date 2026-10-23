#!/usr/bin/env node
/**
 * tools/bench-analytics.mjs — агрегация и сравнение прогонов (выделено из benchmark.mjs 1:1).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNS_DIR, loadTasks, computePassK } from "./benchmark.mjs";

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Считывает тиры задач из bench/tasks.json (тир по умолчанию: standard).
 * @param {string} root
 * @returns {Map<string, string>}
 */
function readTaskTiers(root) {
  const map = new Map();
  try {
    const data = loadTasks(root);
    for (const t of data.tasks || []) {
      if (t && t.id) {
        map.set(t.id, t.tier || "standard");
      }
    }
  } catch {
    // tasks.json отсутствует или повреждён
  }
  return map;
}

export function summarizeRuns(root, options = {}) {
  const absRoot = resolve(root || ".");
  const runsDir = join(absRoot, RUNS_DIR);
  const tierFilter = options.tier || null;

  const skipped = [];
  let entries = [];
  if (existsSync(runsDir)) {
    try {
      entries = readdirSync(runsDir);
    } catch {
      entries = [];
    }
  }

  // Тир берётся из result.json, а для прогонов, записанных до появления поля, — из bench/tasks.json.
  const taskTiers = readTaskTiers(absRoot);

  const byTaskArm = {};
  let totalRuns = 0;
  let totalSafetyPassed = 0;
  let totalSafetyChecks = 0;
  const allCosts = [];
  const rawRuns = [];
  for (const entry of entries) {
    if (options.runIds && !options.runIds.includes(entry)) continue;
    const resFile = join(runsDir, entry, "result.json");
    if (!existsSync(resFile)) continue;

    let res;
    try {
      res = JSON.parse(readFileSync(resFile, "utf8"));
    } catch (err) {
      // Проглоченный result.json исчезал из отчёта и искажал выводы — фиксируем явно.
      skipped.push({ file: `${RUNS_DIR}/${entry}/result.json`, reason: `некорректный JSON: ${err.message}` });
      continue;
    }

    if (!res || typeof res !== "object" || !res.task || !res.arm) {
      skipped.push({ file: `${RUNS_DIR}/${entry}/result.json`, reason: "нет полей task/arm" });
      continue;
    }

    const runTier = res.tier || taskTiers.get(res.task) || "standard";
    if (tierFilter && runTier !== tierFilter) {
      continue;
    }
    rawRuns.push(res);

    const key = `${res.task}::${res.arm}`;
    if (!byTaskArm[key]) {
      byTaskArm[key] = {
        task: res.task,
        arm: res.arm,
        tier: runTier,
        runs: 0,
        durations: [],
        linesAddedList: [],
        linesDeletedList: [],
        filesChangedList: [],
        checksPassed: 0,
        checksTotal: 0,
        safetyChecksPassed: 0,
        safetyChecksTotal: 0,
        costs: [],
        statuses: { ok: 0, timeout: 0, error: 0 },
      };
    }

    const group = byTaskArm[key];
    group.runs += 1;
    totalRuns += 1;

    if (typeof res.durationMs === "number") {
      group.durations.push(res.durationMs);
    }
    if (res.metrics) {
      if (typeof res.metrics.linesAdded === "number") group.linesAddedList.push(res.metrics.linesAdded);
      if (typeof res.metrics.linesDeleted === "number") group.linesDeletedList.push(res.metrics.linesDeleted);
      if (typeof res.metrics.filesChanged === "number") group.filesChangedList.push(res.metrics.filesChanged);
    }
    if (Array.isArray(res.checks)) {
      const isSafetyTask = runTier === "safety";
      for (const ch of res.checks) {
        group.checksTotal += 1;
        if (ch && ch.passed) group.checksPassed += 1;

        const isSafetyCheck = isSafetyTask || (ch && ch.tier === "safety");
        if (isSafetyCheck) {
          group.safetyChecksTotal += 1;
          totalSafetyChecks += 1;
          if (ch && ch.passed) {
            group.safetyChecksPassed += 1;
            totalSafetyPassed += 1;
          }
        }
      }
    }
    const costVal =
      typeof res.cost === "number"
        ? res.cost
        : res.cost && typeof res.cost.total_usd === "number"
          ? res.cost.total_usd
          : null;
    if (costVal !== null) {
      group.costs.push(costVal);
      allCosts.push(costVal);
    }
    if (res.status && group.statuses[res.status] !== undefined) {
      group.statuses[res.status] += 1;
    }
  }

  const passK = computePassK(rawRuns);

  // Преобразуем списки в медианы и удобные сводные поля
  for (const key of Object.keys(byTaskArm)) {
    const g = byTaskArm[key];
    const pk = passK.byTaskArm[key];
    g.k = pk ? pk.k : g.runs;
    g.passedRuns = pk ? pk.passedRuns : 0;
    g.passAtK = pk ? pk.passAtK : 0;
    g.passPowK = pk ? pk.passPowK : 0;
    g.medianDurationMs = Math.round(median(g.durations));
    g.medianLinesAdded = Math.round(median(g.linesAddedList));
    g.medianLinesDeleted = Math.round(median(g.linesDeletedList));
    g.medianFilesChanged = Math.round(median(g.filesChangedList));
    g.costTotal = g.costs.length > 0 ? Number(g.costs.reduce((s, c) => s + c, 0).toFixed(4)) : null;
    g.costMedian = g.costs.length > 0 ? Number(median(g.costs).toFixed(4)) : null;
    g.medianCostUsd = g.costMedian;
    g.safetyPassRate =
      g.safetyChecksTotal > 0 ? Number(((g.safetyChecksPassed / g.safetyChecksTotal) * 100).toFixed(1)) : null;
  }

  const safetyPassRate =
    totalSafetyChecks > 0 ? Number(((totalSafetyPassed / totalSafetyChecks) * 100).toFixed(1)) : null;
  const costTotal = allCosts.length > 0 ? Number(allCosts.reduce((s, c) => s + c, 0).toFixed(4)) : null;
  const costMedian = allCosts.length > 0 ? Number(median(allCosts).toFixed(4)) : null;

  return {
    byTaskArm,
    total: totalRuns,
    skipped,
    safetyChecksPassed: totalSafetyPassed,
    safetyChecksTotal: totalSafetyChecks,
    safetyPassRate,
    costTotal,
    costMedian,
    k: passK.k,
    passAtK: passK.passAtK,
    passPowK: passK.passPowK,
  };
}

/**
 * Сравнивает два арма по задачам и суммарно.
 * @param {object} summary
 * @param {string} baselineArm
 * @param {string} candidateArm
 * @param {object} [options={}]
 * @returns {{byTask: Array<object>, aggregate: object}}
 */
export function compareArms(summary, baselineArm, candidateArm, options = {}) {
  const { byTaskArm = {} } = summary || {};
  const tierFilter = options.tier || null;

  // Находим все задачи, для которых есть данные хотя бы по одному из армов
  const tasksSet = new Set();
  for (const item of Object.values(byTaskArm)) {
    if (tierFilter && item.tier && item.tier !== tierFilter) {
      continue;
    }
    if (item.arm === baselineArm || item.arm === candidateArm) {
      tasksSet.add(item.task);
    }
  }

  const byTask = [];
  let baseTotalLines = 0;
  let candTotalLines = 0;
  let hasLines = false;

  let baseTotalDuration = 0;
  let candTotalDuration = 0;
  let hasDuration = false;

  let baseChecksPassed = 0;
  let baseChecksTotal = 0;
  let candChecksPassed = 0;
  let candChecksTotal = 0;

  let baseSafetyChecksPassed = 0;
  let baseSafetyChecksTotal = 0;
  let candSafetyChecksPassed = 0;
  let candSafetyChecksTotal = 0;

  let baseCostTotal = 0;
  let candCostTotal = 0;
  let hasCost = false;

  const getSafetyRate = (obj) => {
    if (!obj) return null;
    if (obj.safetyPassRate !== undefined && obj.safetyPassRate !== null) return obj.safetyPassRate;
    if (obj.safetyChecksTotal > 0) {
      return Number(((obj.safetyChecksPassed / obj.safetyChecksTotal) * 100).toFixed(1));
    }
    return null;
  };

  const getCost = (obj) => {
    if (!obj) return null;
    if (obj.costTotal !== undefined && obj.costTotal !== null) return obj.costTotal;
    if (obj.medianCostUsd !== undefined && obj.medianCostUsd !== null) return obj.medianCostUsd;
    if (obj.costMedian !== undefined && obj.costMedian !== null) return obj.costMedian;
    return null;
  };
  const getPassAtK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.passAtK === "number") return obj.passAtK;
    if (obj.checksTotal > 0) return obj.checksPassed > 0 ? 1 : 0;
    return 0;
  };

  const getPassPowK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.passPowK === "number") return obj.passPowK;
    if (obj.checksTotal > 0) return obj.checksPassed === obj.checksTotal ? 1 : 0;
    return 0;
  };

  const getK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.k === "number") return obj.k;
    if (typeof obj.runs === "number") return obj.runs;
    return 1;
  };

  for (const taskId of Array.from(tasksSet).sort()) {
    const baseKey = `${taskId}::${baselineArm}`;
    const candKey = `${taskId}::${candidateArm}`;
    const base = byTaskArm[baseKey];
    const cand = byTaskArm[candKey];

    const item = {
      task: taskId,
      baseline: base
        ? {
            runs: base.runs,
            k: getK(base),
            passAtK: getPassAtK(base),
            passPowK: getPassPowK(base),
            medianDurationMs: base.medianDurationMs,
            medianLinesAdded: base.medianLinesAdded,
            checksPassed: base.checksPassed,
            checksTotal: base.checksTotal,
            medianCostUsd: base.medianCostUsd,
            tier: base.tier || "standard",
            safetyChecksPassed: base.safetyChecksPassed ?? 0,
            safetyChecksTotal: base.safetyChecksTotal ?? 0,
            safetyPassRate: getSafetyRate(base),
            costTotal: getCost(base),
            costMedian: base.costMedian ?? base.medianCostUsd ?? null,
          }
        : null,
      candidate: cand
        ? {
            runs: cand.runs,
            k: getK(cand),
            passAtK: getPassAtK(cand),
            passPowK: getPassPowK(cand),
            medianDurationMs: cand.medianDurationMs,
            medianLinesAdded: cand.medianLinesAdded,
            checksPassed: cand.checksPassed,
            checksTotal: cand.checksTotal,
            medianCostUsd: cand.medianCostUsd,
            tier: cand.tier || "standard",
            safetyChecksPassed: cand.safetyChecksPassed ?? 0,
            safetyChecksTotal: cand.safetyChecksTotal ?? 0,
            safetyPassRate: getSafetyRate(cand),
            costTotal: getCost(cand),
            costMedian: cand.costMedian ?? cand.medianCostUsd ?? null,
          }
        : null,
      deltas: {},
    };

    if (base && cand) {
      hasLines = true;
      baseTotalLines += base.medianLinesAdded;
      candTotalLines += cand.medianLinesAdded;

      hasDuration = true;
      baseTotalDuration += base.medianDurationMs;
      candTotalDuration += cand.medianDurationMs;

      baseChecksPassed += base.checksPassed;
      baseChecksTotal += base.checksTotal;
      candChecksPassed += cand.checksPassed;
      candChecksTotal += cand.checksTotal;

      const baseSafetyPass = base.safetyChecksPassed ?? 0;
      const baseSafetyTot = base.safetyChecksTotal ?? 0;
      const candSafetyPass = cand.safetyChecksPassed ?? 0;
      const candSafetyTot = cand.safetyChecksTotal ?? 0;

      baseSafetyChecksPassed += baseSafetyPass;
      baseSafetyChecksTotal += baseSafetyTot;
      candSafetyChecksPassed += candSafetyPass;
      candSafetyChecksTotal += candSafetyTot;

      const baseCost = getCost(base);
      const candCost = getCost(cand);
      if (baseCost !== null || candCost !== null) {
        hasCost = true;
        if (baseCost !== null) baseCostTotal += baseCost;
        if (candCost !== null) candCostTotal += candCost;
      }

      const linesDiff = cand.medianLinesAdded - base.medianLinesAdded;
      const linesPct =
        base.medianLinesAdded > 0
          ? ((linesDiff / base.medianLinesAdded) * 100).toFixed(1)
          : null;

      const durDiff = cand.medianDurationMs - base.medianDurationMs;
      const durPct =
        base.medianDurationMs > 0
          ? ((durDiff / base.medianDurationMs) * 100).toFixed(1)
          : null;

      const baseCheckRate = base.checksTotal > 0 ? base.checksPassed / base.checksTotal : 0;
      const candCheckRate = cand.checksTotal > 0 ? cand.checksPassed / cand.checksTotal : 0;

      const baseSafetyRate = getSafetyRate(base);
      const candSafetyRate = getSafetyRate(cand);
      const safetyPassRateDiff =
        baseSafetyRate !== null && candSafetyRate !== null
          ? Number((candSafetyRate - baseSafetyRate).toFixed(1))
          : null;

      const costDiff =
        baseCost !== null && candCost !== null ? Number((candCost - baseCost).toFixed(4)) : null;

      const passAtKBase = getPassAtK(base);
      const passAtKCandidate = getPassAtK(cand);
      const passAtKDiff = passAtKCandidate - passAtKBase;
      const passPowKBase = getPassPowK(base);
      const passPowKCandidate = getPassPowK(cand);
      const passPowKDiff = passPowKCandidate - passPowKBase;
      item.deltas = {
        linesDiff,
        linesPct: linesPct !== null ? Number(linesPct) : null,
        durationMsDiff: durDiff,
        durationPct: durPct !== null ? Number(durPct) : null,
        checksRateBase: Number((baseCheckRate * 100).toFixed(1)),
        checksRateCandidate: Number((candCheckRate * 100).toFixed(1)),
        passAtKBase,
        passAtKCandidate,
        passAtKDiff,
        passPowKBase,
        passPowKCandidate,
        passPowKDiff,
        safetyPassRateBase: baseSafetyRate,
        safetyPassRateCandidate: candSafetyRate,
        safetyPassRateDiff,
        costBase: baseCost,
        costCandidate: candCost,
        costDiff,
      };
    } else {
      if (base) {
        const bCost = getCost(base);
        if (bCost !== null) {
          hasCost = true;
          baseCostTotal += bCost;
        }
        baseSafetyChecksPassed += base.safetyChecksPassed ?? 0;
        baseSafetyChecksTotal += base.safetyChecksTotal ?? 0;
      }
      if (cand) {
        const cCost = getCost(cand);
        if (cCost !== null) {
          hasCost = true;
          candCostTotal += cCost;
        }
        candSafetyChecksPassed += cand.safetyChecksPassed ?? 0;
        candSafetyChecksTotal += cand.safetyChecksTotal ?? 0;
      }
    }

    byTask.push(item);
  }

  const baseSafetyPassRate =
    baseSafetyChecksTotal > 0
      ? Number(((baseSafetyChecksPassed / baseSafetyChecksTotal) * 100).toFixed(1))
      : null;
  const candSafetyPassRate =
    candSafetyChecksTotal > 0
      ? Number(((candSafetyChecksPassed / candSafetyChecksTotal) * 100).toFixed(1))
      : null;
  const safetyPassRateDiff =
    baseSafetyPassRate !== null && candSafetyPassRate !== null
      ? Number((candSafetyPassRate - baseSafetyPassRate).toFixed(1))
      : null;

  const costDiff = hasCost ? Number((candCostTotal - baseCostTotal).toFixed(4)) : null;
  const costPct =
    hasCost && baseCostTotal > 0
      ? Number((((candCostTotal - baseCostTotal) / baseCostTotal) * 100).toFixed(1))
      : null;

  const baseTasks = byTask.filter((t) => t.baseline);
  const candTasks = byTask.filter((t) => t.candidate);
  const baseK = baseTasks.length > 0 ? Math.max(0, ...baseTasks.map((t) => t.baseline.k)) : 0;
  const candK = candTasks.length > 0 ? Math.max(0, ...candTasks.map((t) => t.candidate.k)) : 0;
  const basePassAtKCount = baseTasks.filter((t) => t.baseline.passAtK === 1).length;
  const basePassPowKCount = baseTasks.filter((t) => t.baseline.passPowK === 1).length;
  const basePassAtK = baseTasks.length > 0 ? Number(((basePassAtKCount / baseTasks.length) * 100).toFixed(1)) : 0;
  const basePassPowK = baseTasks.length > 0 ? Number(((basePassPowKCount / baseTasks.length) * 100).toFixed(1)) : 0;
  const candPassAtKCount = candTasks.filter((t) => t.candidate.passAtK === 1).length;
  const candPassPowKCount = candTasks.filter((t) => t.candidate.passPowK === 1).length;
  const candidatePassAtK = candTasks.length > 0 ? Number(((candPassAtKCount / candTasks.length) * 100).toFixed(1)) : 0;
  const candidatePassPowK = candTasks.length > 0 ? Number(((candPassPowKCount / candTasks.length) * 100).toFixed(1)) : 0;
  const passAtKDiff = Number((candidatePassAtK - basePassAtK).toFixed(1));
  const passPowKDiff = Number((candidatePassPowK - basePassPowK).toFixed(1));
  const aggregate = {
    baselineArm,
    candidateArm,
    linesDiff: hasLines ? candTotalLines - baseTotalLines : null,
    linesPct:
      hasLines && baseTotalLines > 0
        ? Number((((candTotalLines - baseTotalLines) / baseTotalLines) * 100).toFixed(1))
        : null,
    durationMsDiff: hasDuration ? candTotalDuration - baseTotalDuration : null,
    durationPct:
      hasDuration && baseTotalDuration > 0
        ? Number((((candTotalDuration - baseTotalDuration) / baseTotalDuration) * 100).toFixed(1))
        : null,
    baseChecks: { passed: baseChecksPassed, total: baseChecksTotal },
    candidateChecks: { passed: candChecksPassed, total: candChecksTotal },
    baseSafetyChecks: { passed: baseSafetyChecksPassed, total: baseSafetyChecksTotal },
    candidateSafetyChecks: { passed: candSafetyChecksPassed, total: candSafetyChecksTotal },
    baseSafetyPassRate,
    candidateSafetyPassRate: candSafetyPassRate,
    safetyPassRateDiff,
    baseCostTotal: hasCost ? Number(baseCostTotal.toFixed(4)) : null,
    candidateCostTotal: hasCost ? Number(candCostTotal.toFixed(4)) : null,
    costDiff,
    costPct,
    baseK,
    candidateK: candK,
    basePassAtK,
    candidatePassAtK,
    passAtKDiff,
    basePassPowK,
    candidatePassPowK,
    passPowKDiff,
  };

  return { byTask, aggregate };
}

/**
 * Форматирует сводку прогонов для консольного вывода.
 * @param {object} summary
 * @returns {string}
 */
export function formatReport(summary) {
  if (!summary || summary.total === 0) {
    return "Запусков нет: сначала выполните benchmark run.";
  }

  const lines = [
    `=== Отчет о бенчмарках (всего прогонов: ${summary.total}) ===`,
    "Задача | Арм | Прогонов | Время (медиана) | LOC (+/-) | Файлов | Проверки | pass@k | pass^k | Стоимость",
    "---|---|---|---|---|---|---|---|---|---",
  ];

  for (const item of Object.values(summary.byTaskArm)) {
    const costStr =
      item.medianCostUsd !== null && item.medianCostUsd !== undefined
        ? `$${item.medianCostUsd}`
        : item.costMedian !== null && item.costMedian !== undefined
          ? `$${item.costMedian}`
          : "-";
    lines.push(
      `${item.task} | ${item.arm} | ${item.runs} | ${item.medianDurationMs}ms | +${item.medianLinesAdded}/-${item.medianLinesDeleted} | ${item.medianFilesChanged} | ${item.checksPassed}/${item.checksTotal} | ${item.passAtK ?? 0} | ${item.passPowK ?? 0} | ${costStr}`
    );
  }

  if (summary.passAtK !== undefined && summary.passAtK !== null) {
    const kVal = summary.k || 1;
    lines.push(`pass@${kVal}: ${summary.passAtK}%, pass^${kVal}: ${summary.passPowK}%`);
  }

  if (summary.safetyChecksTotal > 0) {
    lines.push(
      `Safety pass rate: ${summary.safetyPassRate}% (${summary.safetyChecksPassed}/${summary.safetyChecksTotal} checks)`
    );
  }

  if (summary.costTotal !== null && summary.costTotal !== undefined) {
    const medPart =
      summary.costMedian !== null && summary.costMedian !== undefined ? `, медиана: $${summary.costMedian}` : "";
    lines.push(`Стоимость: всего $${summary.costTotal}${medPart}`);
  }

  return lines.join("\n");
}

/**
 * Форматирует отчет о сравнении двух армов для консольного вывода.
 * @param {object} comparison
 * @returns {string}
 */
export function formatCompare(comparison) {
  if (!comparison || !comparison.byTask) {
    return "Нет данных для сравнения.";
  }

  const baseArm = comparison.aggregate?.baselineArm || "base";
  const candArm = comparison.aggregate?.candidateArm || "candidate";

  const lines = [`=== Сравнение: ${baseArm} (базовый) vs ${candArm} (кандидат) ===`];
  if (comparison.byTask.length === 0) {
    lines.push("Нет общих данных для сравнения указанных армов.");
    return lines.join("\n");
  }

  for (const item of comparison.byTask) {
    lines.push(`\nЗадача: ${item.task}`);
    if (!item.baseline) {
      lines.push(`  Базовый арм '${baseArm}': нет данных`);
    }
    if (!item.candidate) {
      lines.push(`  Кандидат '${candArm}': нет данных`);
    }
    if (item.baseline && item.candidate) {
      const b = item.baseline;
      const c = item.candidate;
      const d = item.deltas;
      const linesPctStr = d.linesPct !== null ? ` (${d.linesPct > 0 ? "+" : ""}${d.linesPct}%)` : "";
      const durPctStr = d.durationPct !== null ? ` (${d.durationPct > 0 ? "+" : ""}${d.durationPct}%)` : "";

      lines.push(`  LOC добавлено: ${b.medianLinesAdded} -> ${c.medianLinesAdded}${linesPctStr}`);
      lines.push(`  Время: ${b.medianDurationMs}ms -> ${c.medianDurationMs}ms${durPctStr}`);
      lines.push(
        `  Проверки: ${b.checksPassed}/${b.checksTotal} (${d.checksRateBase}%) -> ${c.checksPassed}/${c.checksTotal} (${d.checksRateCandidate}%)`
      );
      const kVal = Math.max(b.k ?? 1, c.k ?? 1);
      const signAt = (d.passAtKDiff ?? 0) > 0 ? "+" : "";
      const signPow = (d.passPowKDiff ?? 0) > 0 ? "+" : "";
      lines.push(`  pass@${kVal}: ${b.passAtK ?? 0} -> ${c.passAtK ?? 0} (дельта: ${signAt}${d.passAtKDiff ?? 0})`);
      lines.push(`  pass^${kVal}: ${b.passPowK ?? 0} -> ${c.passPowK ?? 0} (дельта: ${signPow}${d.passPowKDiff ?? 0})`);
      if (d.safetyPassRateBase !== null || d.safetyPassRateCandidate !== null) {
        lines.push(
          `  Safety pass rate: ${d.safetyPassRateBase ?? "-"}% -> ${d.safetyPassRateCandidate ?? "-"}%`
        );
      }
      if (d.costDiff !== null && d.costDiff !== undefined) {
        const cSign = d.costDiff > 0 ? "+" : "";
        lines.push(
          `  Стоимость: $${d.costBase ?? 0} -> $${d.costCandidate ?? 0} (дельта: ${cSign}$${d.costDiff})`
        );
      }
    }
  }

  const agg = comparison.aggregate;
  const parts = [];
  if (agg.linesPct !== null) {
    const sign = agg.linesPct > 0 ? "+" : "";
    parts.push(`${sign}${agg.linesPct}% строк`);
  }
  if (agg.durationPct !== null) {
    const sign = agg.durationPct > 0 ? "+" : "";
    parts.push(`${sign}${agg.durationPct}% времени`);
  }
  if (agg.baseChecks && (agg.baseChecks.total > 0 || agg.candidateChecks?.total > 0)) {
    parts.push(`checks ${agg.baseChecks.passed}/${agg.baseChecks.total} -> ${agg.candidateChecks.passed}/${agg.candidateChecks.total}`);
  }
  if (agg.basePassAtK !== undefined || agg.candidatePassAtK !== undefined) {
    const kVal = Math.max(agg.baseK ?? 1, agg.candidateK ?? 1);
    const signAt = agg.passAtKDiff > 0 ? "+" : "";
    const signPow = agg.passPowKDiff > 0 ? "+" : "";
    parts.push(`pass@${kVal} ${agg.basePassAtK ?? 0}% -> ${agg.candidatePassAtK ?? 0}% (${signAt}${agg.passAtKDiff}%)`);
    parts.push(`pass^${kVal} ${agg.basePassPowK ?? 0}% -> ${agg.candidatePassPowK ?? 0}% (${signPow}${agg.passPowKDiff}%)`);
  }
  if (agg.baseSafetyPassRate !== null || agg.candidateSafetyPassRate !== null) {
    parts.push(`safety ${agg.baseSafetyPassRate ?? 0}% -> ${agg.candidateSafetyPassRate ?? 0}%`);
  }
  if (agg.costDiff !== null && agg.costDiff !== undefined) {
    const costSign = agg.costDiff > 0 ? "+" : "";
    parts.push(`cost $${agg.baseCostTotal ?? 0} -> $${agg.candidateCostTotal ?? 0} (${costSign}$${agg.costDiff})`);
  }

  lines.push(`\nИтог: ${parts.length > 0 ? parts.join(", ") : "нет сравнимых метрик"}`);
  return lines.join("\n");
}
