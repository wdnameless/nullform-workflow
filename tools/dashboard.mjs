#!/usr/bin/env node
/**
 * tools/dashboard.mjs — Nullform Workflow: интерактивный дашборд полной наблюдаемости.
 *
 * Единая «стеклянная кабина» (glass cockpit) в стиле Autopilot/SwarmForge:
 *   1. Прогресс проекта, покрытие брифа (R##), этапы 4-Wave SDD с таймингами.
 *   2. Метрики: время, оценка остатка, таски/артефакты, техдолг, тесты, требования.
 *   3. Волны сборки: артефакты по волнам и роли субагентов (fleet).
 *   4. Архитектура: модули репозитория с файлами и строками.
 *   5. Диффы: изменения git (staged/unstaged) с построчным диффом по клику.
 *   6. Критика и ревью: вердикты оракула, замечания, автопроверки.
 *   7. Технический долг: маркеры defer: и их триггеры.
 *   8. Как это работает: ярусы T0-T3, законы, коридор гейтов.
 *
 * CLI опции:
 *   --root <dir>      Корень проекта (по умолчанию: .)
 *   --output <path>   Куда записать dashboard.html (по умолчанию: .workflow/dashboard.html)
 *   --open            Открыть дашборд в браузере
 *   --serve           Локальный сервер с авто-обновлением и API (/api/state, /api/diff)
 *   --port <n>        Порт сервера (по умолчанию: 4200)
 *   --checks          Прогнать быстрые гейты (debt-ledger, auto-review, prompt-lint) и закэшировать
 *   --json            Вывести агрегированные метрики в JSON
 *   --help, -h        Справка
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHECKS_CACHE = ".workflow/dashboard-checks.json";
const MAX_DIFF_LINES = 500;

/**
 * Обязательные артефакты по ярусам (совпадает с гейтом tools/workflow.mjs).
 * Всё, что не требуется ярусом, дашборд показывает как «не требуется», а не «не начато».
 */
export const REQUIRED_ARTIFACTS_BY_TIER = {
  T0: ["lane"],
  T1: ["lane", "recon"],
  T2: ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"],
  T3: ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"],
};

/** Все стадии 4-Wave SDD с привязкой к волне и артефакту. */
const STAGE_DEFS = [
  { id: "lane", name: "Ярус и постановка", wave: 0 },
  { id: "recon", name: "Разведка и контекст", wave: 1 },
  { id: "manifest", name: "Манифест требований (R##)", wave: 2 },
  { id: "openspec", name: "Спецификация OpenSpec", wave: 2 },
  { id: "interfaces", name: "Интерфейсы и владельцы", wave: 3 },
  { id: "oracle", name: "Слепая приёмка Оракула", wave: 4 },
  { id: "closed", name: "Закрытие и архив", wave: 4 },
];

/* ------------------------------------------------------------------ */
/*  Data collection                                                    */
/* ------------------------------------------------------------------ */

/** Рекурсивный сбор файлов модуля (без node_modules/.git). */
function walkFiles(dir, out = [], limit = 400) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) return out;
    if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, out, limit);
    } else if (st.isFile()) {
      let lines = 0;
      try {
        if (st.size < 400000) lines = readFileSync(full, "utf8").split("\n").length;
      } catch {}
      out.push({ name: e, path: full, size: st.size, lines });
    }
  }
  return out;
}

/** Модули репозитория: файлы, строки, крупнейшие файлы. */
export function scanModules(absRoot) {
  const known = ["agent", "core", "tools", "rules", "skills", "templates", "tests", "bench", "openspec", "docs", "src", "lib"];
  const modules = [];

  for (const name of known) {
    const dirPath = join(absRoot, name);
    if (!existsSync(dirPath)) continue;

    const files = walkFiles(dirPath);
    const totalLines = files.reduce((s, f) => s + f.lines, 0);
    const top = [...files].sort((a, b) => b.lines - a.lines).slice(0, 12).map((f) => ({
      name: relative(absRoot, f.path).replace(/\\/g, "/"),
      lines: f.lines,
    }));

    modules.push({
      name,
      path: name,
      fileCount: files.length,
      totalLines,
      files: top,
    });
  }

  return modules;
}

/** Git-состояние: ветка, последний коммит, изменения (staged/unstaged) построчно. */
export function collectGitStats(absRoot) {
  const git = (args) =>
    spawnSync("git", args, { cwd: absRoot, encoding: "utf8", timeout: 15000, shell: false });

  const branchRes = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const isRepo = branchRes.status === 0;
  if (!isRepo) {
    return { isRepo: false, branch: null, commit: null, files: [], added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0 };
  }

  const branch = (branchRes.stdout || "").trim();
  const commitRes = git(["log", "-1", "--pretty=%h|%s|%ar"]);
  const commitRaw = (commitRes.stdout || "").trim();
  const [commitHash = "", commitMsg = "", commitWhen = ""] = commitRaw.split("|");

  // Изменённые файлы: numstat по HEAD (включая staged и unstaged) + untracked
  const numstatRaw = git(["diff", "HEAD", "--numstat"]).stdout || "";
  const files = [];
  let added = 0;
  let deleted = 0;

  for (const line of numstatRaw.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const add = a === "-" ? 0 : Number(a) || 0;
    const del = d === "-" ? 0 : Number(d) || 0;
    added += add;
    deleted += del;
    files.push({ path: path.replace(/\\/g, "/"), added: add, deleted: del, status: "modified" });
  }

  // ВАЖНО: не trim()-ить весь вывод — ведущий пробел первой строки porcelain
  // и есть признак «изменение не в индексе» (` M`), trim сдвинул бы коды.
  const porcelainRaw = git(["status", "--porcelain"]).stdout || "";
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelainRaw.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    if (code === "??") {
      untracked++;
      const p = line.slice(3).trim();
      files.push({ path: p.replace(/\\/g, "/"), added: 0, deleted: 0, status: "untracked" });
    } else {
      if (code[0] !== " " && code[0] !== "?") staged++;
      if (code[1] !== " " && code[1] !== "?") unstaged++;
    }
  }

  return {
    isRepo: true,
    branch,
    commit: { hash: commitHash, message: commitMsg, when: commitWhen },
    files: files.slice(0, 60),
    added,
    deleted,
    staged,
    unstaged,
    untracked,
  };
}

/** Технический долг: запуск debt-ledger (быстро) или чтение кэша. */
export function collectDebt(absRoot) {
  const script = join(absRoot, "tools", "debt-ledger.mjs");
  if (!existsSync(script)) return { total: 0, noTrigger: 0, items: [], note: "debt-ledger.mjs не найден" };

  const res = spawnSync(process.execPath, [script, "--json", "--root", absRoot], {
    cwd: absRoot,
    encoding: "utf8",
    timeout: 20000,
    shell: false,
  });

  if (res.status !== 0) {
    return { total: 0, noTrigger: 0, items: [], note: "debt-ledger завершился с ошибкой" };
  }

  try {
    const parsed = JSON.parse(res.stdout);
    const items = [];
    for (const [file, markers] of Object.entries(parsed.byFile || {})) {
      for (const m of Array.isArray(markers) ? markers : []) {
        items.push({
          file: file.replace(/\\/g, "/"),
          line: m.line || null,
          what: m.what || "",
          ceiling: m.ceiling || "",
          upgrade: m.upgrade || "",
          noTrigger: Boolean(m.noTrigger),
        });
      }
    }
    return { total: parsed.total || 0, noTrigger: parsed.noTrigger || 0, items: items.slice(0, 40) };
  } catch {
    return { total: 0, noTrigger: 0, items: [], note: "debt-ledger JSON не разобран" };
  }
}

/** Требования R## из последнего манифеста openspec/changes/*\/manifest.md. */
export function collectRequirements(absRoot) {
  const changesDir = join(absRoot, "openspec", "changes");
  if (!existsSync(changesDir)) return { total: 0, byStatus: {}, items: [], change: null };

  let entries = [];
  try {
    entries = readdirSync(changesDir).filter((e) => {
      if (e === "archive") return false;
      try {
        return statSync(join(changesDir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {}

  // Самый свежий change по mtime манифеста
  let best = null;
  for (const e of entries) {
    const mf = join(changesDir, e, "manifest.md");
    if (!existsSync(mf)) continue;
    const st = statSync(mf);
    if (!best || st.mtimeMs > best.mtimeMs) best = { change: e, path: mf, mtimeMs: st.mtimeMs };
  }
  if (!best) return { total: 0, byStatus: {}, items: [], change: null };

  let text = "";
  try {
    text = readFileSync(best.path, "utf8");
  } catch {
    return { total: 0, byStatus: {}, items: [], change: best.change };
  }

  const items = [];
  const byStatus = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*(R\d+[a-z]?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/i);
    if (!m) continue;
    const id = m[1];
    const requirement = m[2].replace(/^«|»$/g, "");
    const acceptance = m[3];
    const status = m[4].trim();
    byStatus[status] = (byStatus[status] || 0) + 1;
    items.push({ id, requirement, acceptance, status });
  }

  return { total: items.length, byStatus, items: items.slice(0, 40), change: best.change };
}

/** Критика: вердикты оракула из openspec/changes/*\/oracle*.md + кэш автопроверок. */
export function collectCritique(absRoot) {
  const changesDir = join(absRoot, "openspec", "changes");
  const verdicts = [];

  if (existsSync(changesDir)) {
    let entries = [];
    try {
      entries = readdirSync(changesDir);
    } catch {}
    for (const e of entries) {
      const dir = join(changesDir, e);
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => /^oracle.*\.md$/i.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        let text = "";
        try {
          text = readFileSync(join(dir, f), "utf8");
        } catch {
          continue;
        }
        const upper = text.toUpperCase();
        let verdict = "unknown";
        if (/\bREJECT/.test(upper) && !/\bACCEPT\b/.test(upper)) verdict = "reject";
        else if (/\bACCEPT\b/.test(upper) || /\bAPPROV/.test(upper)) verdict = "accept";
        else if (/\bREJECT/.test(upper)) verdict = "mixed";

        const concerns = (text.match(/CONCERN|ЗАМЕЧАНИ|ПРОБЛЕМ/gi) || []).length;
        const blockers = (text.match(/BLOCKER|БЛОКЕР|FAIL/gi) || []).length;

        verdicts.push({
          change: e,
          file: f,
          verdict,
          concerns,
          blockers,
          size: text.length,
        });
      }
    }
  }

  // Автопроверки из кэша (--checks)
  const cachePath = join(absRoot, CHECKS_CACHE);
  let checks = null;
  if (existsSync(cachePath)) {
    try {
      checks = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {}
  }

  return { verdicts: verdicts.slice(0, 20), checks };
}

/** История: metrics.jsonl — сколько работаем, медианы, последние задачи. */
export function collectHistory(absRoot) {
  const metricsPath = join(absRoot, ".workflow", "metrics.jsonl");
  if (!existsSync(metricsPath)) {
    return { total: 0, medianMs: 0, byTier: {}, recent: [] };
  }

  const records = [];
  try {
    for (const line of readFileSync(metricsPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {}
    }
  } catch {}

  const durations = records.map((r) => Number(r.durationMs) || 0).filter((d) => d > 0);
  const sorted = [...durations].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const byTier = {};
  for (const r of records) {
    const tier = r.tier || "?";
    byTier[tier] = (byTier[tier] || 0) + 1;
  }

  const tail = records.slice(Math.max(0, records.length - 6));
  const recent = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i];
    recent.push({
      task: String(r.task || "").slice(0, 120),
      tier: r.tier || "?",
      durationMs: Number(r.durationMs) || 0,
      forced: Boolean(r.forced),
    });
  }

  return {
    total: records.length,
    medianMs,
    byTier,
    recent,
  };
}

/** Быстрые гейты (opt-in через --checks): debt-ledger уже собран, здесь auto-review и prompt-lint. */
export function runChecks(absRoot) {
  const out = { generatedAt: new Date().toISOString(), autoReview: null, promptBudget: null };

  const autoReview = join(absRoot, "tools", "auto-review.mjs");
  if (existsSync(autoReview)) {
    const res = spawnSync(process.execPath, [autoReview, "--json"], {
      cwd: absRoot,
      encoding: "utf8",
      timeout: 45000,
      shell: false,
    });
    try {
      out.autoReview = JSON.parse(res.stdout);
    } catch {
      out.autoReview = { error: `exit ${res.status}`, stderr: (res.stderr || "").slice(0, 400) };
    }
  }

  const promptLint = join(absRoot, "tools", "prompt-lint.mjs");
  if (existsSync(promptLint)) {
    const res = spawnSync(process.execPath, [promptLint, "sizes", "--json", "--root", absRoot], {
      cwd: absRoot,
      encoding: "utf8",
      timeout: 30000,
      shell: false,
    });
    try {
      out.promptBudget = JSON.parse(res.stdout);
    } catch {
      out.promptBudget = { error: `exit ${res.status}` };
    }
  }

  const cachePath = join(absRoot, CHECKS_CACHE);
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(out, null, 2), "utf8");

  return out;
}

/** Тайминги этапов из меток артефактов. */
function stageTimings(state) {
  const marks = [];
  const a = state?.artifacts || {};
  const order = ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"];
  for (const k of order) {
    if (a[k]?.at) marks.push({ kind: k, at: new Date(a[k].at).getTime() });
  }
  if (state?.closedAt) marks.push({ kind: "closed", at: new Date(state.closedAt).getTime() });

  const durations = {};
  for (let i = 1; i < marks.length; i++) {
    durations[marks[i].kind] = Math.max(0, marks[i].at - marks[i - 1].at);
  }
  return durations;
}

/** Полный агрегат данных дашборда. */
export function collectDashboardData(root = ".") {
  const absRoot = resolve(root);
  const wfDir = join(absRoot, ".workflow");
  const statePath = join(wfDir, "state.json");

  let state = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {}
  }

  let budgets = { T0: 10, T1: 25, T2: 45, T3: 45 };
  const budgetsPath = join(wfDir, "budgets.json");
  if (existsSync(budgetsPath)) {
    try {
      budgets = { ...budgets, ...JSON.parse(readFileSync(budgetsPath, "utf8")) };
    } catch {}
  }

  // Каденция памяти
  let memory = { status: "unknown", daysSince: null };
  const cadencePath = join(wfDir, "memory-cadence.json");
  if (existsSync(cadencePath)) {
    try {
      const cad = JSON.parse(readFileSync(cadencePath, "utf8"));
      if (cad.lastReview?.date) {
        const days = (Date.now() - new Date(cad.lastReview.date).getTime()) / 86400000;
        memory = { status: days > 7 ? "overdue" : "fresh", daysSince: Number(days.toFixed(1)) };
      }
    } catch {}
  }

  const now = Date.now();
  const startedAt = state?.startedAt ? new Date(state.startedAt).getTime() : now;
  const closedAt = state?.closedAt ? new Date(state.closedAt).getTime() : null;
  const elapsedMs = Math.max(0, (closedAt || now) - startedAt);

  const artifacts = state?.artifacts || {};
  const stageMs = stageTimings(state);
  const tier = state?.tier || "T1";
  const status = state?.status || "idle";
  const closed = status === "closed";

  // Обязательные артефакты яруса: остальные стадии — «не требуется», а не «не начато».
  const required = REQUIRED_ARTIFACTS_BY_TIER[tier] || REQUIRED_ARTIFACTS_BY_TIER.T1;
  const nextRequired = required.find((k) => !artifacts[k]);

  const stages = STAGE_DEFS.map((def) => {
    const stage = { ...def, detail: "", status: "pending" };
    if (def.id === "lane") stage.detail = state?.tier || "";

    if (artifacts[def.id]) {
      stage.status = "done";
    } else if (def.id === "closed") {
      stage.status = closed ? "done" : "pending";
    } else if (!required.includes(def.id)) {
      stage.status = "skipped";
      stage.detail = `ярус ${tier} — не требуется`;
    } else if (closed) {
      stage.status = "missed";
      stage.detail = "закрыто без артефакта";
    } else if (def.id === nextRequired) {
      stage.status = "in_progress";
    }

    if (stageMs[def.id] !== undefined) stage.durationMs = stageMs[def.id];
    return stage;
  });

  const stagesDone = stages.filter((s) => s.status === "done" && s.id !== "closed").length;
  const stagesSkipped = stages.filter((s) => s.status === "skipped").length;
  const artifactsDone = required.filter((k) => artifacts[k]).length;

  const progressPercent = state
    ? closed
      ? 100
      : Math.min(99, Math.round(((stagesDone / Math.max(1, required.length)) * 0.7 + (artifactsDone / Math.max(1, required.length)) * 0.3) * 100))
    : 0;

  const current = closed
    ? { name: "Задача закрыта", wave: 4, detail: "" }
    : stages.find((s) => s.status === "in_progress") ||
      stages.find((s) => s.status === "pending" && required.includes(s.id)) ||
      stages[stages.length - 1];

  // Оценка остатка: по медиане истории и числу незакрытых обязательных артефактов
  const history = collectHistory(absRoot);
  const remainingCount = closed ? 0 : required.filter((k) => !artifacts[k]).length;
  const perStage = history.medianMs > 0 ? history.medianMs / Math.max(1, required.length) : 3 * 60000;
  const remainingMin = closed ? null : Math.max(0, Math.round((remainingCount * perStage) / 60000));
  const remainingMax = closed ? null : Math.max(remainingMin ?? 0, Math.round((remainingCount * perStage * 2.2) / 60000));

  const git = collectGitStats(absRoot);
  const modules = scanModules(absRoot);
  const requirements = collectRequirements(absRoot);
  const debt = collectDebt(absRoot);
  const critique = collectCritique(absRoot);

  const reqDone = (requirements.byStatus["done"] || 0) + (requirements.byStatus["in-spec"] || 0) + (requirements.byStatus["implemented"] || 0);
  const briefCoverage = requirements.total > 0 ? Math.round((reqDone / requirements.total) * 100) : artifacts.oracle ? 100 : 0;

  const fleet = [
    { role: "@orchestrator", name: "Оркестратор", wave: 0, status: closed ? "idle" : "active" },
    { role: "@explorer", name: "Разведчик AST", wave: 1, status: artifacts.recon ? "done" : "ready" },
    { role: "@librarian", name: "Библиотекарь", wave: 1, status: "ready" },
    { role: "@designer", name: "Дизайнер UI/UX", wave: 3, status: "ready" },
    { role: "@fixer", name: "Fixer (TDD)", wave: 3, status: artifacts.interfaces ? "done" : "ready" },
    { role: "@oracle", name: "Оракул (приёмка)", wave: 4, status: artifacts.oracle ? "done" : "ready" },
  ];

  return {
    timestamp: new Date().toISOString(),
    root: absRoot,
    project: {
      name: absRoot.split(/[\\/]/).pop() || "project",
      branch: git.branch,
      commit: git.commit,
    },
    task: {
      title: state?.task || "Задача не открыта — воркфлоу в режиме ожидания",
      tier,
      status,
      startedAt: state?.startedAt || null,
      elapsedMs,
      budget: budgets[tier] || 25,
    },
    progress: {
      percent: progressPercent,
      stagesDone,
      stagesRequired: required.length,
      stagesSkipped,
      artifactsDone,
      artifactsTotal: required.length,
    },
    stages,
    currentStage: { name: current?.name || "—", wave: current?.wave ?? 0, detail: current?.detail || "" },
    timing: {
      elapsedMs,
      remainingMin,
      remainingMax,
      medianTaskMs: history.medianMs,
    },
    metrics: {
      briefCoverage,
      requirements,
      debt,
      memory,
      checks: critique.checks,
    },
    waves: [0, 1, 2, 3, 4].map((w) => ({
      wave: w,
      title: `ВОЛНА ${w}`,
      stages: stages.filter((s) => s.wave === w),
      agents: fleet.filter((f) => f.wave === w),
    })),
    git,
    modules,
    critique: critique.verdicts,
    history,
    fleet,
  };
}

/* ------------------------------------------------------------------ */
/*  HTML                                                               */
/* ------------------------------------------------------------------ */

/**
 * Автономная страница: серверный каркас + клиентский рендер.
 *
 * Все динамические секции рисуются в браузере из JSON (`DATA` при первом
 * рендере, `/api/state` при опросе) — поэтому страница обновляется на месте,
 * без перезагрузки и без потери места на странице, как дашборд Autopilot.
 * В статичном режиме (file://) опрос молча отключается, и страница остаётся
 * рабочим снимком состояния.
 */
export function generateDashboardHtml(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nullform Workflow · ${data.project.name}</title>
<style>
  :root {
    --bg: #ffffff; --page: #fbfbfc; --card: #ffffff; --border: #e6e8eb; --border-soft: #eef0f2;
    --text: #101418; --muted: #6b7280; --muted-2: #9aa1a9;
    --green: #16a34a; --green-soft: #eaf7ef; --amber: #d97706; --amber-soft: #fdf3e3;
    --red: #dc2626; --red-soft: #fdecec; --blue: #2563eb; --blue-soft: #eaf0fe;
    --purple: #7c3aed; --purple-soft: #f2ecfe;
    --radius: 14px; --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  }
  body.dark {
    --bg: #0d1117; --page: #0d1117; --card: #161b22; --border: #262c36; --border-soft: #21262d;
    --text: #e6edf3; --muted: #8b949e; --muted-2: #6e7681;
    --green-soft: #0f2a1a; --amber-soft: #2b1f07; --red-soft: #2d1214; --blue-soft: #101f3d; --purple-soft: #1d1633;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--page); color: var(--text); padding: 28px 20px 60px; line-height: 1.45; }
  .wrap { max-width: 1240px; margin: 0 auto; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted { color: var(--muted); }

  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 26px; }
  .logo { display: flex; align-items: baseline; gap: 8px; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
  .logo .glyph { display: inline-block; transform: translateY(1px); font-weight: 900; }
  .logo .sub { font-size: 15px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .controls { display: flex; align-items: center; gap: 8px; }
  .icon-btn { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 14px; display: grid; place-items: center; }
  .icon-btn:hover { border-color: var(--muted-2); }
  .lang { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .lang button { border: 0; background: var(--card); color: var(--muted); padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .lang button.active { background: var(--text); color: var(--card); }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .live.on { color: var(--green); border-color: var(--green); }
  .live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
  .live.on .dot { background: var(--green); animation: pulse 1.8s infinite; }
  @keyframes pulse { 0% { opacity: 1 } 50% { opacity: .25 } 100% { opacity: 1 } }

  .title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
  .title-row h1 { font-size: 19px; font-weight: 700; letter-spacing: -0.2px; }
  .badges { display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; padding: 5px 12px; border-radius: 999px; }
  .badge-status { background: var(--blue-soft); color: var(--blue); }
  .badge-sdd { background: var(--purple-soft); color: var(--purple); }
  .badge-tier { background: var(--amber-soft); color: var(--amber); }

  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .label { font-size: 11px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }

  .progress-card { margin-bottom: 16px; }
  .progress-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .progress-pct { font-size: 34px; font-weight: 800; letter-spacing: -1px; }
  .bar { height: 10px; background: var(--border-soft); border-radius: 999px; overflow: hidden; margin: 14px 0 8px; }
  .bar > i { display: block; height: 100%; background: var(--text); border-radius: 999px; transition: width .6s ease; }
  .bar.mini { height: 6px; margin: 8px 0 6px; }
  .bar.mini > i { background: var(--green); }
  .sub { font-size: 12.5px; color: var(--muted); }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 16px; }
  @media (max-width: 1000px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  .metric .value { font-size: 26px; font-weight: 800; letter-spacing: -0.6px; }
  .metric .value.small { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; }
  .metric .note { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .donut { display: block; margin: 2px 0 8px; }

  .section { margin-bottom: 16px; }
  .timeline { list-style: none; }
  .stage { display: flex; align-items: center; gap: 12px; padding: 11px 2px; border-bottom: 1px solid var(--border-soft); }
  .stage:last-child { border-bottom: 0; }
  .stage-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border); flex: 0 0 auto; }
  .stage.done .stage-dot { background: var(--green); }
  .stage.active .stage-dot { background: var(--amber); box-shadow: 0 0 0 4px var(--amber-soft); }
  .stage.skipped .stage-dot { background: transparent; border: 1px dashed var(--border); width: 9px; height: 9px; }
  .stage.missed .stage-dot { background: var(--red); }
  .stage.skipped .stage-name { color: var(--muted-2); }
  .stage.missed .stage-name { color: var(--red); }
  .stage-name { flex: 1; font-size: 14px; }
  .stage.active .stage-name { font-weight: 700; }
  .stage.pending .stage-name { color: var(--muted); }
  .stage-note { font-size: 12px; color: var(--muted); font-weight: 400; }
  .stage-time { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .wave { margin-bottom: 14px; }
  .wave-title { font-size: 11px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; color: var(--muted); margin: 12px 0 8px; }
  .task-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .task-idx { font-family: var(--mono); font-size: 11px; color: var(--muted-2); width: 20px; }
  .task-bar { flex: 1; border-radius: 6px; padding: 7px 12px; font-size: 12.5px; font-weight: 600; }
  .task-bar.done { background: var(--green); color: #fff; }
  .task-bar.active { background: var(--amber); color: #fff; }
  .task-bar.pending { background: var(--border-soft); color: var(--muted); }
  .task-bar.skipped { background: transparent; border: 1px dashed var(--border); color: var(--muted-2); font-weight: 500; }
  .task-time { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; width: 62px; text-align: right; }
  .wave-agents { margin: 4px 0 0 30px; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--border-soft); color: var(--muted); font-family: var(--mono); }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 980px) { .two-col { grid-template-columns: 1fr; } }

  details.module { border-bottom: 1px solid var(--border-soft); }
  details.module:last-child { border-bottom: 0; }
  details.module > summary { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; cursor: pointer; list-style: none; }
  details.module > summary::-webkit-details-marker { display: none; }
  .module-meta { font-size: 12px; color: var(--muted); }
  .module-files { padding: 4px 0 10px 12px; }
  .module-file { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }

  .diff-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border-soft); cursor: pointer; }
  .diff-row:hover { background: var(--border-soft); }
  .diff-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-stat { font-variant-numeric: tabular-nums; font-size: 12px; }
  .add { color: var(--green); } .del { color: var(--red); }
  .diff-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
  .diff-badge.untracked { color: var(--amber); }

  .critique-row, .debt-row, .hist-row { padding: 10px 0; border-bottom: 1px solid var(--border-soft); font-size: 13px; }
  .critique-row:last-child, .debt-row:last-child, .hist-row:last-child { border-bottom: 0; }
  .critique-meta { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
  .verdict { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px; letter-spacing: .4px; }
  .verdict.ok { background: var(--green-soft); color: var(--green); }
  .verdict.bad { background: var(--red-soft); color: var(--red); }
  .verdict.warn { background: var(--amber-soft); color: var(--amber); }
  .hist-row { display: flex; gap: 10px; align-items: baseline; }
  .hist-task { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .checks-line { font-size: 12px; color: var(--muted); margin-top: 10px; }

  .empty { color: var(--muted); font-size: 13px; padding: 10px 0; }
  .principles { font-size: 13px; }
  .principles table { width: 100%; border-collapse: collapse; }
  .principles td { padding: 7px 0; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
  .principles td:first-child { width: 130px; font-weight: 700; }

  footer { margin-top: 22px; display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }

  .flash { animation: flash 1.1s ease; }
  @keyframes flash { 0% { background: var(--amber-soft); } 100% { background: transparent; } }

  #diff-modal { position: fixed; inset: 0; background: rgba(10,12,16,.55); display: none; align-items: center; justify-content: center; padding: 30px; z-index: 50; }
  #diff-modal.open { display: flex; }
  #diff-box { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); max-width: 1000px; width: 100%; max-height: 82vh; overflow: auto; padding: 18px 20px; }
  #diff-box h3 { font-size: 14px; margin-bottom: 10px; font-family: var(--mono); }
  #diff-box pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .d-add { color: var(--green); } .d-del { color: var(--red); } .d-hunk { color: var(--blue); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo"><span>null</span><span class="glyph">✕</span><span>form</span><span class="sub">workflow</span></div>
    <div class="controls">
      <span class="live" id="live-badge"><span class="dot"></span><span id="live-text">снимок</span></span>
      <button class="icon-btn" onclick="refreshNow()" title="Обновить">⟳</button>
      <button class="icon-btn" onclick="setTheme('light')" title="Светлая">☀</button>
      <button class="icon-btn" onclick="setTheme('dark')" title="Тёмная">☾</button>
      <div class="lang">
        <button id="lang-ru" class="active" onclick="setLang('ru')">RU</button>
        <button id="lang-en" onclick="setLang('en')">EN</button>
      </div>
    </div>
  </header>

  <div class="title-row">
    <h1 id="task-title">…</h1>
    <div class="badges" id="task-badges"></div>
  </div>

  <section class="card progress-card" id="sec-progress"></section>
  <div class="grid" id="sec-metrics"></div>
  <section class="card section"><div class="label" id="lbl-stages"></div><ul class="timeline" id="sec-stages"></ul></section>
  <section class="card section"><div class="label" id="lbl-waves"></div><div id="sec-waves"></div></section>

  <div class="two-col">
    <section class="card section"><div class="label" id="lbl-modules"></div><div id="sec-modules"></div></section>
    <section class="card section"><div class="label" id="lbl-diffs"></div><div id="sec-diffs"></div></section>
  </div>

  <div class="two-col">
    <section class="card section"><div class="label" id="lbl-critique"></div><div id="sec-critique"></div></section>
    <section class="card section"><div class="label" id="lbl-debt"></div><div id="sec-debt"></div></section>
  </div>

  <section class="card section"><div class="label" id="lbl-history"></div><div id="sec-history"></div></section>

  <section class="card section principles">
    <div class="label" id="lbl-how"></div>
    <table>
      <tr><td>Ярусы</td><td><strong>T0</strong> — 1–2 файла, без церемоний · <strong>T1</strong> — 3+ файла, рекогносцировка и 1–2 специалиста · <strong>T2</strong> — архитектура, полный 4-Wave SDD с брифингом и слепой приёмкой · <strong>T3</strong> — программа из нескольких T2-срезов</td></tr>
      <tr><td>Законы</td><td>Честность (ничего не «готово» без выполненной проверки) · Анализ до правок · Минимализм · Один владелец на файл</td></tr>
      <tr><td>Коридор</td><td>Гейт артефактов → TDD-тесты → <span class="mono">test-lens</span> → мутационное тестирование → BDD Gherkin → слепая приёмка Оракула</td></tr>
      <tr><td>Память</td><td>Hindsight (банк <span class="mono">main</span>) + недельная каденция ревизии через <span class="mono">memory-cadence.mjs</span></td></tr>
      <tr><td>Дашборд</td><td>Открывается сам при <span class="mono">workflow.mjs start</span>; страница обновляется каждые 3 с через <span class="mono">/api/state</span>; клик по файлу в диффах открывает построчный diff</td></tr>
    </table>
  </section>

  <footer id="sec-footer"></footer>
</div>

<div id="diff-modal" onclick="if(event.target===this)closeDiff()">
  <div id="diff-box">
    <h3 id="diff-title">diff</h3>
    <pre id="diff-body">Загрузка…</pre>
  </div>
</div>

<script>
  var DATA = ${payload};
  var POLL_MS = 3000;
  var lastFingerprint = null;

  var I18N = {
    ru: { stages: "Этапы", waves: "Ход сборки — волны SDD", modules: "Архитектура и модули", diffs: "Диффы (git)", critique: "Критика и ревью", debt: "Технический долг", history: "История работы", how: "Как это работает", live: "LIVE", snapshot: "снимок", progress: "Прогресс проекта", coverage: "Покрытие брифа", currentStage: "Этап сейчас", elapsed: "Прошло времени", remaining: "Осталось (оценка)", artifacts: "Артефакты", debtShort: "Долг", diffsShort: "Диффы", memory: "Память" },
    en: { stages: "Stages", waves: "Build progress — SDD waves", modules: "Architecture & modules", diffs: "Diffs (git)", critique: "Critique & review", debt: "Technical debt", history: "Work history", how: "How it works", live: "LIVE", snapshot: "snapshot", progress: "Project progress", coverage: "Brief coverage", currentStage: "Current stage", elapsed: "Elapsed", remaining: "Remaining (est.)", artifacts: "Artifacts", debtShort: "Debt", diffsShort: "Diffs", memory: "Memory" }
  };
  var lang = localStorage.getItem("nf-lang") || "ru";
  function t(key) { return (I18N[lang] && I18N[lang][key]) || (I18N.ru[key] || key); }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
  }
  var STATUS_CLASS = { done: "done", in_progress: "active", missed: "missed", skipped: "skipped", pending: "pending" };
  function statusClass(s) { return STATUS_CLASS[s] || "pending"; }
  var STAGE_TIME = { done: "—", skipped: "не требуется", missed: "пропущено", in_progress: "идёт" };
  function stageTime(st) { return st.durationMs ? fmtDur(st.durationMs) : (STAGE_TIME[st.status] || "не начат"); }
  var WAVE_TIME = { done: "готово", skipped: "не требуется" };
  function waveTime(st) { return st.durationMs ? fmtDur(st.durationMs) : (WAVE_TIME[st.status] || "ждёт"); }
  function statusBadge(s) { return { closed: "ЗАКРЫТА", open: "В РАБОТЕ" }[s] || "ОЖИДАНИЕ"; }
  function memoryLabel(s) { return { fresh: "В НОРМЕ", overdue: "ПРОСРОЧЕНА" }[s] || "НЕТ ДАННЫХ"; }

  function renderTitle(d) {
    document.getElementById("task-title").textContent = d.task.title;
    document.getElementById("task-badges").innerHTML =
      '<span class="badge badge-status">' + statusBadge(d.task.status) + "</span>" +
      '<span class="badge badge-sdd">4-WAVE SDD</span>' +
      '<span class="badge badge-tier">ЯРУС ' + esc(d.task.tier) + "</span>";
  }

  function renderProgress(d) {
    var p = d.progress;
    var skipped = p.stagesSkipped ? " · " + p.stagesSkipped + " не требуется для яруса " + esc(d.task.tier) : "";
    document.getElementById("sec-progress").innerHTML =
      '<div class="progress-top"><div class="label">' + t("progress") + '</div>' +
      '<div class="progress-pct" id="pct">' + p.percent + "%</div></div>" +
      '<div class="bar"><i id="pbar" style="width:' + p.percent + '%"></i></div>' +
      '<div class="sub">' + p.stagesDone + " из " + p.stagesRequired + " обязательных этапов · " +
      p.artifactsDone + " из " + p.artifactsTotal + " артефактов" + skipped + "</div>";
  }

  function renderMetrics(d) {
    var m = d.metrics, g = d.git, closed = d.task.status === "closed";
    var dash = (m.briefCoverage / 100 * 188.5).toFixed(1);
    var cards = [];

    cards.push('<div class="card metric"><div class="label">' + t("coverage") + "</div>" +
      '<svg class="donut" width="72" height="72" viewBox="0 0 72 72">' +
      '<circle cx="36" cy="36" r="30" fill="none" stroke="var(--border-soft)" stroke-width="9"></circle>' +
      '<circle cx="36" cy="36" r="30" fill="none" stroke="var(--green)" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash + ' 188.5" transform="rotate(-90 36 36)"></circle></svg>' +
      '<div class="value">' + m.briefCoverage + "%</div>" +
      '<div class="note">' + m.requirements.items.length + " требований" + (m.requirements.change ? " · " + esc(m.requirements.change) : "") + "</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("currentStage") + "</div>" +
      '<div class="value small">' + esc(d.currentStage.name) + "</div>" +
      '<div class="note">' + (closed ? "задача завершена" : "Волна " + d.currentStage.wave + " · " + d.progress.stagesDone + " из " + d.progress.stagesRequired + " этапов") + "</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("elapsed") + "</div>" +
      '<div class="value" id="elapsed">' + fmtDur(d.timing.elapsedMs) + "</div>" +
      '<div class="note">медиана задачи — ' + (d.timing.medianTaskMs ? fmtDur(d.timing.medianTaskMs) : "нет данных") + "</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("remaining") + "</div>" +
      '<div class="value small">' + (d.timing.remainingMin === null ? "—" : d.timing.remainingMin + " мин … " + d.timing.remainingMax + " мин") + "</div>" +
      '<div class="note">' + (d.timing.remainingMin === null ? "задача закрыта" : "по медиане " + d.history.total + " закрытых задач") + "</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("artifacts") + "</div>" +
      '<div class="value">' + d.progress.artifactsDone + " / " + d.progress.artifactsTotal + "</div>" +
      '<div class="bar mini"><i style="width:' + Math.round(d.progress.artifactsDone / Math.max(1, d.progress.artifactsTotal) * 100) + '%"></i></div>' +
      '<div class="note">бюджет яруса: ' + d.task.budget + " вызовов</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("debtShort") + "</div>" +
      '<div class="value">' + m.debt.total + "</div>" +
      '<div class="note">маркеров defer:' + (m.debt.noTrigger ? " · без триггера " + m.debt.noTrigger : "") + "</div></div>");

    var diffNote = g.isRepo
      ? '<span class="add">+' + g.added + '</span> <span class="del">−' + g.deleted + "</span> · staged " + g.staged + " · untracked " + g.untracked
      : "не git-репозиторий";
    cards.push('<div class="card metric"><div class="label">' + t("diffsShort") + "</div>" +
      '<div class="value">' + (g.isRepo ? g.files.length : "—") + "</div>" +
      '<div class="note">' + diffNote + "</div></div>");

    cards.push('<div class="card metric"><div class="label">' + t("memory") + "</div>" +
      '<div class="value small">' + memoryLabel(m.memory.status) + "</div>" +
      '<div class="note">' + (m.memory.daysSince !== null ? "дней с ревизии: " + m.memory.daysSince : "ревизия не проводилась") + "</div></div>");

    document.getElementById("sec-metrics").innerHTML = cards.join("");
  }

  function renderStages(d) {
    document.getElementById("sec-stages").innerHTML = d.stages.map(function (s) {
      return '<li class="stage ' + statusClass(s.status) + '">' +
        '<span class="stage-dot"></span>' +
        '<span class="stage-name">' + esc(s.name) + (s.detail ? ' <span class="stage-note">' + esc(s.detail) + "</span>" : "") + "</span>" +
        '<span class="stage-time">' + stageTime(s) + "</span></li>";
    }).join("");
  }

  function renderWaves(d) {
    var blocks = d.waves.filter(function (w) { return w.stages.length > 0; }).map(function (w) {
      var rows = w.stages.map(function (s) {
        var idx = String(d.stages.indexOf(s) + 1).padStart(2, "0");
        var cls = statusClass(s.status);
        return '<div class="task-row ' + cls + '">' +
          '<span class="task-idx">' + idx + "</span>" +
          '<span class="task-bar ' + cls + '">' + esc(s.name) + "</span>" +
          '<span class="task-time">' + waveTime(s) + "</span></div>";
      }).join("");
      var agents = w.agents.length
        ? '<div class="wave-agents">' + w.agents.map(function (a) { return '<span class="chip">' + esc(a.role) + "</span>"; }).join("") + "</div>"
        : "";
      var parallel = w.stages.filter(function (s) { return s.status !== "skipped"; }).length;
      return '<div class="wave"><div class="wave-title">' + esc(w.title) + (parallel > 1 ? " — " + parallel + " параллельно" : "") + "</div>" + rows + agents + "</div>";
    }).join("");
    document.getElementById("sec-waves").innerHTML = blocks;
  }

  function renderModules(d) {
    var open = {};
    document.querySelectorAll("details.module[open]").forEach(function (el) { open[el.getAttribute("data-module")] = true; });

    if (!d.modules.length) {
      document.getElementById("sec-modules").innerHTML = '<div class="empty">Модули не найдены</div>';
      return;
    }
    document.getElementById("sec-modules").innerHTML = d.modules.map(function (m) {
      var files = m.files.map(function (f) {
        return '<div class="module-file"><span class="mono">' + esc(f.name) + '</span><span class="muted">' + f.lines + " строк</span></div>";
      }).join("");
      return '<details class="module" data-module="' + esc(m.path) + '"' + (open[m.path] ? " open" : "") + ">" +
        '<summary><span class="mono">' + esc(m.path) + '/</span><span class="module-meta">' + m.fileCount + " файлов · " + m.totalLines.toLocaleString("ru-RU") + " строк</span></summary>" +
        '<div class="module-files">' + files + "</div></details>";
    }).join("");
  }

  function renderDiffs(d) {
    var g = d.git;
    var body;
    if (!g.isRepo) body = '<div class="empty">Не git-репозиторий</div>';
    else if (!g.files.length) body = '<div class="empty">Рабочее дерево чистое — изменений нет</div>';
    else body = g.files.map(function (f) {
      return '<div class="diff-row" data-file="' + esc(f.path) + '">' +
        '<span class="mono diff-path">' + esc(f.path) + "</span>" +
        '<span class="diff-stat"><span class="add">+' + f.added + '</span> <span class="del">−' + f.deleted + "</span></span>" +
        '<span class="diff-badge ' + esc(f.status) + '">' + esc(f.status) + "</span></div>";
    }).join("");

    var footer = g.isRepo
      ? '<div class="checks-line">Ветка <span class="mono">' + esc(g.branch) + '</span> · последний коммит <span class="mono">' + esc(g.commit && g.commit.hash) + "</span> " + esc(g.commit && g.commit.when) + "</div>"
      : "";
    document.getElementById("sec-diffs").innerHTML = body + footer;

    document.querySelectorAll(".diff-row").forEach(function (row) {
      row.addEventListener("click", function () { openDiff(row.getAttribute("data-file")); });
    });
  }

  function renderCritique(d) {
    var rows;
    if (!d.critique.length) {
      rows = '<div class="empty">Вердиктов оракула пока нет — приёмка не проводилась</div>';
    } else {
      rows = d.critique.map(function (c) {
        var cls = c.verdict === "accept" ? "ok" : c.verdict === "reject" ? "bad" : "warn";
        var label = c.verdict === "accept" ? "ПРИНЯТО" : c.verdict === "reject" ? "ОТКЛОНЕНО" : c.verdict === "mixed" ? "С ЗАМЕЧАНИЯМИ" : "НЕТ ВЕРДИКТА";
        return '<div class="critique-row ' + cls + '"><div><strong>' + esc(c.change) + '</strong> <span class="muted mono">' + esc(c.file) + "</span></div>" +
          '<div class="critique-meta"><span class="verdict ' + cls + '">' + label + '</span><span class="muted">замечаний: ' + c.concerns + "</span></div></div>";
      }).join("");
    }
    var checks = d.metrics.checks && d.metrics.checks.autoReview;
    var line = checks
      ? '<div class="checks-line">auto-review: ' + (checks.error ? "ошибка (" + esc(checks.error) + ")" : "проблем — " + (checks.total !== undefined ? checks.total : (checks.problems ? checks.problems.length : 0))) + " · сгенерировано " + esc(new Date(d.metrics.checks.generatedAt).toLocaleString("ru-RU")) + "</div>"
      : '<div class="checks-line muted">Автопроверки не запускались — добавьте <span class="mono">--checks</span></div>';
    document.getElementById("sec-critique").innerHTML = rows + line;
  }

  function renderDebt(d) {
    var debt = d.metrics.debt;
    if (!debt.items.length) {
      document.getElementById("sec-debt").innerHTML = '<div class="empty">Осознанного техдолга нет — реестр чист' + (debt.note ? " (" + esc(debt.note) + ")" : "") + "</div>";
      return;
    }
    document.getElementById("sec-debt").innerHTML = debt.items.map(function (x) {
      return '<div class="debt-row"><div class="mono">' + esc(x.file) + (x.line ? ":" + x.line : "") + "</div>" +
        "<div>" + esc(x.what) + "</div>" +
        '<div class="muted">Потолок: ' + esc(x.ceiling || "—") + (x.upgrade ? " · Апгрейд: " + esc(x.upgrade) : "") + "</div></div>";
    }).join("");
  }

  function renderHistory(d) {
    var head = '<div class="sub" style="margin-bottom:8px">Всего закрыто задач: <strong>' + d.history.total + "</strong> · медиана: <strong>" +
      (d.history.medianTaskMs ? fmtDur(d.history.medianTaskMs) : "—") + "</strong> · по ярусам: " +
      (Object.keys(d.history.byTier).map(function (k) { return '<span class="chip">' + esc(k) + ": " + d.history.byTier[k] + "</span>"; }).join(" ") || "—") + "</div>";
    var rows = d.history.recent.length
      ? d.history.recent.map(function (h) {
          return '<div class="hist-row"><span class="mono">' + esc(h.tier) + '</span><span class="hist-task">' + esc(h.task) + "</span>" +
            '<span class="muted">' + fmtDur(h.durationMs) + (h.forced ? " · force" : "") + "</span></div>";
        }).join("")
      : '<div class="empty">История пуста</div>';
    document.getElementById("sec-history").innerHTML = head + rows;
  }

  function renderFooter(d) {
    document.getElementById("sec-footer").innerHTML =
      '<span>Проект: <span class="mono">' + esc(d.project.name) + "</span></span>" +
      '<span>Корень: <span class="mono">' + esc(d.root) + "</span></span>" +
      '<span>Обновлено: <span class="mono">' + esc(new Date(d.timestamp).toLocaleString("ru-RU")) + "</span></span>" +
      (d.metrics.requirements.change ? '<span>Change: <span class="mono">' + esc(d.metrics.requirements.change) + "</span></span>" : "");
  }

  function applyLabels() {
    document.getElementById("lbl-stages").textContent = t("stages");
    document.getElementById("lbl-waves").textContent = t("waves");
    document.getElementById("lbl-modules").textContent = t("modules");
    document.getElementById("lbl-diffs").textContent = t("diffs");
    document.getElementById("lbl-critique").textContent = t("critique");
    document.getElementById("lbl-debt").textContent = t("debt");
    document.getElementById("lbl-history").textContent = t("history");
    document.getElementById("lbl-how").textContent = t("how");
    var lt = document.getElementById("live-text");
    if (lt && lt.getAttribute("data-state") !== "live") lt.textContent = t("snapshot");
  }

  function render(d) {
    renderTitle(d);
    renderProgress(d);
    renderMetrics(d);
    renderStages(d);
    renderWaves(d);
    renderModules(d);
    renderDiffs(d);
    renderCritique(d);
    renderDebt(d);
    renderHistory(d);
    renderFooter(d);
    applyLabels();
    DATA = d;
  }

  function setLang(next) {
    lang = next;
    localStorage.setItem("nf-lang", next);
    document.getElementById("lang-ru").classList.toggle("active", next === "ru");
    document.getElementById("lang-en").classList.toggle("active", next === "en");
    applyLabels();
  }
  function setTheme(mode) {
    localStorage.setItem("nf-theme", mode);
    document.body.classList.toggle("dark", mode === "dark");
  }

  var savedTheme = localStorage.getItem("nf-theme");
  if (savedTheme === "dark") document.body.classList.add("dark");
  setLang(lang);

  // Живые часы: тикают, пока задача открыта.
  var startMs = DATA.task.startedAt ? new Date(DATA.task.startedAt).getTime() : Date.now();
  setInterval(function () {
    if (DATA.task.status === "closed") return;
    var el = document.getElementById("elapsed");
    if (el) el.textContent = fmtDur(Math.max(0, Date.now() - startMs));
  }, 1000);

  function setLive(on) {
    var badge = document.getElementById("live-badge");
    var text = document.getElementById("live-text");
    badge.classList.toggle("on", on);
    text.setAttribute("data-state", on ? "live" : "snapshot");
    text.textContent = on ? t("live") : t("snapshot");
  }

  function fingerprint(d) {
    return JSON.stringify({
      p: d.progress,
      s: d.stages.map(function (x) { return x.id + x.status; }),
      g: d.git.files.length + ":" + d.git.added + ":" + d.git.deleted + ":" + d.git.untracked,
      c: d.critique.length,
      d: d.metrics.debt.total,
      h: d.history.total,
    });
  }

  function flashChanged(d) {
    var fp = fingerprint(d);
    if (lastFingerprint !== null && fp !== lastFingerprint) {
      ["sec-progress", "sec-stages", "sec-waves", "sec-diffs", "sec-metrics"].forEach(function (id) {
        var el = document.getElementById(id);
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      });
    }
    lastFingerprint = fp;
  }

  function refreshNow() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (fresh) { render(fresh); flashChanged(fresh); setLive(true); })
      .catch(function () { setLive(false); });
  }

  function openDiff(file) {
    var modal = document.getElementById("diff-modal");
    var body = document.getElementById("diff-body");
    document.getElementById("diff-title").textContent = file;
    modal.classList.add("open");
    body.textContent = "Загрузка…";
    fetch("/api/diff?file=" + encodeURIComponent(file))
      .then(function (r) { return r.text(); })
      .then(function (text) {
        body.innerHTML = text.split("\\n").map(function (l) {
          var cls = l.startsWith("+") && !l.startsWith("+++") ? "d-add" : l.startsWith("-") && !l.startsWith("---") ? "d-del" : l.startsWith("@@") ? "d-hunk" : "";
          var e = esc(l);
          return cls ? '<span class="' + cls + '">' + e + "</span>" : e;
        }).join("\\n");
      })
      .catch(function () { body.textContent = "Дифф доступен только в живом режиме (--serve)"; });
  }
  function closeDiff() { document.getElementById("diff-modal").classList.remove("open"); }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDiff(); });

  render(DATA);
  lastFingerprint = fingerprint(DATA);
  refreshNow();
  setInterval(refreshNow, POLL_MS);
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Server, runtime file, auto-launch                                  */
/* ------------------------------------------------------------------ */

/** Файл рантайма: порт и pid живого сервера дашборда. */
export const RUNTIME_FILE = ".workflow/dashboard.json";

export function runtimePath(root) {
  return join(resolve(root), RUNTIME_FILE);
}

/** Прочитать рантайм-файл дашборда (или null). */
export function readRuntime(root) {
  const p = runtimePath(root);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data.port === "number" ? data : null;
  } catch {
    return null;
  }
}

/** Записать рантайм-файл (порт/pid/url/время старта). */
export function writeRuntime(root, info) {
  const p = runtimePath(root);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2), "utf8");
  return p;
}

/** Живой ли дашборд на порту (быстрый health-пинг). */
export async function isServerAlive(port, timeoutMs = 900) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Открыть URL в браузере по умолчанию. */
export function openInBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Попытка занять порт; null — порт занят. */
function tryListen(port, absRoot) {
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => handleRequest(req, res, absRoot));
    server.once("error", () => resolvePort(null));
    server.once("listening", () => resolvePort({ server, port }));
    server.listen(port, "127.0.0.1");
  });
}

/** HTTP-обработчик: страница, /api/state, /api/diff, /api/health. */
function handleRequest(req, res, absRoot) {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, root: absRoot }));
    return;
  }

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(collectDashboardData(absRoot)));
    return;
  }

  if (url.pathname === "/api/diff") {
    const file = url.searchParams.get("file") || "";
    const safe = file.replace(/\.\./g, "");
    const diff = spawnSync("git", ["diff", "HEAD", "--", safe], {
      cwd: absRoot,
      encoding: "utf8",
      timeout: 15000,
      shell: false,
    });
    const text = (diff.stdout || diff.stderr || "Нет изменений").split("\n").slice(0, MAX_DIFF_LINES).join("\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(generateDashboardHtml(collectDashboardData(absRoot)));
}

/** Запустить сервер дашборда на первом свободном порту. */
export async function startLiveServer(root, port = 4200, { maxAttempts = 12 } = {}) {
  const absRoot = resolve(root);
  for (let p = port; p < port + maxAttempts; p++) {
    const bound = await tryListen(p, absRoot);
    if (bound) return bound;
  }
  throw new Error(`нет свободного порта в диапазоне ${port}..${port + maxAttempts - 1}`);
}

/**
 * Автозапуск дашборда: если живой сервер уже есть — используем его,
 * иначе поднимаем фоновый процесс и (опционально) открываем браузер.
 * Никогда не бросает: дашборд — наблюдаемость, а не условие работы.
 */
export async function ensureDashboard(root, { open = true, port = 4200 } = {}) {
  const absRoot = resolve(root);

  const existing = readRuntime(absRoot);
  if (existing && (await isServerAlive(existing.port))) {
    const url = `http://localhost:${existing.port}`;
    if (open) openInBrowser(url);
    return { url, port: existing.port, started: false };
  }

  const selfPath = fileURLToPath(import.meta.url);
  // cwd НЕ ставим в корень проекта: на Windows это блокирует удаление каталога,
  // пока жив демон. Абсолютный --root делает cwd ненужным.
  const child = spawn(process.execPath, [selfPath, "--serve", "--no-open", "--root", absRoot, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readRuntime(absRoot);
    if (info && (await isServerAlive(info.port))) {
      const url = `http://localhost:${info.port}`;
      if (open) openInBrowser(url);
      return { url, port: info.port, started: true };
    }
  }

  return { url: null, port: null, started: false, error: "сервер не поднялся за 5 с" };
}

/** Обновить статичный HTML-файл (режим без сервера). */
export function refreshDashboardFile(root) {
  const absRoot = resolve(root);
  const outPath = join(absRoot, ".workflow", "dashboard.html");
  try {
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, generateDashboardHtml(collectDashboardData(absRoot)), "utf8");
    return outPath;
  } catch {
    return null;
  }
}

export function parseArgs(argv = []) {
  const options = {
    root: ".",
    output: null,
    open: false,
    serve: false,
    ensure: false,
    noOpen: false,
    checks: false,
    port: 4200,
    json: false,
    help: false,
    errors: [],
  };
  const KNOWN = new Set(["root", "output", "open", "serve", "ensure", "no-open", "checks", "port", "json", "help"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--ensure") options.ensure = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--checks") options.checks = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--root" || arg.startsWith("--root="))
      options.root = arg.startsWith("--root=") ? arg.slice("--root=".length) : argv[++i];
    else if (arg === "--output" || arg.startsWith("--output="))
      options.output = arg.startsWith("--output=") ? arg.slice("--output=".length) : argv[++i];
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg.startsWith("--port=") ? arg.slice("--port=".length) : argv[++i];
      const p = Number.parseInt(raw, 10);
      if (!Number.isFinite(p) || p < 1 || p > 65535) {
        options.errors.push(`--port требует валидный номер порта (получено: ${JSON.stringify(raw)})`);
      } else {
        options.port = p;
      }
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (!KNOWN.has(name)) options.errors.push(`неизвестный параметр: ${arg}`);
    }
  }

  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(`dashboard.mjs — Nullform Workflow: дашборд полной наблюдаемости

Использование:
  node tools/dashboard.mjs [параметры]

Параметры:
  --root <dir>      Корень проекта (по умолчанию: .)
  --output <path>   Куда записать dashboard.html (по умолчанию: .workflow/dashboard.html)
  --open            Открыть дашборд в браузере
  --serve           Локальный сервер (авто-обновление, /api/state, /api/diff)
  --ensure          Поднять фоновый сервер, если его нет, и открыть дашборд (автозапуск)
  --no-open         Не открывать браузер (для фонового демона)
  --checks          Прогнать быстрые гейты (auto-review, prompt-lint) и закэшировать
  --port <n>        Порт сервера (по умолчанию: 4200)
  --json            Вывести агрегированные метрики в JSON
  -h, --help        Показать эту справку
`);
    return 0;
  }

  if (opts.errors.length > 0) {
    for (const e of opts.errors) process.stderr.write(`Ошибка: ${e}\n`);
    return 2;
  }

  const absRoot = resolve(opts.root);

  if (opts.checks) {
    const checks = runChecks(absRoot);
    process.stdout.write(`Проверки выполнены и закэшированы: ${join(absRoot, CHECKS_CACHE)}\n`);
    if (checks.autoReview?.error) process.stdout.write(`  auto-review: ${checks.autoReview.error}\n`);
  }

  // --ensure: автозапуск (идемпотентно) — поднять фоновый сервер и открыть страницу.
  if (opts.ensure) {
    const info = await ensureDashboard(absRoot, { open: !opts.noOpen, port: opts.port });
    if (info.url) {
      process.stdout.write(`Дашборд: ${info.url}${info.started ? " (запущен)" : " (уже работал)"}\n`);
      return 0;
    }
    process.stderr.write(`dashboard: ${info.error || "не удалось запустить"}\n`);
    return 1;
  }

  const data = collectDashboardData(absRoot);

  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  const outPath = opts.output ? resolve(opts.output) : join(absRoot, ".workflow", "dashboard.html");
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(outPath, generateDashboardHtml(data), "utf8");
  process.stdout.write(`Дашборд сгенерирован: ${outPath}\n`);

  if (opts.serve) {
    const bound = await startLiveServer(absRoot, opts.port);
    const url = `http://localhost:${bound.port}`;
    writeRuntime(absRoot, {
      pid: process.pid,
      port: bound.port,
      url,
      root: absRoot,
      startedAt: new Date().toISOString(),
    });
    process.stdout.write(`Nullform Workflow dashboard: ${url}\n`);

    const cleanup = () => {
      try {
        const info = readRuntime(absRoot);
        if (info && info.pid === process.pid) rmSync(runtimePath(absRoot), { force: true });
      } catch {}
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    if (opts.open && !opts.noOpen) openInBrowser(url);
    return new Promise(() => {});
  }

  if (opts.open) openInBrowser(pathToFileURL(outPath).href);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const res = main(process.argv.slice(2));
  if (typeof res === "number") process.exit(res);
}
