#!/usr/bin/env node
/**
 * tools/bench-smoke.mjs — smoke-прогоны и валидация задач (выделено из benchmark.mjs 1:1).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { TASKS_FILE, TASK_TIERS, computePassK } from "./benchmark.mjs";

export function validateTasks(rootOrData = ".") {
  const errors = [];
  let data = rootOrData;
  if (typeof rootOrData === "string") {
    const abs = resolve(rootOrData);
    const filePath = abs.endsWith(".json") && existsSync(abs) ? abs : join(abs, TASKS_FILE);
    if (!existsSync(filePath)) return { valid: false, count: 0, errors: [`Файл не найден: ${filePath}`] };
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      return { valid: false, count: 0, errors: [`Некорректный JSON в ${filePath}: ${err.message}`] };
    }
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.tasks) || data.tasks.length === 0) {
    return { valid: false, count: 0, errors: ["Поле 'tasks' должно быть непустым массивом."] };
  }
  const seenIds = new Set();
  data.tasks.forEach((t, idx) => {
    const label = t && typeof t.id === "string" && t.id.trim() ? `'${t.id}'` : `#${idx}`;
    if (!t || typeof t !== "object") {
      errors.push(`Задача ${label}: ожидается объект.`);
      return;
    }
    if (typeof t.id !== "string" || !t.id.trim()) errors.push(`Задача ${label}: поле 'id' должно быть непустой строкой.`);
    else if (seenIds.has(t.id)) errors.push(`Задача ${label}: дублирующийся id '${t.id}'.`);
    else seenIds.add(t.id);
    if (typeof t.tier !== "string" || !TASK_TIERS.includes(t.tier)) {
      errors.push(`Задача ${label}: 'tier' должен быть одним из [${TASK_TIERS.join(", ")}] (получено: ${JSON.stringify(t.tier)}).`);
    }
    if (typeof t.prompt !== "string" || !t.prompt.trim()) errors.push(`Задача ${label}: 'prompt' должен быть непустой строкой.`);
    if (!Array.isArray(t.checks) || t.checks.length === 0 || !t.checks.every((c) => typeof c === "string" && c.trim().length > 0)) {
      errors.push(`Задача ${label}: 'checks' должен быть непустым массивом непустых строк.`);
    }
    const timeout = t.timeoutSec ?? t.timeout;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      errors.push(`Задача ${label}: 'timeoutSec' должен быть целым числом > 0 (получено: ${JSON.stringify(timeout)}).`);
    }
  });
  return { valid: errors.length === 0, count: data.tasks.length, errors };
}

function loadSmokeRuns(dirPath) {
  const absDir = resolve(dirPath);
  if (!existsSync(absDir)) {
    const err = new Error(`Директория smoke не найдена: ${absDir}`);
    err.exitCode = 2;
    throw err;
  }
  const runs = [];
  const readJsonFile = (p) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      const err = new Error(`Некорректный JSON в ${p}: ${e.message}`);
      err.exitCode = 2;
      throw err;
    }
    let list = [];
    if (Array.isArray(parsed)) list = parsed;
    else if (Array.isArray(parsed?.runs)) list = parsed.runs;
    else if (parsed?.task) list = [parsed];
    for (const item of list) if (item && typeof item === "object") runs.push(item);
  };
  if (statSync(absDir).isFile()) {
    readJsonFile(absDir);
    return runs;
  }
  const rootResult = join(absDir, "result.json");
  if (existsSync(rootResult) && statSync(rootResult).isFile()) readJsonFile(rootResult);
  for (const entry of readdirSync(absDir).sort()) {
    if (entry === "result.json") continue;
    const full = join(absDir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const subRes = join(full, "result.json");
      if (existsSync(subRes) && statSync(subRes).isFile()) readJsonFile(subRes);
    } else if (entry.endsWith(".json")) {
      readJsonFile(full);
    }
  }
  return runs;
}

export function runSmoke({ baseline, candidate, tasks = null, root = "." } = {}) {
  const resolveSide = (side) => {
    if (Array.isArray(side)) return side;
    if (!side || typeof side !== "string") {
      const err = new Error("Необходимо указать пути --baseline и --candidate");
      err.exitCode = 2;
      throw err;
    }
    let p = side;
    if (!isAbsolute(side)) p = existsSync(resolve(root, side)) ? resolve(root, side) : resolve(side);
    return loadSmokeRuns(p);
  };
  const baseStats = computePassK(resolveSide(baseline).filter((r) => r && r.task).map((r) => ({ ...r, arm: "baseline" })));
  const candStats = computePassK(resolveSide(candidate).filter((r) => r && r.task).map((r) => ({ ...r, arm: "candidate" })));
  let filterList = null;
  if (Array.isArray(tasks)) filterList = tasks.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof tasks === "string" && tasks.trim()) filterList = tasks.split(",").map((t) => t.trim()).filter(Boolean);
  const filterSet = filterList && filterList.length > 0 ? new Set(filterList) : null;
  const allTasks = new Set([...Object.keys(baseStats.byTask), ...Object.keys(candStats.byTask), ...(filterSet || [])]);
  const red = [];
  const green = [];
  const skipped = [];
  const byTask = [];
  for (const taskId of Array.from(allTasks).sort()) {
    if (filterSet && !filterSet.has(taskId)) continue;
    const b = baseStats.byTask[taskId]?.baseline;
    const c = candStats.byTask[taskId]?.candidate;
    if (!b || !c || b.k === 0 || c.k === 0) {
      let reason = "missing in candidate";
      if (!b && !c) reason = "missing in both";
      else if (!b) reason = "missing in baseline";
      const item = {
        task: taskId, status: "skipped", red: false, skipped: true, reason,
        baseline: b ? `${b.passedRuns}/${b.k}` : null, candidate: c ? `${c.passedRuns}/${c.k}` : null,
      };
      skipped.push(item);
      byTask.push(item);
      continue;
    }
    const isRed = b.passPowK === 1 && c.passAtK === 0;
    const item = {
      task: taskId, status: isRed ? "red" : "green", red: isRed, skipped: false,
      baseline: `${b.passedRuns}/${b.k}`, candidate: `${c.passedRuns}/${c.k}`,
      baselinePassed: b.passedRuns, baselineK: b.k, candidatePassed: c.passedRuns, candidateK: c.k,
    };
    if (isRed) red.push(item);
    else green.push(item);
    byTask.push(item);
  }
  return {
    passed: red.length === 0, status: red.length === 0 ? "green" : "red", exitCode: red.length === 0 ? 0 : 1,
    red, redTasks: red.map((r) => r.task), green, skipped, skippedTasks: skipped.map((s) => s.task), byTask,
  };
}
