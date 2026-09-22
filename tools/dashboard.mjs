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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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

  return {
    total: records.length,
    medianMs,
    byTier,
    recent: records.slice(-6).reverse().map((r) => ({
      task: String(r.task || "").slice(0, 120),
      tier: r.tier || "?",
      durationMs: Number(r.durationMs) || 0,
      forced: Boolean(r.forced),
    })),
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

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Автономный HTML в стиле Autopilot. */
export function generateDashboardHtml(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  const stageRows = data.stages
    .map((s) => {
      const cls = s.status === "done" ? "done" : s.status === "in_progress" ? "active" : s.status === "missed" ? "missed" : s.status === "skipped" ? "skipped" : "pending";
      const time = s.durationMs ? fmtDuration(s.durationMs) : s.status === "done" ? "—" : s.status === "skipped" ? "не требуется" : s.status === "missed" ? "пропущено" : "не начат";
      return `<li class="stage ${cls}">
        <span class="stage-dot"></span>
        <span class="stage-name">${s.name}${s.detail ? ` <span class="stage-note">${s.detail}</span>` : ""}</span>
        <span class="stage-time">${time}</span>
      </li>`;
    })
    .join("");

  const waveBlocks = data.waves
    .filter((w) => w.stages.length > 0)
    .map((w) => {
      const rows = w.stages
        .map((s) => {
          const cls = s.status === "done" ? "done" : s.status === "in_progress" ? "active" : s.status === "skipped" ? "skipped" : "pending";
          const time = s.durationMs ? fmtDuration(s.durationMs) : s.status === "done" ? "готово" : s.status === "skipped" ? "не требуется" : "ждёт";
          const idx = String(data.stages.indexOf(s) + 1).padStart(2, "0");
          return `<div class="task-row ${cls}">
            <span class="task-idx">${idx}</span>
            <span class="task-bar ${cls}">${s.name}</span>
            <span class="task-time">${time}</span>
          </div>`;
        })
        .join("");
      const agents = w.agents.length
        ? `<div class="wave-agents">${w.agents.map((a) => `<span class="chip">${a.role}</span>`).join("")}</div>`
        : "";
      const parallel = w.stages.filter((s) => s.status !== "skipped").length;
      return `<div class="wave"><div class="wave-title">${w.title}${parallel > 1 ? ` — ${parallel} параллельно` : ""}</div>${rows}${agents}</div>`;
    })
    .join("");

  const moduleRows = data.modules
    .map(
      (m) => `<details class="module">
      <summary>
        <span class="mono">${m.path}/</span>
        <span class="module-meta">${m.fileCount} файлов · ${m.totalLines.toLocaleString("ru-RU")} строк</span>
      </summary>
      <div class="module-files">
        ${m.files.map((f) => `<div class="module-file"><span class="mono">${f.name}</span><span class="muted">${f.lines} строк</span></div>`).join("")}
      </div>
    </details>`
    )
    .join("");

  const diffRows = data.git.isRepo
    ? data.git.files.length
      ? data.git.files
          .map(
            (f) => `<div class="diff-row" data-file="${f.path}">
        <span class="mono diff-path">${f.path}</span>
        <span class="diff-stat"><span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span></span>
        <span class="diff-badge ${f.status}">${f.status}</span>
      </div>`
          )
          .join("")
      : `<div class="empty">Рабочее дерево чистое — изменений нет</div>`
    : `<div class="empty">Не git-репозиторий</div>`;

  const critiqueRows = data.critique.length
    ? data.critique
        .map((c) => {
          const cls = c.verdict === "accept" ? "ok" : c.verdict === "reject" ? "bad" : "warn";
          const label = c.verdict === "accept" ? "ПРИНЯТО" : c.verdict === "reject" ? "ОТКЛОНЕНО" : c.verdict === "mixed" ? "С ЗАМЕЧАНИЯМИ" : "НЕТ ВЕРДИКТА";
          return `<div class="critique-row ${cls}">
            <div><strong>${c.change}</strong> <span class="muted mono">${c.file}</span></div>
            <div class="critique-meta"><span class="verdict ${cls}">${label}</span><span class="muted">замечаний: ${c.concerns}</span></div>
          </div>`;
        })
        .join("")
    : `<div class="empty">Вердиктов оракула пока нет — приёмка не проводилась</div>`;

  const debtRows = data.metrics.debt.items.length
    ? data.metrics.debt.items
        .map(
          (d) => `<div class="debt-row">
        <div class="mono">${d.file}${d.line ? `:${d.line}` : ""}</div>
        <div>${d.what}</div>
        <div class="muted">Потолок: ${d.ceiling || "—"}${d.upgrade ? ` · Апгрейд: ${d.upgrade}` : ""}</div>
      </div>`
        )
        .join("")
    : `<div class="empty">Осознанного техдолга нет — реестр чист${data.metrics.debt.note ? ` (${data.metrics.debt.note})` : ""}</div>`;

  const historyRows = data.history.recent.length
    ? data.history.recent
        .map(
          (h) => `<div class="hist-row">
        <span class="mono">${h.tier}</span>
        <span class="hist-task">${h.task}</span>
        <span class="muted">${fmtDuration(h.durationMs)}${h.forced ? " · force" : ""}</span>
      </div>`
        )
        .join("")
    : `<div class="empty">История пуста</div>`;

  const autoReview = data.metrics.checks?.autoReview;
  const reviewLine = autoReview
    ? `<div class="checks-line">auto-review: ${autoReview.error ? `ошибка (${autoReview.error})` : `проблем — ${autoReview.total ?? autoReview.problems?.length ?? 0}`} · сгенерировано ${new Date(data.metrics.checks.generatedAt).toLocaleString("ru-RU")}</div>`
    : `<div class="checks-line muted">Автопроверки не запускались — добавьте <span class="mono">--checks</span></div>`;

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
  .bar > i { display: block; height: 100%; background: var(--text); border-radius: 999px; transition: width .5s ease; }
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
    <div class="logo"><span>null</span><span class="glyph">✕</span><span>form</span><span class="sub" data-i18n="logoSub">workflow</span></div>
    <div class="controls">
      <button class="icon-btn" onclick="location.reload()" title="Обновить">⟳</button>
      <button class="icon-btn" onclick="setTheme('light')" title="Светлая">☀</button>
      <button class="icon-btn" onclick="setTheme('dark')" title="Тёмная">☾</button>
      <div class="lang">
        <button id="lang-ru" class="active" onclick="setLang('ru')">RU</button>
        <button id="lang-en" onclick="setLang('en')">EN</button>
      </div>
    </div>
  </header>

  <div class="title-row">
    <h1>${data.task.title}</h1>
    <div class="badges">
      <span class="badge badge-status">${data.task.status === "closed" ? "ЗАКРЫТА" : data.task.status === "open" ? "В РАБОТЕ" : "ОЖИДАНИЕ"}</span>
      <span class="badge badge-sdd">4-WAVE SDD</span>
      <span class="badge badge-tier">ЯРУС ${data.task.tier}</span>
    </div>
  </div>

  <section class="card progress-card">
    <div class="progress-top">
      <div class="label" data-i18n="progress">Прогресс проекта</div>
      <div class="progress-pct" id="pct">${data.progress.percent}%</div>
    </div>
    <div class="bar"><i id="pbar" style="width:${data.progress.percent}%"></i></div>
    <div class="sub">${data.progress.stagesDone} из ${data.progress.stagesRequired} обязательных этапов · ${data.progress.artifactsDone} из ${data.progress.artifactsTotal} артефактов${data.progress.stagesSkipped ? ` · ${data.progress.stagesSkipped} не требуется для яруса ${data.task.tier}` : ""}</div>
  </section>

  <div class="grid">
    <div class="card metric">
      <div class="label" data-i18n="coverage">Покрытие брифа</div>
      <svg class="donut" width="72" height="72" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="30" fill="none" stroke="var(--border-soft)" stroke-width="9"></circle>
        <circle cx="36" cy="36" r="30" fill="none" stroke="var(--green)" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${(data.metrics.briefCoverage / 100 * 188.5).toFixed(1)} 188.5" transform="rotate(-90 36 36)"></circle>
      </svg>
      <div class="value">${data.metrics.briefCoverage}%</div>
      <div class="note">${data.metrics.requirements.items.length} требований${data.metrics.requirements.change ? ` · ${data.metrics.requirements.change}` : ""}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="currentStage">Этап сейчас</div>
      <div class="value small">${data.currentStage.name}</div>
      <div class="note">${data.task.status === "closed" ? "задача завершена" : `Волна ${data.currentStage.wave} · ${data.progress.stagesDone} из ${data.progress.stagesRequired} этапов`}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="elapsed">Прошло времени</div>
      <div class="value" id="elapsed">${fmtDuration(data.timing.elapsedMs)}</div>
      <div class="note">медиана задачи — ${data.timing.medianTaskMs ? fmtDuration(data.timing.medianTaskMs) : "нет данных"}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="remaining">Осталось (оценка)</div>
      <div class="value small">${data.timing.remainingMin === null ? "—" : `${data.timing.remainingMin} мин … ${data.timing.remainingMax} мин`}</div>
      <div class="note">${data.timing.remainingMin === null ? "задача закрыта" : `по медиане ${data.history.total} закрытых задач`}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="tasks">Артефакты</div>
      <div class="value">${data.progress.artifactsDone} / ${data.progress.artifactsTotal}</div>
      <div class="bar mini"><i style="width:${Math.round((data.progress.artifactsDone / Math.max(1, data.progress.artifactsTotal)) * 100)}%"></i></div>
      <div class="note">бюджет яруса: ${data.task.budget} вызовов</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="debt">Долг</div>
      <div class="value">${data.metrics.debt.total}</div>
      <div class="note">маркеров defer:${data.metrics.debt.noTrigger ? ` · без триггера ${data.metrics.debt.noTrigger}` : ""}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="diffs">Диффы</div>
      <div class="value">${data.git.isRepo ? data.git.files.length : "—"}</div>
      <div class="note">${data.git.isRepo ? `<span class="add">+${data.git.added}</span> <span class="del">−${data.git.deleted}</span> · staged ${data.git.staged} · untracked ${data.git.untracked}` : "не git-репозиторий"}</div>
    </div>

    <div class="card metric">
      <div class="label" data-i18n="memory">Память</div>
      <div class="value small">${data.metrics.memory.status === "fresh" ? "В НОРМЕ" : data.metrics.memory.status === "overdue" ? "ПРОСРОЧЕНА" : "НЕТ ДАННЫХ"}</div>
      <div class="note">${data.metrics.memory.daysSince !== null ? `дней с ревизии: ${data.metrics.memory.daysSince}` : "ревизия не проводилась"}</div>
    </div>
  </div>

  <section class="card section">
    <div class="label" data-i18n="stages">Этапы</div>
    <ul class="timeline">${stageRows}</ul>
  </section>

  <section class="card section">
    <div class="label" data-i18n="build">Ход сборки — волны SDD</div>
    ${waveBlocks}
  </section>

  <div class="two-col">
    <section class="card section">
      <div class="label" data-i18n="modules">Архитектура и модули</div>
      ${moduleRows || `<div class="empty">Модули не найдены</div>`}
    </section>

    <section class="card section">
      <div class="label" data-i18n="diffsTitle">Диффы (git)</div>
      ${diffRows}
      ${data.git.isRepo ? `<div class="checks-line">Ветка <span class="mono">${data.git.branch}</span> · последний коммит <span class="mono">${data.git.commit?.hash}</span> ${data.git.commit?.when || ""}</div>` : ""}
    </section>
  </div>

  <div class="two-col">
    <section class="card section">
      <div class="label" data-i18n="critique">Критика и ревью</div>
      ${critiqueRows}
      ${reviewLine}
    </section>

    <section class="card section">
      <div class="label" data-i18n="debtTitle">Технический долг</div>
      ${debtRows}
    </section>
  </div>

  <section class="card section">
    <div class="label" data-i18n="history">История работы</div>
    <div class="sub" style="margin-bottom:8px">
      Всего закрыто задач: <strong>${data.history.total}</strong> ·
      медиана: <strong>${data.history.medianTaskMs ? fmtDuration(data.history.medianTaskMs) : "—"}</strong> ·
      по ярусам: ${Object.entries(data.history.byTier).map(([k, v]) => `<span class="chip">${k}: ${v}</span>`).join(" ") || "—"}
    </div>
    ${historyRows}
  </section>

  <section class="card section principles">
    <div class="label" data-i18n="how">Как это работает</div>
    <table>
      <tr><td>Ярусы</td><td><strong>T0</strong> — 1–2 файла, без церемоний · <strong>T1</strong> — 3+ файла, рекогносцировка и 1–2 специалиста · <strong>T2</strong> — архитектура, полный 4-Wave SDD с брифингом и слепой приёмкой · <strong>T3</strong> — программа из нескольких T2-срезов</td></tr>
      <tr><td>Законы</td><td>Честность (ничего не «готово» без выполненной проверки) · Анализ до правок · Минимализм · Один владелец на файл</td></tr>
      <tr><td>Коридор</td><td>Гейт артефактов → TDD-тесты → <span class="mono">test-lens</span> → мутационное тестирование → BDD Gherkin → слепая приёмка Оракула</td></tr>
      <tr><td>Память</td><td>Hindsight (банк <span class="mono">main</span>) + недельная каденция ревизии через <span class="mono">memory-cadence.mjs</span></td></tr>
      <tr><td>Команды</td><td><span class="mono">node tools/dashboard.mjs --serve --open</span> — живой режим · <span class="mono">--checks</span> — прогнать гейты · <span class="mono">--json</span> — машинные данные</td></tr>
    </table>
  </section>

  <footer>
    <span>Проект: <span class="mono">${data.project.name}</span></span>
    <span>Корень: <span class="mono">${data.root}</span></span>
    <span>Обновлено: <span class="mono">${new Date(data.timestamp).toLocaleString("ru-RU")}</span></span>
    ${data.metrics.requirements.change ? `<span>Change: <span class="mono">${data.metrics.requirements.change}</span></span>` : ""}
  </footer>
</div>

<div id="diff-modal" onclick="if(event.target===this)closeDiff()">
  <div id="diff-box">
    <h3 id="diff-title">diff</h3>
    <pre id="diff-body">Загрузка…</pre>
  </div>
</div>

<script>
  var DATA = ${payload};
  var I18N = {
    ru: { logoSub: "workflow", progress: "Прогресс проекта", coverage: "Покрытие брифа", currentStage: "Этап сейчас", elapsed: "Прошло времени", remaining: "Осталось (оценка)", tasks: "Артефакты", debt: "Долг", diffs: "Диффы", memory: "Память", stages: "Этапы", build: "Ход сборки — волны SDD", modules: "Архитектура и модули", diffsTitle: "Диффы (git)", critique: "Критика и ревью", debtTitle: "Технический долг", history: "История работы", how: "Как это работает" },
    en: { logoSub: "workflow", progress: "Project progress", coverage: "Brief coverage", currentStage: "Current stage", elapsed: "Elapsed", remaining: "Remaining (est.)", tasks: "Artifacts", debt: "Debt", diffs: "Diffs", memory: "Memory", stages: "Stages", build: "Build progress — SDD waves", modules: "Architecture & modules", diffsTitle: "Diffs (git)", critique: "Critique & review", debtTitle: "Technical debt", history: "Work history", how: "How it works" }
  };

  function setLang(lang) {
    localStorage.setItem("nf-lang", lang);
    document.getElementById("lang-ru").classList.toggle("active", lang === "ru");
    document.getElementById("lang-en").classList.toggle("active", lang === "en");
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (I18N[lang] && I18N[lang][key]) el.textContent = I18N[lang][key];
    });
  }

  function setTheme(mode) {
    localStorage.setItem("nf-theme", mode);
    document.body.classList.toggle("dark", mode === "dark");
  }

  var savedTheme = localStorage.getItem("nf-theme");
  if (savedTheme === "dark") document.body.classList.add("dark");
  var savedLang = localStorage.getItem("nf-lang") || "ru";
  setLang(savedLang);

  var startMs = DATA.task.startedAt ? new Date(DATA.task.startedAt).getTime() : Date.now();
  var frozen = DATA.task.status === "closed";
  function tick() {
    if (frozen) return;
    var d = Math.max(0, Date.now() - startMs);
    var s = Math.floor(d / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var el = document.getElementById("elapsed");
    if (el) el.textContent = (h > 0 ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  }
  setInterval(tick, 1000);

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
          var esc = l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return cls ? '<span class="' + cls + '">' + esc + "</span>" : esc;
        }).join("\\n");
      })
      .catch(function () { body.textContent = "Дифф недоступен в автономном режиме (откройте с --serve)"; });
  }
  function closeDiff() { document.getElementById("diff-modal").classList.remove("open"); }
  document.querySelectorAll(".diff-row").forEach(function (row) {
    row.addEventListener("click", function () { openDiff(row.getAttribute("data-file")); });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDiff(); });

  setInterval(function () {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (fresh) {
      var pct = document.getElementById("pct");
      var bar = document.getElementById("pbar");
      if (pct) pct.textContent = fresh.progress.percent + "%";
      if (bar) bar.style.width = fresh.progress.percent + "%";
    }).catch(function () {});
  }, 5000);
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Server & CLI                                                       */
/* ------------------------------------------------------------------ */

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

/** Локальный сервер: HTML, /api/state, /api/diff. */
export function startLiveServer(root, port = 4200) {
  const absRoot = resolve(root);

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
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

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(generateDashboardHtml(collectDashboardData(absRoot)));
  });

  server.listen(port, () => {
    console.log(`Nullform Workflow dashboard: http://localhost:${port}`);
  });

  return server;
}

export function parseArgs(argv = []) {
  const options = {
    root: ".",
    output: null,
    open: false,
    serve: false,
    checks: false,
    port: 4200,
    json: false,
    help: false,
    errors: [],
  };
  const KNOWN = new Set(["root", "output", "open", "serve", "checks", "port", "json", "help"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--serve") options.serve = true;
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

export function main(argv = process.argv.slice(2)) {
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
    startLiveServer(absRoot, opts.port);
    if (opts.open) openInBrowser(`http://localhost:${opts.port}`);
    return new Promise(() => {});
  }

  if (opts.open) openInBrowser(pathToFileURL(outPath).href);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const res = main(process.argv.slice(2));
  if (typeof res === "number") process.exit(res);
}
