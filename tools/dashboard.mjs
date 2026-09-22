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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
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

/** Расширения, которые не считаем исходником: шрифты, медиа, архивы, замки. */
const BINARY_EXT = /\.(ttf|otf|woff2?|eot|png|jpe?g|gif|webp|svgz?|ico|bmp|mp[34]|wav|ogg|pdf|zip|gz|tar|7z|rar|xz|exe|dll|so|dylib|bin|wasm|db|sqlite3?|lock)$/i;
function isBinaryName(name) {
  return BINARY_EXT.test(name);
}

/**
 * TTL-кэш для тяжёлых сборщиков.
 *
 * Дашборд опрашивается каждые 3 секунды, а часть данных стоит дорого:
 * обход 250+ файлов (граф зависимостей), спавн node-процесса (debt-ledger),
 * три вызова git. Без кэша один поток сервера занят почти постоянно, и
 * /api/health перестаёт отвечать. Кэш ограничивает пересчёт, не мешая свежести.
 */
const TTL_CACHE = new Map();

function cached(key, ttlMs, compute) {
  const now = Date.now();
  const hit = TTL_CACHE.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = compute();
  TTL_CACHE.set(key, { at: now, value });
  return value;
}

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
      out.push({ name: e, path: full, size: st.size, lines, binary: isBinaryName(e) });
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
    const top = [...files]
      .sort((a, b) => (a.binary === b.binary ? b.lines - a.lines : a.binary ? 1 : -1))
      .slice(0, 12)
      .map((f) => ({
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
    spawnSync("git", args, { cwd: absRoot, encoding: "utf8", timeout: 15000, shell: false , windowsHide: true});

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
export function collectDashboardData(root = ".", options = {}) {
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
      // Текст заметки собирает клиент: сервер не навязывает язык.
      stage.note = "skipped";
      stage.tier = tier;
    } else if (closed) {
      stage.status = "missed";
      stage.note = "missed";
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
    ? { id: "closed", name: "Задача закрыта", wave: 4, detail: "" }
    : stages.find((s) => s.status === "in_progress") ||
      stages.find((s) => s.status === "pending" && required.includes(s.id)) ||
      stages[stages.length - 1];

  // Оценка остатка: по медиане истории и числу незакрытых обязательных артефактов
  const history = cached(`history:${absRoot}`, 10000, () => collectHistory(absRoot));
  const remainingCount = closed ? 0 : required.filter((k) => !artifacts[k]).length;
  const perStage = history.medianMs > 0 ? history.medianMs / Math.max(1, required.length) : 3 * 60000;
  const noWorkLeft = closed || remainingCount === 0;
  const remainingMin = noWorkLeft ? null : Math.max(0, Math.round((remainingCount * perStage) / 60000));
  const remainingMax = noWorkLeft ? null : Math.max(remainingMin ?? 0, Math.round((remainingCount * perStage * 2.2) / 60000));

  const git = cached(`git:${absRoot}`, 3000, () => collectGitStats(absRoot));
  const modules = cached(`modules:${absRoot}`, 60000, () => scanModules(absRoot));
  const requirements = cached(`reqs:${absRoot}`, 30000, () => collectRequirements(absRoot));
  const debt = cached(`debt:${absRoot}`, 30000, () => collectDebt(absRoot));
  const critique = cached(`critique:${absRoot}`, 30000, () => collectCritique(absRoot));

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

  const session = {
    key: sessionKey(options.session || null),
    paseoAgentId: process.env.PASEO_AGENT_ID || null,
    transcript: null,
    usage: null,
  };
  session.usage = collectSessionUsage(absRoot, session.key);
  const sessionFile = newestSessionFile(absRoot);
  if (sessionFile) session.transcript = sessionFile.name;

  return {
    timestamp: new Date().toISOString(),
    root: absRoot,
    session,
    events: cached(`events:${absRoot}`, 2000, () => collectEvents(absRoot, 60)),
    log: cached(`log:${absRoot}`, 5000, () => collectSessionLog(absRoot, 80)),
    arch: cached(`arch:${absRoot}`, 60000, () => collectArchTree(absRoot, modules)),
    archGraph: cached(`graph:${absRoot}`, 60000, () => collectDependencyGraph(absRoot, modules)),
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
/*  Session binding, events, logs, architecture tree                   */
/* ------------------------------------------------------------------ */

/** Файл событий воркфлоу: start/artifact/check/close — источник вкладки «Логи». */
export const EVENTS_FILE = ".workflow/events.jsonl";

/** Каталог рантайм-файлов дашбордов: по одному на (проект, сессия). */
export const DASHBOARDS_DIR = ".workflow/dashboards";

/**
 * Ключ сессии. Приоритет: явный --session, затем идентификатор агента Paseo,
 * затем идентификатор сессии OMP из env, иначе «local».
 * Дашборд привязан к паре (проект, сессия) — у каждой сессии свой экземпляр.
 */
export function sessionKey(override = null) {
  if (override) return String(override);
  if (process.env.PASEO_AGENT_ID) return `paseo-${String(process.env.PASEO_AGENT_ID).slice(0, 8)}`;
  if (process.env.OMP_SESSION_ID) return `omp-${String(process.env.OMP_SESSION_ID).slice(0, 8)}`;
  return "local";
}

/** Стабильный порт для сессии: база + смещение от хеша ключа. */
export function portForSession(key, base = 4200, span = 60) {
  let h = 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return base + (h % span);
}

/**
 * Каталог сессий OMP. OMP кодирует путь как `--D--path-with-dashes--`:
 * и двоеточие, и обратный слэш становятся дефисом. Если для самого каталога
 * сессий нет (агент работал в родительском проекте), поднимаемся по родителям.
 */
export function ompSessionsDir(absRoot) {
  const base = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(base)) return join(base, "--missing--");

  const slugFor = (p) => "--" + p.replace(/[:\\]/g, "-") + "--";
  let cur = resolve(absRoot);
  for (let i = 0; i < 6; i++) {
    const candidate = join(base, slugFor(cur));
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(base, slugFor(resolve(absRoot)));
}

/** Самый свежий JSONL-транскрипт сессии OMP для проекта (или null). */
export function newestSessionFile(absRoot) {
  const dir = ompSessionsDir(absRoot);
  if (!existsSync(dir)) return null;
  let best = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      const st = statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, name: f };
    }
  } catch {}
  return best;
}

/** Хвост файла в байтах (не читаем 2 МБ ради последних событий). */
function tailBytes(path, bytes = 96 * 1024) {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - bytes);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(bytes, st.size));
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Расход сессии: токены, стоимость, модель, статус агента.
 *
 * Источник — `paseo inspect <agent-id> --json` (Paseo-сессия). Опрос стоит ~5 с,
 * поэтому данные НЕ запрашиваются в каждом рендере: читаем кэш и, если он старше
 * TTL, запускаем фоновое обновление, а странице отдаём последнее известное.
 * Вне Paseo (или без агент-идентификатора) функция молча возвращает null —
 * воркфлоу остаётся агностичным к среде.
 */
export const USAGE_TTL_MS = 90 * 1000;

export function collectSessionUsage(absRoot, key) {
  if (!process.env.PASEO_AGENT_ID) return null;
  const cachePath = join(absRoot, DASHBOARDS_DIR, key + ".usage.json");

  let cached = null;
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {}
  }

  const fresh = cached && Date.now() - (cached.at || 0) < USAGE_TTL_MS;
  if (!fresh) refreshUsageAsync(cachePath);

  if (!cached || !cached.data) return null;
  const u = cached.data || {};
  const usage = u.LastUsage || {};
  return {
    at: cached.at,
    stale: !fresh,
    name: u.Name || null,
    provider: u.Provider || null,
    model: u.Model || null,
    status: u.Status || null,
    cwd: u.Cwd || null,
    createdAt: u.CreatedAt || null,
    updatedAt: u.UpdatedAt || null,
    inputTokens: usage.InputTokens || 0,
    outputTokens: usage.OutputTokens || 0,
    cachedTokens: usage.CachedTokens || 0,
    costUsd: typeof usage.CostUsd === "number" ? Number(usage.CostUsd.toFixed(4)) : null,
  };
}

/** Фоновое обновление кэша расхода: отдельный процесс, не блокирует рендер. */
function refreshUsageAsync(cachePath) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return;
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Хелпер: опросить paseo и записать {at, data}. Отдельный процесс нужен,
    // потому что paseo отвечает секундами, а страница опрашивается каждые 3 с.
    const helper = [
      'const { spawnSync } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const id = process.argv[1], out = process.argv[2];",
      'const bin = process.env.PASEO_CLI || "paseo";',
      'const res = spawnSync(bin, ["inspect", id, "--json"], { encoding: "utf8", shell: true, windowsHide: true, timeout: 20000 });',
      "let data = null;",
      'try { data = JSON.parse(res.stdout); } catch {}',
      'if (data) { try { writeFileSync(out, JSON.stringify({ at: Date.now(), data }), "utf8"); } catch {} }',
    ].join(" ");

    const child = spawn(process.execPath, ["-e", helper, agentId, cachePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // расход — приятный бонус, не условие работы
  }
}

/** События воркфлоу из .workflow/events.jsonl (последние N). */
export function collectEvents(absRoot, limit = 60) {
  const path = join(absRoot, EVENTS_FILE);
  if (!existsSync(path)) return [];
  const lines = tailBytes(path, 64 * 1024).split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      out.push(e);
    } catch {}
  }
  return out.slice(-limit).reverse();
}

/**
 * Значимые события сессии OMP: вызовы инструментов, сообщения, системные заметки.
 * Показываем хвост, а не весь транскрипт — сессии бывают на мегабайты.
 */
export function collectSessionLog(absRoot, limit = 80) {
  const file = newestSessionFile(absRoot);
  if (!file) return { file: null, entries: [] };

  const raw = tailBytes(file.path, 128 * 1024);
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];

  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }

    if (e.type === "custom" && e.customType === "tool_execution_start") {
      const d = e.data || {};
      const args = d.args || {};
      const hint = args.command || args.path || args.file || args.query || args.pattern || args.i || "";
      entries.push({
        at: e.timestamp || null,
        kind: "tool",
        label: d.toolName || "tool",
        text: String(hint).slice(0, 140),
      });
    } else if (e.type === "message") {
      const m = e.message || {};
      const text = Array.isArray(m.content)
        ? m.content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim()
        : "";
      if (!text) continue;
      const role = m.role || "?";
      if (role === "toolResult") {
        const isError = /^(error|ошибка|failed|exception)/i.test(text) || /exit code [1-9]/.test(text);
        entries.push({
          at: e.timestamp || null,
          kind: isError ? "error" : "result",
          label: m.toolName || "result",
          text: text.slice(0, 160).replace(/\s+/g, " "),
        });
      } else if (role === "assistant") {
        entries.push({ at: e.timestamp || null, kind: "assistant", label: "assistant", text: text.slice(0, 200).replace(/\s+/g, " ") });
      } else if (role === "user") {
        entries.push({ at: e.timestamp || null, kind: "user", label: "user", text: text.slice(0, 200).replace(/\s+/g, " ") });
      }
    } else if (e.type === "custom_message") {
      entries.push({
        at: e.timestamp || null,
        kind: "notice",
        label: e.customType || "notice",
        text: String(e.content || "").slice(0, 200),
      });
    }
  }

  return { file: file.name, entries: entries.slice(-limit) };
}

/**
 * Дерево архитектуры для майндкарты: проект → модули → крупнейшие файлы.
 * Бинарные файлы (шрифты, медиа) в дерево не попадают — они не объясняют устройство.
 */
export function collectArchTree(absRoot, modules) {
  const name = absRoot.split(/[\\/]/).pop() || "project";
  const kindOf = (m) =>
    m.name === "tools" ? "code" : m.name === "agent" || m.name === "rules" ? "law" : m.name === "skills" ? "skills" : m.name === "tests" ? "tests" : m.name === "openspec" ? "spec" : "other";

  return {
    name,
    kind: "root",
    lines: modules.reduce((s, m) => s + m.totalLines, 0),
    files: modules.reduce((s, m) => s + m.fileCount, 0),
    children: modules.map((m) => ({
      name: m.path,
      kind: kindOf(m),
      files: m.fileCount,
      lines: m.totalLines,
      children: (m.files || [])
        .filter((f) => !isBinaryName(f.name))
        .slice(0, 8)
        .map((f) => ({ name: f.name.split("/").pop(), kind: "file", lines: f.lines, path: f.name })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Dependency graph: кто на кого ссылается                            */
/* ------------------------------------------------------------------ */

/** Идентификатор модуля: первые один-два сегмента пути. */
function moduleIdOf(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/");
  if (parts.length <= 1) return "root";
  if (parts[0] === "tools" && parts[1] === "tests") return "tools/tests";
  return parts[0];
}

/** Все файлы-исходники и документы, по которым строим граф. */
function graphSourceFiles(absRoot) {
  const out = [];
  const add = (dir, filter, limit = 400) => {
    const base = join(absRoot, dir);
    if (!existsSync(base)) return;
    const walk = (d) => {
      if (out.length >= limit) return;
      let entries = [];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const full = join(d, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && filter(e)) out.push(full);
      }
    };
    walk(base);
  };

  add("tools", (e) => e.endsWith(".mjs"));
  add("agent", (e) => e.endsWith(".md"));
  add("skills", (e) => e.endsWith(".md"), 250);
  add("tests", (e) => e.endsWith(".ps1"));
  add("core", (e) => e.endsWith(".md"));
  return out;
}

/**
 * Граф зависимостей проекта: узлы — модули, рёбра — реальные ссылки.
 *
 * Рёбра строятся из двух источников:
 *   1. ES-импорты в .mjs (относительные пути → файл → модуль);
 *   2. ссылки на инструменты в документах (agent/*.md, skills/**, core/*.md):
 *      `<HARNESS>/tools/x.mjs`, `tools/x.mjs`, `node tools/x.mjs`.
 * Внешние зависимости (node:, npm-пакеты) считаются отдельно — они не создают
 * шумных узлов, но показывают «поверхность» проекта.
 */
export function collectDependencyGraph(absRoot, modules) {
  const files = graphSourceFiles(absRoot);
  const edges = new Map(); // "from→to" → { from, to, weight, kinds:Set }
  const externalByModule = new Map();

  const bump = (from, to, kind, weight = 1) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}`;
    const cur = edges.get(key) || { from, to, weight: 0, kinds: new Set() };
    cur.weight += weight;
    cur.kinds.add(kind);
    edges.set(key, cur);
  };

  for (const file of files) {
    const rel = relative(absRoot, file).replace(/\\/g, "/");
    const from = moduleIdOf(rel);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    if (rel.endsWith(".mjs")) {
      // Импорты: относительные → ребро графа; внешние → счётчик поверхности
      const importRe = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
      let m;
      let external = 0;
      while ((m = importRe.exec(text)) !== null) {
        const spec = m[1] || m[2] || "";
        if (spec.startsWith(".")) {
          const resolved = join(dirname(file), spec).replace(/\\/g, "/");
          const relTarget = relative(absRoot, resolved).replace(/\\/g, "/");
          bump(from, moduleIdOf(relTarget), "import");
        } else if (spec) {
          external++;
        }
      }
      if (external > 0) externalByModule.set(from, (externalByModule.get(from) || 0) + external);
    } else if (rel.endsWith(".md") || rel.endsWith(".ps1")) {
      // Ссылки на инструменты в тексте: tools/foo.mjs
      const refRe = /tools[\\/]([a-z0-9._-]+\.(?:mjs|ps1|py))/gi;
      let m;
      const seen = new Set();
      while ((m = refRe.exec(text)) !== null) {
        const target = m[1].toLowerCase();
        if (seen.has(target)) continue;
        seen.add(target);
        bump(from, "tools", "reference");
      }
    }
  }

  const nodeIds = new Set(modules.map((m) => m.name));
  nodeIds.add("root");
  nodeIds.add("tools/tests");

  const nodes = [...nodeIds]
    .map((id) => {
      const mod = modules.find((m) => m.name === id);
      const outgoing = [...edges.values()].filter((e) => e.from === id).reduce((s, e) => s + e.weight, 0);
      const incoming = [...edges.values()].filter((e) => e.to === id).reduce((s, e) => s + e.weight, 0);
      return {
        id,
        files: mod ? mod.fileCount : 0,
        lines: mod ? mod.totalLines : 0,
        external: externalByModule.get(id) || 0,
        outWeight: outgoing,
        inWeight: incoming,
        topFiles: mod ? (mod.files || []).filter((f) => !isBinaryName(f.name)).slice(0, 8).map((f) => f.name) : [],
      };
    })
    .filter((n) => n.files > 0 || n.id === "root");

  const edgeList = [...edges.values()]
    .map((e) => ({ from: e.from, to: e.to, weight: e.weight, kinds: [...e.kinds] }))
    .sort((a, b) => b.weight - a.weight);

  return { nodes, edges: edgeList, scannedFiles: files.length };
}

/* ------------------------------------------------------------------ */
/*  HTML                                                               */
/* ------------------------------------------------------------------ */

/**
 * Автономная страница «Nullform Console»: серверный каркас + клиентский рендер.
 *
 * Свой стиль (не копия Autopilot): тёмный консольный холст по умолчанию,
 * лаймовый акцент, монопространственные значения, левый рельс вкладок.
 * Вкладки: Обзор · Архитектура (майндкарта) · Логи сессии · Диффы · Критика · Долг · История.
 * Данные приходят из `/api/state` каждые 3 с и перерисовываются на месте.
 */
export function generateDashboardHtml(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nullform Console · ${data.project.name}</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #11151f; --panel-2: #161b28; --line: #232a3a; --line-soft: #1a2030;
    --text: #e6ebf5; --dim: #8b94a7; --dim-2: #5d6779;
    --lime: #b8ff2e; --lime-dim: #7fae1f; --amber: #ffb545; --red: #ff5f56; --blue: #6ea8fe; --violet: #c58fff;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --r: 10px;
  }
  body.light {
    --bg: #f7f8fa; --panel: #ffffff; --panel-2: #f2f4f7; --line: #e2e6ee; --line-soft: #edf0f5;
    --text: #10141c; --dim: #5f6878; --dim-2: #98a1b0;
    --lime: #5f8f00; --lime-dim: #7fae1f;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--text); line-height: 1.45; }
  .mono { font-family: var(--mono); font-size: 12px; }
  a { color: var(--lime); }

  /* ---------- top bar ---------- */
  header { display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 20; }
  .brand { display: flex; align-items: baseline; gap: 7px; font-weight: 800; letter-spacing: -0.3px; font-size: 17px; }
  .brand .x { color: var(--lime); font-weight: 900; }
  .brand .sub { font-size: 12px; font-weight: 500; color: var(--dim); letter-spacing: 0.4px; text-transform: uppercase; }
  .chip { font-family: var(--mono); font-size: 11px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); white-space: nowrap; }
  .chip b { color: var(--text); font-weight: 600; }
  .spacer { flex: 1; }
  .live { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
  .live.on { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 45%, transparent); }
  .live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dim-2); }
  .live.on .dot { background: var(--lime); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .2 } }
  .ibtn { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); cursor: pointer; font-size: 13px; }
  .ibtn:hover { border-color: var(--dim-2); }
  .seg { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: var(--panel-2); color: var(--dim); padding: 5px 9px; cursor: pointer; font-family: var(--mono); font-size: 11px; }
  .seg button.active { background: var(--lime); color: #0b0e14; font-weight: 700; }

  /* ---------- layout: rail + content ---------- */
  .shell { display: grid; grid-template-columns: 208px 1fr; min-height: calc(100vh - 55px); }
  @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .rail { display: flex; overflow-x: auto; } }
  .rail { border-right: 1px solid var(--line); background: var(--panel); padding: 14px 10px; }
  .rail button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 9px 11px; margin-bottom: 3px; border: 0; border-radius: 8px; background: transparent; color: var(--dim); cursor: pointer; font-size: 13px; }
  .rail button:hover { background: var(--panel-2); color: var(--text); }
  .rail button.active { background: var(--panel-2); color: var(--text); box-shadow: inset 2px 0 0 var(--lime); }
  .rail .ico { width: 16px; text-align: center; opacity: .9; }
  .rail .badge-n { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--dim-2); }
  .content { padding: 20px 22px 60px; max-width: 1400px; }
  .tab { display: none; }
  .tab.active { display: block; }

  /* ---------- cards & metrics ---------- */
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 16px 18px; }
  .label { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.9px; text-transform: uppercase; color: var(--dim-2); margin-bottom: 8px; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
  @media (max-width: 1100px) { .grid4 { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .grid4 { grid-template-columns: 1fr; } }
  .v { font-family: var(--mono); font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
  .v.sm { font-size: 16px; }
  .note { font-size: 11.5px; color: var(--dim); margin-top: 3px; }
  .bar { height: 8px; background: var(--line-soft); border-radius: 99px; overflow: hidden; margin: 12px 0 7px; }
  .bar > i { display: block; height: 100%; background: var(--lime); transition: width .6s ease; }
  .bar.mini { height: 5px; margin: 7px 0 5px; }
  .bar.mini > i { background: var(--blue); }
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .hero .pct { font-family: var(--mono); font-size: 40px; font-weight: 800; letter-spacing: -2px; line-height: 1; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
  .title-row h1 { font-size: 17px; font-weight: 700; }
  .tag { font-family: var(--mono); font-size: 10.5px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--line); color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .tag.on { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 40%, transparent); }
  .tag.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }

  /* ---------- stages / waves ---------- */
  .stage { display: flex; align-items: center; gap: 11px; padding: 9px 2px; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
  .stage:last-child { border-bottom: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex: 0 0 auto; }
  .stage.done .dot { background: var(--lime); }
  .stage.active .dot { background: var(--amber); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 20%, transparent); }
  .stage.skipped .dot { background: transparent; border: 1px dashed var(--line); }
  .stage.missed .dot { background: var(--red); }
  .stage.skipped .nm { color: var(--dim-2); }
  .stage .nm { flex: 1; }
  .stage .tm { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  .stage-note { color: var(--dim-2); font-size: 11.5px; }
  .wave-title { font-family: var(--mono); font-size: 10.5px; letter-spacing: .8px; text-transform: uppercase; color: var(--dim-2); margin: 14px 0 7px; }
  .task { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; }
  .task .idx { font-family: var(--mono); font-size: 10px; color: var(--dim-2); width: 18px; }
  .task .b { flex: 1; padding: 6px 11px; border-radius: 7px; font-size: 12.5px; font-weight: 600; }
  .task .b.done { background: color-mix(in srgb, var(--lime) 18%, transparent); color: var(--lime); border: 1px solid color-mix(in srgb, var(--lime) 30%, transparent); }
  .task .b.active { background: color-mix(in srgb, var(--amber) 18%, transparent); color: var(--amber); border: 1px solid color-mix(in srgb, var(--amber) 32%, transparent); }
  .task .b.pending { background: var(--panel-2); color: var(--dim); border: 1px solid var(--line-soft); }
  .task .b.skipped { background: transparent; color: var(--dim-2); border: 1px dashed var(--line); font-weight: 500; }
  .task .t { font-family: var(--mono); font-size: 11px; color: var(--dim); width: 66px; text-align: right; }

  /* ---------- lists ---------- */
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
  .row:last-child { border-bottom: 0; }
  .row .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
  .pill.ok { color: var(--lime); border-color: color-mix(in srgb, var(--lime) 35%, transparent); }
  .pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 35%, transparent); }
  .pill.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 35%, transparent); }
  .add { color: var(--lime); } .del { color: var(--red); }
  .empty { color: var(--dim-2); font-size: 12.5px; padding: 10px 0; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
  .stack { display: grid; gap: 14px; }

  /* ---------- logs ---------- */
  .log { font-family: var(--mono); font-size: 11.5px; max-height: 62vh; overflow: auto; }
  .log .ln { display: grid; grid-template-columns: 66px 92px 1fr; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--line-soft); }
  .log .ts { color: var(--dim-2); }
  .log .k { color: var(--blue); }
  .log .k.tool { color: var(--violet); }
  .log .k.error { color: var(--red); }
  .log .k.notice { color: var(--amber); }
  .log .k.user { color: var(--lime); }
  .log .tx { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log .tx.err { color: var(--red); }

  /* ---------- mindmap ---------- */
  .map-wrap { position: relative; overflow: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); }
  .map-tools { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .map-tools button { font-family: var(--mono); font-size: 11px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel-2); color: var(--dim); cursor: pointer; }
  .map-tools button:hover { color: var(--text); }
  svg.map { display: block; }
  .map .link { fill: none; stroke: var(--line); stroke-width: 1.4; }
  .map .node rect { fill: var(--panel-2); stroke: var(--line); rx: 8; }
  .map .node.root rect { fill: color-mix(in srgb, var(--lime) 16%, var(--panel-2)); stroke: color-mix(in srgb, var(--lime) 45%, transparent); }
  .map .node.code rect { stroke: color-mix(in srgb, var(--blue) 45%, transparent); }
  .map .node.law rect { stroke: color-mix(in srgb, var(--violet) 45%, transparent); }
  .map .node.skills rect { stroke: color-mix(in srgb, var(--amber) 40%, transparent); }
  .map .node.tests rect { stroke: color-mix(in srgb, var(--lime) 35%, transparent); }
  .map .node.spec rect { stroke: color-mix(in srgb, var(--blue) 30%, transparent); }
  .map .node { cursor: pointer; }
  .map .node:hover rect { stroke: var(--lime); }
  .map .node text { fill: var(--text); font-family: var(--mono); font-size: 11.5px; }
  .map .node .meta { fill: var(--dim); font-size: 10px; }
  .map .node.collapsed rect { stroke-dasharray: 4 3; }

  /* ---------- architecture: modes, graph, detail panel ---------- */
  .map-tools button.on { border-color: var(--lime); color: var(--lime); }
  .inp { font-family: var(--mono); font-size: 11.5px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); min-width: 170px; }
  .inp:focus { outline: none; border-color: var(--lime); }
  .arch-body { display: grid; grid-template-columns: 1fr 300px; gap: 12px; align-items: start; }
  @media (max-width: 1100px) { .arch-body { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px; min-height: 120px; }
  .kv { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--line-soft); }
  .kv:last-child { border-bottom: 0; }
  .kv span { color: var(--dim); }
  .kv b { font-family: var(--mono); font-weight: 600; }
  .map .node.dim { opacity: .25; }
  .map .node.sel rect { stroke: var(--lime); stroke-width: 2; }
  .map .gnode { cursor: pointer; }
  .map .gnode rect { fill: var(--panel-2); stroke: var(--line); }
  .map .gnode.code rect { stroke: color-mix(in srgb, var(--blue) 45%, transparent); }
  .map .gnode.law rect { stroke: color-mix(in srgb, var(--violet) 45%, transparent); }
  .map .gnode.skills rect { stroke: color-mix(in srgb, var(--amber) 40%, transparent); }
  .map .gnode.tests rect { stroke: color-mix(in srgb, var(--lime) 40%, transparent); }
  .map .gnode:hover rect, .map .gnode.sel rect { stroke: var(--lime); stroke-width: 2; }
  .map .gnode.dim { opacity: .25; }
  .map .gnode text { fill: var(--text); font-family: var(--mono); font-size: 12px; }
  .map .gnode .meta { fill: var(--dim); font-size: 10px; }
  .map .edge { fill: none; stroke: var(--dim-2); opacity: .55; }
  .map .edge.hot { stroke: var(--lime); opacity: 1; }
  .map .edge-w { fill: var(--dim-2); font-family: var(--mono); font-size: 9.5px; text-anchor: middle; }
  .row.sel { background: var(--panel-2); }
  .wave-agents { margin: 4px 0 0 27px; display: flex; gap: 6px; flex-wrap: wrap; }

  #modal { position: fixed; inset: 0; background: rgba(4,6,10,.7); display: none; align-items: center; justify-content: center; padding: 28px; z-index: 50; }
  #modal.open { display: flex; }
  #modal .box { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); width: 100%; max-width: 1040px; max-height: 84vh; overflow: auto; padding: 16px 18px; }
  #modal h3 { font-family: var(--mono); font-size: 13px; margin-bottom: 10px; }
  #modal pre { font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; }
  .d-add { color: var(--lime); } .d-del { color: var(--red); } .d-hunk { color: var(--blue); }
  .flash { animation: flash 1.2s ease; }
  @keyframes flash { 0% { box-shadow: inset 0 0 0 1px var(--lime); } 100% { box-shadow: none; } }
</style>
</head>
<body>
<header>
  <div class="brand"><span>null</span><span class="x">✕</span><span>form</span><span class="sub">console</span></div>
  <span class="chip">проект <b id="h-project">…</b></span>
  <span class="chip">сессия <b id="h-session">…</b></span>
  <span class="chip">модель <b id="h-model">…</b></span>
  <span class="chip" id="h-branch">…</span>
  <div class="spacer"></div>
  <span class="live" id="live"><span class="dot"></span><span id="live-text">снимок</span></span>
  <button class="ibtn" onclick="refreshNow()" title="Обновить">⟳</button>
  <button class="ibtn" onclick="setTheme('dark')" title="Тёмная">◐</button>
  <button class="ibtn" onclick="setTheme('light')" title="Светлая">◑</button>
  <div class="seg"><button id="l-ru" class="active" onclick="setLang('ru')">RU</button><button id="l-en" onclick="setLang('en')">EN</button></div>
</header>

<div class="shell">
  <nav class="rail" id="rail"></nav>
  <main class="content">
    <section class="tab active" id="tab-overview"></section>
    <section class="tab" id="tab-arch"></section>
    <section class="tab" id="tab-logs"></section>
    <section class="tab" id="tab-diffs"></section>
    <section class="tab" id="tab-critique"></section>
    <section class="tab" id="tab-debt"></section>
    <section class="tab" id="tab-history"></section>
  </main>
</div>

<div id="modal" onclick="if(event.target===this)closeModal()">
  <div class="box"><h3 id="modal-title">…</h3><pre id="modal-body">…</pre></div>
</div>

<script>
  var DATA = ${payload};
  var POLL_MS = 3000;
  var TAB = localStorage.getItem("nf-tab") || "overview";
  var lang = localStorage.getItem("nf-lang") || "ru";
  var collapsed = null;         // свёрнутые узлы майндкарты (null = ещё не инициализировано)
  var fingerprint = null;

  /* ============================ i18n ============================ */
  var I18N = {
    ru: {
      // шапка
      project: "проект", session: "сессия", model: "модель", live: "LIVE", snapshot: "снимок",
      // вкладки
      overview: "Обзор", arch: "Архитектура", logs: "Логи сессии", diffs: "Диффы", critique: "Критика", debt: "Долг", history: "История",
      // обзор
      progress: "Прогресс проекта", coverage: "Покрытие брифа", stageNow: "Этап сейчас", elapsed: "Прошло", remaining: "Осталось",
      artifacts: "Артефакты", debtShort: "Долг", diffsShort: "Диффы", memory: "Память",
      cost: "Стоимость сессии", tokens: "Токены", sessionCard: "Сессия",
      reqs: "требований", budget: "бюджет яруса", calls: "вызовов", deferMarks: "маркеров defer:",
      noTrigger: "без триггера", daysSince: "дней с ревизии", noReview: "ревизия не проводилась",
      stagesDone: "обязательных этапов", artifactsOf: "артефактов", notRequired: "не требуется для яруса",
      taskClosed: "задача завершена", allArtifacts: "обязательные артефакты собраны", median: "медиана",
      byMedianOf: "по медиане", closedTasks: "закрытых задач", noData: "нет данных", notGit: "не git-репозиторий",
      stages: "Этапы", build: "Ход сборки — волны SDD", wave: "Волна",
      stage_lane: "Ярус и постановка", stage_recon: "Разведка и контекст", stage_manifest: "Манифест требований (R##)",
      stage_openspec: "Спецификация OpenSpec", stage_interfaces: "Интерфейсы и владельцы",
      stage_oracle: "Слепая приёмка Оракула", stage_closed: "Закрытие и архив",
      st_in_progress: "идёт", st_active: "идёт",
      st_done: "готово", st_wait: "ждёт", st_running: "идёт", st_skipped: "не требуется", st_missed: "пропущено", st_pending: "не начат",
      status_closed: "ЗАКРЫТА", status_open: "В РАБОТЕ", status_idle: "ОЖИДАНИЕ",
      mem_fresh: "В НОРМЕ", mem_overdue: "ПРОСРОЧЕНА", mem_none: "НЕТ ДАННЫХ",
      cache: "кэш", updating: "данные обновляются", byPaseo: "по данным Paseo", provider: "провайдер",
      // архитектура
      viewTree: "Схема", viewGraph: "Граф зависимостей", viewTable: "Таблица",
      collapseAll: "Свернуть всё", expandAll: "Развернуть всё", clickNode: "клик по узлу — детали",
      files: "файлов", lines: "строк", filter: "фильтр: имя модуля", zoom: "масштаб", reset: "сброс",
      details: "Детали", incoming: "Входящие", outgoing: "Исходящие", external: "Внешние импорты",
      topFiles: "Крупнейшие файлы", noDeps: "связей нет", selectNode: "Выберите узел, чтобы увидеть детали",
      kindCode: "код", kindLaw: "законы", kindSkills: "навыки", kindTests: "тесты", kindSpec: "спеки", kindOther: "прочее", kindRoot: "проект",
      depImport: "импорт", depRef: "ссылка",
      // логи
      wfEvents: "События воркфлоу", agentSession: "Сессия агента", noEvents: "Событий пока нет — они появятся после start/artifact/close",
      noTranscript: "Транскрипт сессии не найден",
      // диффы
      diffHint: "Диффы (git) — клик по файлу откроет diff", cleanTree: "Рабочее дерево чистое",
      branch: "Ветка", commit: "коммит", modified: "изменён", untracked: "новый",
      // критика
      critiqueTitle: "Критика и ревью", noVerdicts: "Вердиктов оракула пока нет",
      v_accept: "ПРИНЯТО", v_reject: "ОТКЛОНЕНО", v_mixed: "С ЗАМЕЧАНИЯМИ", v_unknown: "НЕТ ВЕРДИКТА",
      concerns: "замечаний", noChecks: "Автопроверки не запускались",
      // долг
      debtTitle: "Технический долг", debtClean: "Осознанного техдолга нет — реестр чист",
      ceiling: "потолок", upgrade: "апгрейд",
      // история
      historyTitle: "История работы", closedCount: "Закрыто задач", byTier: "по ярусам", empty: "пусто",
      howItWorks: "Как это работает", help: "Справка", close: "Закрыть",
    },
    en: {
      project: "project", session: "session", model: "model", live: "LIVE", snapshot: "snapshot",
      overview: "Overview", arch: "Architecture", logs: "Session log", diffs: "Diffs", critique: "Critique", debt: "Debt", history: "History",
      progress: "Project progress", coverage: "Brief coverage", stageNow: "Current stage", elapsed: "Elapsed", remaining: "Remaining",
      artifacts: "Artifacts", debtShort: "Debt", diffsShort: "Diffs", memory: "Memory",
      cost: "Session cost", tokens: "Tokens", sessionCard: "Session",
      reqs: "requirements", budget: "tier budget", calls: "calls", deferMarks: "defer: markers",
      noTrigger: "no trigger", daysSince: "days since review", noReview: "never reviewed",
      stagesDone: "required stages", artifactsOf: "artifacts", notRequired: "not required for tier",
      taskClosed: "task closed", allArtifacts: "all required artifacts collected", median: "median",
      byMedianOf: "median of", closedTasks: "closed tasks", noData: "no data", notGit: "not a git repo",
      stages: "Stages", build: "Build — SDD waves", wave: "Wave",
      stage_lane: "Lane & statement", stage_recon: "Recon & context", stage_manifest: "Requirements manifest (R##)",
      stage_openspec: "OpenSpec specification", stage_interfaces: "Interfaces & owners",
      stage_oracle: "Oracle blind acceptance", stage_closed: "Close & archive",
      st_in_progress: "running", st_active: "running",
      st_done: "done", st_wait: "waiting", st_running: "running", st_skipped: "not required", st_missed: "missed", st_pending: "not started",
      status_closed: "CLOSED", status_open: "IN PROGRESS", status_idle: "IDLE",
      mem_fresh: "FRESH", mem_overdue: "OVERDUE", mem_none: "NO DATA",
      cache: "cache", updating: "refreshing", byPaseo: "from Paseo", provider: "provider",
      viewTree: "Scheme", viewGraph: "Dependency graph", viewTable: "Table",
      collapseAll: "Collapse all", expandAll: "Expand all", clickNode: "click a node for details",
      files: "files", lines: "lines", filter: "filter: module name", zoom: "zoom", reset: "reset",
      details: "Details", incoming: "Incoming", outgoing: "Outgoing", external: "External imports",
      topFiles: "Largest files", noDeps: "no links", selectNode: "Select a node to see details",
      kindCode: "code", kindLaw: "law", kindSkills: "skills", kindTests: "tests", kindSpec: "specs", kindOther: "other", kindRoot: "project",
      depImport: "import", depRef: "reference",
      wfEvents: "Workflow events", agentSession: "Agent session", noEvents: "No events yet — they appear after start/artifact/close",
      noTranscript: "Session transcript not found",
      diffHint: "Git diffs — click a file to open the diff", cleanTree: "Working tree is clean",
      branch: "Branch", commit: "commit", modified: "modified", untracked: "untracked",
      critiqueTitle: "Critique & review", noVerdicts: "No oracle verdicts yet",
      v_accept: "ACCEPTED", v_reject: "REJECTED", v_mixed: "WITH CONCERNS", v_unknown: "NO VERDICT",
      concerns: "concerns", noChecks: "Automated checks were not run",
      debtTitle: "Technical debt", debtClean: "No deliberate debt — ledger is clean",
      ceiling: "ceiling", upgrade: "upgrade",
      historyTitle: "Work history", closedCount: "Closed tasks", byTier: "by tier", empty: "empty",
      howItWorks: "How it works", help: "Help", close: "Close",
    }
  };
  var lang = localStorage.getItem("nf-lang") || "ru";
  function t(k) { return (I18N[lang] && I18N[lang][k]) || (I18N.ru[k] || k); }

  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h > 0 ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  }
  function fmtTime(iso) {
    if (!iso) return "";
    try { var d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); } catch (e) { return ""; }
  }
  function num(n) { return Number(n || 0).toLocaleString(lang === "ru" ? "ru-RU" : "en-US"); }
  var CLS = { done: "done", in_progress: "active", missed: "missed", skipped: "skipped", pending: "pending" };
  function scls(s) { return CLS[s] || "pending"; }
  function stime(s) { return s.durationMs ? fmtDur(s.durationMs) : t("st_" + s.status) || t("st_pending"); }
  function wtime(s) { return s.durationMs ? fmtDur(s.durationMs) : (s.status === "done" ? t("st_done") : s.status === "skipped" ? t("st_skipped") : t("st_wait")); }
  function badge(s) { return s === "closed" ? t("status_closed") : s === "open" ? t("status_open") : t("status_idle"); }
  function memLabel(s) { return s === "fresh" ? t("mem_fresh") : s === "overdue" ? t("mem_overdue") : t("mem_none"); }
  function kindLabel(k) { return t("kind" + k.charAt(0).toUpperCase() + k.slice(1)) || k; }
  /** Имя стадии переводится по её id: сервер не хранит язык интерфейса. */
  function stageName(s) { return t("stage_" + s.id) || s.id; }
  /** Заметка стадии: «не требуется для яруса T1» / «пропущено» — на языке интерфейса. */
  function stageNote(s) {
    if (s.note === "skipped") return t("notRequired") + " " + esc(s.tier || "");
    if (s.note === "missed") return t("st_missed");
    return s.detail ? esc(s.detail) : "";
  }

  /* ============================ rail ============================ */
  var TABS = [
    { id: "overview", ico: "◎" }, { id: "arch", ico: "⑃" }, { id: "logs", ico: "≡" },
    { id: "diffs", ico: "±" }, { id: "critique", ico: "✓" }, { id: "debt", ico: "⏚" }, { id: "history", ico: "⏱" },
  ];
  function renderRail(d) {
    var counts = { diffs: d.git.files.length, critique: d.critique.length, debt: d.metrics.debt.total, logs: d.log.entries.length + (d.events || []).length, history: d.history.total };
    document.getElementById("rail").innerHTML = TABS.map(function (x) {
      return '<button data-tab="' + x.id + '" class="' + (TAB === x.id ? "active" : "") + '" title="' + t(x.id) + '">' +
        '<span class="ico">' + x.ico + "</span><span>" + t(x.id) + "</span>" +
        (counts[x.id] ? '<span class="badge-n">' + counts[x.id] + "</span>" : "") + "</button>";
    }).join("");
    document.querySelectorAll("#rail button").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    });
  }
  function showTab(id) {
    TAB = id; localStorage.setItem("nf-tab", id);
    document.querySelectorAll(".tab").forEach(function (s) { s.classList.toggle("active", s.id === "tab-" + id); });
    document.querySelectorAll("#rail button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-tab") === id); });
    if (id === "arch") drawArch();
  }

  /* ========================== overview ========================== */
  function card(label, value, note, id, barPct) {
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="v' + (String(value).length > 9 ? " sm" : "") + '"' + (id ? ' id="' + id + '"' : "") + ">" + value + "</div>" +
      (barPct !== undefined && barPct !== null ? '<div class="bar mini"><i style="width:' + barPct + '%"></i></div>' : "") +
      '<div class="note">' + note + "</div></div>";
  }
  function renderOverview(d) {
    var p = d.progress, m = d.metrics, g = d.git;
    var sess = "";
    if (d.session.usage) {
      var u = d.session.usage;
      var cachePct = u.inputTokens + u.cachedTokens > 0 ? Math.round(u.cachedTokens / (u.inputTokens + u.cachedTokens) * 100) : 0;
      sess = '<div class="grid4" style="margin-bottom:14px">' +
        card(t("sessionCard"), esc(d.session.key), esc(u.status || "") + (u.stale ? " · " + t("updating") : "")) +
        card(t("cost"), u.costUsd !== null ? "$" + u.costUsd : "—", t("byPaseo")) +
        card(t("tokens"), num(u.inputTokens) + " / " + num(u.outputTokens), t("cache") + " " + cachePct + "%") +
        card(t("model"), esc((u.model || "—").split("/").pop()), t("provider") + ": " + esc(u.provider || "—")) +
        "</div>";
    }
    var cards = [
      card(t("coverage"), m.briefCoverage + "%", m.requirements.items.length + " " + t("reqs") + (m.requirements.change ? " · " + esc(m.requirements.change) : "")),
      card(t("stageNow"), esc(d.currentStage.id ? t("stage_" + d.currentStage.id) : d.currentStage.name), d.task.status === "closed" ? t("taskClosed") : t("wave") + " " + d.currentStage.wave + " · " + p.stagesDone + "/" + p.stagesRequired),
      card(t("elapsed"), fmtDur(d.timing.elapsedMs), t("median") + " — " + (d.timing.medianTaskMs ? fmtDur(d.timing.medianTaskMs) : t("noData")), "elapsed"),
      card(t("remaining"), d.timing.remainingMin === null ? "—" : d.timing.remainingMin + "…" + d.timing.remainingMax + "m", d.timing.remainingMin === null ? (d.task.status === "closed" ? t("taskClosed") : t("allArtifacts")) : t("byMedianOf") + " " + d.history.total + " " + t("closedTasks")),
      card(t("artifacts"), p.artifactsDone + " / " + p.artifactsTotal, t("budget") + ": " + d.task.budget + " " + t("calls"), null, Math.round(p.artifactsDone / Math.max(1, p.artifactsTotal) * 100)),
      card(t("debtShort"), String(m.debt.total), t("deferMarks") + (m.debt.noTrigger ? " · " + t("noTrigger") + " " + m.debt.noTrigger : "")),
      card(t("diffsShort"), String(g.isRepo ? g.files.length : "—"), g.isRepo ? '<span class="add">+' + g.added + '</span> <span class="del">−' + g.deleted + "</span>" : t("notGit")),
      card(t("memory"), memLabel(m.memory.status), m.memory.daysSince !== null ? t("daysSince") + ": " + m.memory.daysSince : t("noReview")),
    ];
    var stages = d.stages.map(function (s) {
      var note = stageNote(s);
      return '<div class="stage ' + scls(s.status) + '"><span class="dot"></span><span class="nm">' + esc(stageName(s)) +
        (note ? ' <span class="stage-note">' + note + "</span>" : "") + '</span><span class="tm">' + stime(s) + "</span></div>";
    }).join("");
    var waves = d.waves.filter(function (w) { return w.stages.length; }).map(function (w) {
      var rows = w.stages.map(function (s) {
        var i = d.stages.findIndex(function (x) { return x.id === s.id; });
        var c = scls(s.status);
        return '<div class="task"><span class="idx">' + String(i + 1).padStart(2, "0") + '</span><span class="b ' + c + '">' + esc(stageName(s)) + '</span><span class="t">' + wtime(s) + "</span></div>";
      }).join("");
      var agents = w.agents.length ? '<div class="wave-agents">' + w.agents.map(function (a) { return '<span class="chip">' + esc(a.role) + "</span>"; }).join(" ") + "</div>" : "";
      return '<div class="wave-title">' + t("wave") + " " + w.wave + "</div>" + rows + agents;
    }).join("");

    document.getElementById("tab-overview").innerHTML =
      '<div class="title-row"><h1>' + esc(d.task.title) + "</h1>" +
      '<span class="tag ' + (d.task.status === "open" ? "on" : "") + '">' + badge(d.task.status) + "</span>" +
      '<span class="tag">4-Wave SDD</span><span class="tag warn">' + esc(d.task.tier) + "</span></div>" +
      '<div class="card" style="margin-bottom:14px"><div class="hero"><div><div class="label">' + t("progress") + "</div>" +
      '<div class="note">' + p.stagesDone + "/" + p.stagesRequired + " " + t("stagesDone") + " · " + p.artifactsDone + "/" + p.artifactsTotal + " " + t("artifactsOf") +
      (p.stagesSkipped ? " · " + p.stagesSkipped + " " + t("notRequired") + " " + esc(d.task.tier) : "") + "</div></div>" +
      '<div class="pct" id="pct">' + p.percent + "%</div></div>" +
      '<div class="bar"><i id="pbar" style="width:' + p.percent + '%"></i></div></div>' +
      sess + '<div class="grid4">' + cards.join("") + "</div>" +
      '<div class="two"><div class="card"><div class="label">' + t("stages") + "</div>" + stages + "</div>" +
      '<div class="card"><div class="label">' + t("build") + "</div>" + waves + "</div></div>";
  }

  /* ===================== architecture: 3 modes ===================== */
  var ARCH_MODE = localStorage.getItem("nf-arch-mode") || "tree";
  var archFilter = "";
  var selectedNode = null;
  var zoom = 1;
  var collapsed = null;

  function archNodes() { return (DATA.archGraph && DATA.archGraph.nodes) || []; }
  function archEdges() { return (DATA.archGraph && DATA.archGraph.edges) || []; }
  function nodeById(id) { return archNodes().filter(function (n) { return n.id === id; })[0] || null; }
  function matchesFilter(id) { return !archFilter || id.toLowerCase().indexOf(archFilter.toLowerCase()) >= 0; }

  function renderArch() {
    var host = document.getElementById("tab-arch");
    var modes = [["tree", t("viewTree")], ["graph", t("viewGraph")], ["table", t("viewTable")]];
    host.innerHTML =
      '<div class="map-tools">' +
      modes.map(function (m) {
        // Без inline-onclick: кавычки внутри шаблона ломали клиентский скрипт.
        return '<button class="mode-btn' + (ARCH_MODE === m[0] ? " on" : "") + '" data-mode="' + m[0] + '">' + m[1] + "</button>";
      }).join("") +
      '<input id="arch-filter" class="inp" placeholder="' + t("filter") + '" value="' + esc(archFilter) + '">' +
      (ARCH_MODE === "tree" ? '<button class="exp-btn" data-collapse="1">' + t("collapseAll") + '</button><button class="exp-btn" data-collapse="0">' + t("expandAll") + "</button>" : "") +
      (ARCH_MODE === "graph" ? '<span class="chip">' + t("zoom") + ': <b id="zoom-val">' + Math.round(zoom * 100) + '%</b></span><button class="zoom-reset">' + t("reset") + "</button>" : "") +
      '<span class="chip">' + t("files") + " <b>" + num(DATA.arch.files) + "</b> · " + t("lines") + " <b>" + num(DATA.arch.lines) + "</b></span>" +
      "</div>" +
      '<div class="arch-body"><div class="map-wrap" id="arch-canvas"></div><aside class="panel" id="arch-panel"></aside></div>';

    host.querySelectorAll(".mode-btn").forEach(function (b) {
      b.addEventListener("click", function () { setArchMode(b.getAttribute("data-mode")); });
    });
    host.querySelectorAll(".exp-btn").forEach(function (b) {
      b.addEventListener("click", function () { mapExpandAll(b.getAttribute("data-collapse") === "1"); });
    });
    var zr = host.querySelector(".zoom-reset");
    if (zr) zr.addEventListener("click", function () { setZoom(1); });
    var inp = document.getElementById("arch-filter");
    if (inp) inp.addEventListener("input", function () { archFilter = inp.value; drawArch(); });

    if (ARCH_MODE === "tree") drawTree();
    else if (ARCH_MODE === "graph") drawGraph();
    else drawTable();
    renderPanel();
  }
  function setArchMode(m) { ARCH_MODE = m; localStorage.setItem("nf-arch-mode", m); renderArch(); }
  function setZoom(z) { zoom = Math.max(0.4, Math.min(2.5, z)); var el = document.getElementById("zoom-val"); if (el) el.textContent = Math.round(zoom * 100) + "%"; drawGraph(); }
  function drawArch() { if (TAB === "arch") renderArch(); }

  /* --- режим 1: схема (дерево) --- */
  function visibleTree(node) {
    if (!collapsed) {
      collapsed = {};
      (DATA.arch.children || []).forEach(function (c) { collapsed[c.name] = true; });
    }
    if (collapsed[node.name]) return { name: node.name, kind: node.kind, lines: node.lines, files: node.files, children: [] };
    return { name: node.name, kind: node.kind, lines: node.lines, files: node.files, children: (node.children || []).map(visibleTree) };
  }
  function treeLayout(node) {
    var rowH = 26, xGap = 230, cursor = 0, nodes = [], links = [];
    (function walk(n, depth, parent) {
      var kids = n.children || [];
      var y = cursor * rowH;
      if (kids.length === 0) { cursor += 1; y = (cursor - 1) * rowH; }
      var me = { x: depth * xGap, y: y, node: n, depth: depth };
      nodes.push(me);
      if (parent) links.push([parent, me]);
      if (kids.length) {
        var first = null, last = null;
        kids.forEach(function (k) { var c = walk(k, depth + 1, me); if (!first) first = c; last = c; });
        me.y = (first.y + last.y) / 2;
      }
      return me;
    })(node, 0, null);
    return { nodes: nodes, links: links, height: Math.max(1, cursor) * rowH + 30 };
  }
  function drawTree() {
    var canvas = document.getElementById("arch-canvas");
    var tree = visibleTree(DATA.arch);
    var lay = treeLayout(tree);
    var longest = 0;
    lay.nodes.forEach(function (n) { if (String(n.node.name).length > longest) longest = String(n.node.name).length; });
    var boxW = Math.min(300, Math.max(140, longest * 7.2 + 30)), boxH = 22;
    var maxX = 0;
    lay.nodes.forEach(function (n) { if (n.x > maxX) maxX = n.x; });
    var W = (maxX + boxW + 40) * zoom, H = lay.height * zoom;

    var links = lay.links.map(function (p) {
      var a = p[0], b = p[1];
      var x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2, mx = (x1 + x2) / 2;
      return '<path class="link" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2 + '"></path>';
    }).join("");

    var nodes = lay.nodes.map(function (n) {
      var nd = n.node, kids = (nd.children || []).length;
      var dim = !matchesFilter(nd.name) ? " dim" : "";
      var cls = "node " + (nd.kind || "other") + (collapsed[nd.name] ? " collapsed" : "") + dim + (selectedNode === nd.name ? " sel" : "");
      var meta = nd.kind === "file" ? num(nd.lines) + " " + t("lines") : num(nd.files) + " " + t("files") + " · " + num(nd.lines) + " " + t("lines");
      return '<g class="' + cls + '" transform="translate(' + n.x + "," + n.y + ')" data-name="' + esc(nd.name) + '">' +
        '<rect width="' + boxW + '" height="' + boxH + '" rx="7"></rect>' +
        '<text x="10" y="15">' + esc(nd.name) + (kids ? (collapsed[nd.name] ? " ▸" : " ▾") : "") + "</text>" +
        '<title>' + esc(nd.name) + " — " + esc(meta) + "</title></g>";
    }).join("");

    canvas.innerHTML = '<svg class="map" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W / zoom + " " + H / zoom + '">' + links + nodes + "</svg>";
    canvas.querySelectorAll("g.node").forEach(function (g) {
      g.addEventListener("click", function () {
        var nm = g.getAttribute("data-name");
        if (selectedNode === nm) { collapsed[nm] = !collapsed[nm]; } else { selectedNode = nm; }
        renderArch();
      });
    });
  }
  function mapExpandAll(collapse) {
    collapsed = {};
    if (collapse) (DATA.arch.children || []).forEach(function (c) { collapsed[c.name] = true; });
    renderArch();
  }

  /* --- режим 2: граф зависимостей --- */
  function drawGraph() {
    var canvas = document.getElementById("arch-canvas");
    var nodes = archNodes().filter(function (n) { return matchesFilter(n.id); });
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var edges = archEdges().filter(function (e) { return ids[e.from] && ids[e.to]; });

    // Слои: BFS от узла с максимумом исходящих связей (обычно «tools»).
    var roots = nodes.slice().sort(function (a, b) { return b.outWeight - a.outWeight; });
    var level = {};
    var queue = [];
    if (roots[0]) { level[roots[0].id] = 0; queue.push(roots[0].id); }
    while (queue.length) {
      var cur = queue.shift();
      edges.filter(function (e) { return e.from === cur; }).forEach(function (e) {
        if (level[e.to] === undefined) { level[e.to] = (level[cur] || 0) + 1; queue.push(e.to); }
      });
    }
    var maxLevel = 0;
    nodes.forEach(function (n) { if (level[n.id] === undefined) level[n.id] = 0; if (level[n.id] > maxLevel) maxLevel = level[n.id]; });

    var byLevel = {};
    nodes.forEach(function (n) { (byLevel[level[n.id]] = byLevel[level[n.id]] || []).push(n); });
    var colW = 250, rowH = 84, boxW = 180, boxH = 40, pad = 30;
    var maxRows = Math.max.apply(null, Object.keys(byLevel).map(function (k) { return byLevel[k].length; }).concat([1]));
    var W = (maxLevel + 1) * colW + pad * 2, H = maxRows * rowH + pad * 2;
    var pos = {};
    Object.keys(byLevel).forEach(function (lv) {
      byLevel[lv].forEach(function (n, i) {
        pos[n.id] = { x: pad + Number(lv) * colW, y: pad + i * rowH + (H - byLevel[lv].length * rowH) / 2 };
      });
    });

    var maxWeight = Math.max.apply(null, edges.map(function (e) { return e.weight; }).concat([1]));
    var links = edges.map(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return "";
      var x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2;
      var mx = (x1 + x2) / 2;
      var w = 1 + 3 * (e.weight / maxWeight);
      var hot = selectedNode && (e.from === selectedNode || e.to === selectedNode);
      return '<path class="edge' + (hot ? " hot" : "") + '" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2 + '" stroke-width="' + w.toFixed(1) + '"></path>' +
        '<text class="edge-w" x="' + mx + '" y="' + ((y1 + y2) / 2 - 4) + '">' + e.weight + "</text>";
    }).join("");

    var boxes = nodes.map(function (n) {
      var p = pos[n.id];
      var dim = !matchesFilter(n.id) ? " dim" : "";
      return '<g class="gnode ' + esc(n.id.split("/")[0]) + dim + (selectedNode === n.id ? " sel" : "") + '" transform="translate(' + p.x + "," + p.y + ')" data-name="' + esc(n.id) + '">' +
        '<rect width="' + boxW + '" height="' + boxH + '" rx="8"></rect>' +
        '<text x="12" y="17">' + esc(n.id) + "</text>" +
        '<text class="meta" x="12" y="31">' + num(n.files) + " " + t("files") + " · " + num(n.lines) + " " + t("lines") + "</text>" +
        '<title>' + esc(n.id) + "</title></g>";
    }).join("");

    canvas.innerHTML = '<svg class="map graph" width="' + W * zoom + '" height="' + H * zoom + '" viewBox="0 0 ' + W + " " + H + '">' + links + boxes + "</svg>";
    canvas.querySelectorAll("g.gnode").forEach(function (g) {
      g.addEventListener("click", function () { selectedNode = g.getAttribute("data-name"); renderArch(); });
    });
  }

  /* --- режим 3: таблица --- */
  function drawTable() {
    var canvas = document.getElementById("arch-canvas");
    var rows = archNodes().filter(function (n) { return matchesFilter(n.id); }).sort(function (a, b) { return b.lines - a.lines; });
    var out = rows.map(function (n) {
      var ins = archEdges().filter(function (e) { return e.to === n.id; }).map(function (e) { return e.from; });
      var outs = archEdges().filter(function (e) { return e.from === n.id; }).map(function (e) { return e.to; });
      return '<div class="row' + (selectedNode === n.id ? " sel" : "") + '" data-name="' + esc(n.id) + '" style="cursor:pointer">' +
        '<span class="grow mono">' + esc(n.id) + "</span>" +
        '<span class="mono" style="color:var(--dim)">' + num(n.files) + " " + t("files") + " · " + num(n.lines) + " " + t("lines") + "</span>" +
        '<span class="chip">→ ' + (outs.length ? esc(outs.join(", ")) : t("noDeps")) + "</span>" +
        '<span class="chip">← ' + (ins.length ? esc(ins.join(", ")) : t("noDeps")) + "</span></div>";
    }).join("");
    canvas.innerHTML = '<div class="card" style="border:0;padding:4px 0">' + (out || '<div class="empty">' + t("empty") + "</div>") + "</div>";
    canvas.querySelectorAll(".row").forEach(function (r) {
      r.addEventListener("click", function () { selectedNode = r.getAttribute("data-name"); renderArch(); });
    });
  }

  /* --- панель деталей --- */
  function renderPanel() {
    var panel = document.getElementById("arch-panel");
    if (!selectedNode) { panel.innerHTML = '<div class="label">' + t("details") + '</div><div class="empty">' + t("selectNode") + "</div>"; return; }
    var n = nodeById(selectedNode);
    var fileNode = null;
    (function find(node) {
      if (!node || fileNode) return;
      if (node.name === selectedNode && node.kind === "file") fileNode = node;
      (node.children || []).forEach(find);
    })(DATA.arch);

    var ins = archEdges().filter(function (e) { return e.to === selectedNode; });
    var outs = archEdges().filter(function (e) { return e.from === selectedNode; });
    var body = "";
    if (fileNode) {
      body = '<div class="kv"><span>' + t("lines") + "</span><b>" + num(fileNode.lines) + "</b></div>" +
        '<div class="kv"><span>' + t("kindCode") + "</span><b>" + esc(fileNode.path || selectedNode) + "</b></div>";
    } else if (n) {
      body =
        '<div class="kv"><span>' + t("files") + "</span><b>" + num(n.files) + "</b></div>" +
        '<div class="kv"><span>' + t("lines") + "</span><b>" + num(n.lines) + "</b></div>" +
        '<div class="kv"><span>' + t("external") + "</span><b>" + num(n.external) + "</b></div>" +
        '<div class="label" style="margin-top:12px">' + t("outgoing") + "</div>" +
        (outs.length ? outs.map(function (e) { return '<div class="kv"><span class="mono">' + esc(e.to) + '</span><b>' + e.weight + ' <span class="note">' + e.kinds.map(function (k) { return t("dep" + k.charAt(0).toUpperCase() + k.slice(1)); }).join("/") + "</span></b></div>"; }).join("") : '<div class="empty">' + t("noDeps") + "</div>") +
        '<div class="label" style="margin-top:12px">' + t("incoming") + "</div>" +
        (ins.length ? ins.map(function (e) { return '<div class="kv"><span class="mono">' + esc(e.from) + "</span><b>" + e.weight + "</b></div>"; }).join("") : '<div class="empty">' + t("noDeps") + "</div>") +
        (n.topFiles.length ? '<div class="label" style="margin-top:12px">' + t("topFiles") + "</div>" + n.topFiles.map(function (f) { return '<div class="kv"><span class="mono" style="font-size:11px">' + esc(f) + "</span></div>"; }).join("") : "");
    }
    panel.innerHTML = '<div class="label">' + t("details") + "</div>" + body;
  }

  /* -------------------------------- logs ------------------------------ */
  function renderLogs(d) {
    var ev = (d.events || []).map(function (e) {
      return '<div class="ln"><span class="ts">' + esc(fmtTime(e.at)) + '</span><span class="k">' + esc(e.kind || "event") +
        '</span><span class="tx">' + esc(e.text || "") + "</span></div>";
    }).join("");
    var sess = (d.log.entries || []).map(function (e) {
      var isErr = e.kind === "error";
      return '<div class="ln"><span class="ts">' + esc(fmtTime(e.at)) + '</span><span class="k ' + esc(e.kind) + '">' + esc(e.label) +
        '</span><span class="tx' + (isErr ? " err" : "") + '">' + esc(e.text) + "</span></div>";
    }).join("");

    document.getElementById("tab-logs").innerHTML =
      '<div class="two"><div class="card"><div class="label">События воркфлоу (.workflow/events.jsonl)</div><div class="log">' +
      (ev || '<div class="empty">Событий пока нет — они появятся после start/artifact/close</div>') + "</div></div>" +
      '<div class="card"><div class="label">Сессия агента · ' + esc(d.log.file || "транскрипт не найден") + '</div><div class="log">' +
      (sess || '<div class="empty">Транскрипт сессии не найден</div>') + "</div></div></div>";
  }

  /* ------------------------------- diffs ------------------------------ */
  function renderDiffs(d) {
    var g = d.git;
    var body = !g.isRepo ? '<div class="empty">Не git-репозиторий</div>'
      : !g.files.length ? '<div class="empty">Рабочее дерево чистое</div>'
      : g.files.map(function (f) {
          return '<div class="row" data-file="' + esc(f.path) + '" style="cursor:pointer"><span class="mono grow">' + esc(f.path) + "</span>" +
            '<span class="mono"><span class="add">+' + f.added + '</span> <span class="del">−' + f.deleted + "</span></span>" +
            '<span class="pill ' + (f.status === "untracked" ? "warn" : "") + '">' + esc(f.status) + "</span></div>";
        }).join("");
    document.getElementById("tab-diffs").innerHTML = '<div class="card"><div class="label">Диффы (git) — клик по файлу откроет diff</div>' + body +
      (g.isRepo ? '<div class="note" style="margin-top:10px">Ветка <span class="mono">' + esc(g.branch) + '</span> · коммит <span class="mono">' + esc(g.commit && g.commit.hash) + "</span> " + esc(g.commit && g.commit.when) + "</div>" : "") + "</div>";
    document.querySelectorAll("#tab-diffs .row").forEach(function (r) {
      r.addEventListener("click", function () { openDiff(r.getAttribute("data-file")); });
    });
  }

  /* ------------------------------ critique ---------------------------- */
  function renderCritique(d) {
    var rows = !d.critique.length ? '<div class="empty">Вердиктов оракула пока нет</div>'
      : d.critique.map(function (c) {
          var cls = c.verdict === "accept" ? "ok" : c.verdict === "reject" ? "bad" : "warn";
          var lbl = c.verdict === "accept" ? "ПРИНЯТО" : c.verdict === "reject" ? "ОТКЛОНЕНО" : c.verdict === "mixed" ? "С ЗАМЕЧАНИЯМИ" : "НЕТ ВЕРДИКТА";
          return '<div class="row"><span class="grow"><b>' + esc(c.change) + '</b> <span class="mono" style="color:var(--dim)">' + esc(c.file) + "</span></span>" +
            '<span class="pill ' + cls + '">' + lbl + '</span><span class="note">замечаний: ' + c.concerns + "</span></div>";
        }).join("");
    var ar = d.metrics.checks && d.metrics.checks.autoReview;
    var line = ar ? '<div class="note" style="margin-top:10px">auto-review: ' + (ar.error ? esc(ar.error) : (ar.ok ? "пройдено, проблем " + (ar.total || 0) : "провалено, проблем " + (ar.total || 0))) + "</div>"
      : '<div class="note" style="margin-top:10px">Автопроверки не запускались — <span class="mono">dashboard.mjs --checks</span></div>';
    document.getElementById("tab-critique").innerHTML = '<div class="card"><div class="label">Критика и ревью</div>' + rows + line + "</div>";
  }

  /* -------------------------------- debt ------------------------------ */
  function renderDebt(d) {
    var items = d.metrics.debt.items || [];
    var rows = !items.length ? '<div class="empty">Осознанного техдолга нет — реестр чист</div>'
      : items.map(function (x) {
          return '<div class="row"><span class="mono" style="color:var(--dim)">' + esc(x.file) + (x.line ? ":" + x.line : "") + '</span><span class="grow">' + esc(x.what) + "</span>" +
            '<span class="note">потолок: ' + esc(x.ceiling || "—") + (x.upgrade ? " · апгрейд: " + esc(x.upgrade) : "") + "</span></div>";
        }).join("");
    document.getElementById("tab-debt").innerHTML = '<div class="card"><div class="label">Технический долг (' + d.metrics.debt.total + ")</div>" + rows + "</div>";
  }

  /* ------------------------------ history ----------------------------- */
  function renderHistory(d) {
    var tiers = Object.keys(d.history.byTier).map(function (k) { return '<span class="chip">' + esc(k) + ": " + d.history.byTier[k] + "</span>"; }).join(" ");
    var rows = d.history.recent.length ? d.history.recent.map(function (h) {
      return '<div class="row"><span class="pill">' + esc(h.tier) + '</span><span class="grow">' + esc(h.task) + '</span><span class="mono" style="color:var(--dim)">' + fmtDur(h.durationMs) + (h.forced ? " · force" : "") + "</span></div>";
    }).join("") : '<div class="empty">История пуста</div>';
    document.getElementById("tab-history").innerHTML =
      '<div class="card"><div class="label">История работы</div>' +
      '<div class="note" style="margin-bottom:8px">Закрыто задач: <b>' + d.history.total + "</b> · медиана: <b>" + (d.history.medianMs ? fmtDur(d.history.medianMs) : "—") + "</b> · " + tiers + "</div>" +
      rows + "</div>" +
      '<div class="card" style="margin-top:14px"><div class="label">Как это работает</div>' +
      '<div class="note" style="line-height:1.9">' +
      "<b>Ярусы:</b> T0 — 1–2 файла · T1 — 3+ файла и рекогносцировка · T2 — полный 4-Wave SDD со слепой приёмкой · T3 — программа из T2-срезов<br>" +
      "<b>Коридор:</b> гейт артефактов → TDD → test-lens → мутационное тестирование → BDD Gherkin → слепая приёмка Оракула<br>" +
      "<b>Наблюдаемость:</b> дашборд привязан к сессии, обновляется каждые 3 с, показывает события воркфлоу и хвост транскрипта агента</div></div>";
  }

  /* ------------------------------- shell ------------------------------ */
  function renderHeader(d) {
    document.getElementById("h-project").textContent = d.project.name;
    var s = d.session;
    var chip = s.key;
    if (s.usage) {
      var st = s.usage.status === "running" ? "● running" : "○ " + (s.usage.status || "idle");
      var cost = s.usage.costUsd !== null ? " · $" + s.usage.costUsd : "";
      chip = s.key + " · " + st + cost;
    }
    document.getElementById("h-session").textContent = chip;
    var mchip = document.getElementById("h-model");
    if (mchip) mchip.textContent = s.usage && s.usage.model ? s.usage.model : "—";
    document.getElementById("h-branch").textContent = d.project.branch || "—";
  }
  function applyLabels() {
    document.getElementById("live-text").textContent = document.getElementById("live").classList.contains("on") ? t("live") : t("snapshot");
    renderRail(DATA);
  }
  function render(d) {
    DATA = d;
    renderHeader(d);
    renderOverview(d);
    renderLogs(d);
    renderDiffs(d);
    renderCritique(d);
    renderDebt(d);
    renderHistory(d);
    if (TAB === "arch") drawArch();   // v3: рендер архитектуры (схема/граф/таблица)
    applyLabels();
  }
  function setLang(l) {
    lang = l;
    localStorage.setItem("nf-lang", l);
    document.getElementById("l-ru").classList.toggle("active", l === "ru");
    document.getElementById("l-en").classList.toggle("active", l === "en");
    applyLabels();
  }
  function setTheme(mode) {
    localStorage.setItem("nf-theme", mode);
    document.body.classList.toggle("light", mode === "light");
  }
  if (localStorage.getItem("nf-theme") === "light") document.body.classList.add("light");

  var startMs = DATA.task.startedAt ? new Date(DATA.task.startedAt).getTime() : Date.now();
  setInterval(function () {
    if (DATA.task.status === "closed") return;
    var el = document.getElementById("elapsed");
    if (el) el.textContent = fmtDur(Math.max(0, Date.now() - startMs));
  }, 1000);

  function setLive(on) {
    var b = document.getElementById("live");
    b.classList.toggle("on", on);
    document.getElementById("live-text").textContent = on ? t("live") : t("snapshot");
  }
  function fp(d) {
    return JSON.stringify({ p: d.progress, s: d.stages.map(function (x) { return x.id + x.status; }), g: d.git.files.length + ":" + d.git.added, l: d.log.entries.length, e: (d.events || []).length, c: d.critique.length });
  }
  function flashChanged(d) {
    var f = fp(d);
    if (fingerprint !== null && f !== fingerprint) {
      ["tab-overview", "tab-logs", "tab-diffs"].forEach(function (id) {
        var el = document.getElementById(id);
        el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      });
    }
    fingerprint = f;
  }
  function refreshNow() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (fresh) { render(fresh); flashChanged(fresh); setLive(true); })
      .catch(function () { setLive(false); });
  }
  function openDiff(file) {
    var modal = document.getElementById("modal");
    document.getElementById("modal-title").textContent = file;
    document.getElementById("modal-body").textContent = "Загрузка…";
    modal.classList.add("open");
    fetch("/api/diff?file=" + encodeURIComponent(file))
      .then(function (r) { return r.text(); })
      .then(function (text) {
        document.getElementById("modal-body").innerHTML = text.split("\\n").map(function (l) {
          var c = l.startsWith("+") && !l.startsWith("+++") ? "d-add" : l.startsWith("-") && !l.startsWith("---") ? "d-del" : l.startsWith("@@") ? "d-hunk" : "";
          var e = esc(l);
          return c ? '<span class="' + c + '">' + e + "</span>" : e;
        }).join("\\n");
      })
      .catch(function () { document.getElementById("modal-body").textContent = "Дифф доступен только в живом режиме"; });
  }
  function closeModal() { document.getElementById("modal").classList.remove("open"); }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  function boot() {
    try {
      render(DATA);
      fingerprint = fp(DATA);
      showTab(TAB);
    } catch (e) {
      // Никогда не оставляем пустой экран без объяснения.
      var b = document.createElement("div");
      b.style.cssText = "position:fixed;bottom:12px;left:12px;right:12px;z-index:99;background:#2d1214;border:1px solid #ff5f56;color:#ffb3ae;font-family:var(--mono);font-size:12px;padding:10px 14px;border-radius:10px";
      b.textContent = "dashboard render error: " + (e && e.message ? e.message : e);
      document.body.appendChild(b);
      try { console.error("dashboard render error", e); } catch (_) {}
    }
  }
  boot();
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
let SERVER_SESSION = null;

export const RUNTIME_FILE = ".workflow/dashboard.json"; // обратная совместимость (последняя сессия)

/** Рантайм-файл конкретной сессии: .workflow/dashboards/<key>.json */
export function runtimePath(root, key = null) {
  const absRoot = resolve(root);
  if (!key) return join(absRoot, RUNTIME_FILE);
  return join(absRoot, DASHBOARDS_DIR, key + ".json");
}

/** Все известные дашборды проекта: [{key, port, url, pid}] — для --list. */
export function listDashboards(root) {
  const dir = join(resolve(root), DASHBOARDS_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".usage.json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        out.push({ key: f.replace(/\.json$/, ""), port: j.port, url: j.url, pid: j.pid, startedAt: j.startedAt });
      } catch {}
    }
  } catch {}
  return out;
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
  const absRoot = resolve(root);
  const key = info && info.key ? info.key : null;
  const p = runtimePath(absRoot, key);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(info, null, 2);
  writeFileSync(p, text, "utf8");
  // Дублируем «последний» рантайм: старые вызовы и скрипты ждут .workflow/dashboard.json
  if (key) writeFileSync(runtimePath(absRoot), text, "utf8");
  return p;
}

/** Живой ли дашборд на порту (быстрый health-пинг). */
export async function isServerAlive(port, timeoutMs = 900) {
  return (await probeDashboard(port, timeoutMs)) !== null;
}

/**
 * Опрос дашборда на порту: `{pid, root}` или null.
 * Нужен, чтобы отличить «наш» дашборд от чужого процесса, занявшего порт.
 */
export async function probeDashboard(port, timeoutMs = 900) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.ok ? info : null;
  } catch {
    return null;
  }
}

/**
 * Мы внутри рабочего пространства Paseo? Тогда браузер по умолчанию — не цель:
 * приоритет у браузера среды разработки, а его открывает агент (browser_new_tab).
 * Маркеры ставит сам Paseo для запущенных им процессов.
 */
export function isPaseoWorkspace() {
  return Boolean(process.env.PASEO_AGENT_ID || process.env.PASEO_HOME || process.env.PASEO_CLI);
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
    res.end(JSON.stringify(collectDashboardData(absRoot, { session: SERVER_SESSION })));
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
  res.end(generateDashboardHtml(collectDashboardData(absRoot, { session: SERVER_SESSION })));
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
export async function ensureDashboard(root, { open = true, port = null, session = null } = {}) {
  const absRoot = resolve(root);
  const key = sessionKey(session);
  const chosenPort = port || portForSession(key);
  // В Paseo системный браузер не открываем: страницу показывает браузер IDE,
  // и открывает её агент. Иначе получаем два окна и потерянный фокус.
  const openSystem = open && !isPaseoWorkspace();

  // 1. Рантайм-файл: быстрый путь.
  const existing = readRuntime(absRoot, key);
  if (existing) {
    const probed = await probeDashboard(existing.port);
    if (probed) {
      const url = `http://localhost:${existing.port}`;
      if (openSystem) openInBrowser(url);
      return { url, port: existing.port, started: false };
    }
  }

  // 2. Рантайм-файл потерян, а дашборд проекта жив (осиротевший демон):
  //    усыновляем его вместо запуска второго сервера на соседнем порту.
  for (let p = chosenPort; p < chosenPort + 12; p++) {
    const probed = await probeDashboard(p, 400);
    if (probed && resolve(probed.root || "") === absRoot) {
      writeRuntime(absRoot, { key,
        pid: probed.pid,
        port: p,
        url: `http://localhost:${p}`,
        root: absRoot,
        startedAt: new Date().toISOString(),
        adopted: true,
      });
      const url = `http://localhost:${p}`;
      if (openSystem) openInBrowser(url);
      return { url, port: p, started: false, adopted: true };
    }
  }

  const selfPath = fileURLToPath(import.meta.url);
  // cwd НЕ ставим в корень проекта: на Windows это блокирует удаление каталога,
  // пока жив демон. Абсолютный --root делает cwd ненужным.
  const child = spawn(process.execPath, [selfPath, "--serve", "--no-open", "--root", absRoot, "--port", String(chosenPort), "--session", key], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readRuntime(absRoot, key);
    if (info && (await isServerAlive(info.port))) {
      const url = `http://localhost:${info.port}`;
      if (openSystem) openInBrowser(url);
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
    url: false,
    list: false,
    session: null,
    help: false,
    errors: [],
  };
  const KNOWN = new Set(["root", "output", "open", "serve", "ensure", "no-open", "checks", "port", "json", "url", "list", "session", "help"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--ensure") options.ensure = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--checks") options.checks = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--url") options.url = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--session" || arg.startsWith("--session="))
      options.session = arg.startsWith("--session=") ? arg.slice("--session=".length) : argv[++i];
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
  --url             Напечатать адрес живого дашборда и выйти (для агентов)
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
  const key = sessionKey(opts.session || null);

  if (opts.checks) {
    const checks = runChecks(absRoot);
    process.stdout.write(`Проверки выполнены и закэшированы: ${join(absRoot, CHECKS_CACHE)}\n`);
    if (checks.autoReview?.error) process.stdout.write(`  auto-review: ${checks.autoReview.error}\n`);
  }

  // --list: какие дашборды уже подняты для проекта (по сессиям).
  if (opts.list) {
    const rows = listDashboards(absRoot);
    // Мёртвые записи (процесс упал, рантайм-файл остался) честно помечаем.
    for (const r of rows) r.alive = r.port ? await isServerAlive(r.port) : false;
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (!rows.length) {
      process.stdout.write("Дашбордов нет — запустите workflow.mjs start или dashboard.mjs --ensure\n");
    } else {
      for (const r of rows) {
        process.stdout.write(`${r.key.padEnd(22)} ${(r.alive ? r.url || "" : "— мёртв").padEnd(28)} pid ${r.pid} с ${r.startedAt || "?"}\n`);
      }
    }
    return 0;
  }

  // --url: только адрес живого дашборда (для агентов и скриптов).
  if (opts.url) {
    const info = await ensureDashboard(absRoot, { open: false, port: opts.port });
    if (info.url) {
      process.stdout.write(info.url + "\n");
      return 0;
    }
    process.stderr.write(`dashboard: ${info.error || "не удалось запустить"}\n`);
    return 1;
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
    SERVER_SESSION = key;
    const bound = await startLiveServer(absRoot, opts.port);
    const url = `http://localhost:${bound.port}`;
    writeRuntime(absRoot, { key,
      pid: process.pid,
      port: bound.port,
      url,
      root: absRoot,
      startedAt: new Date().toISOString(),
    });
    process.stdout.write(`Nullform Workflow dashboard: ${url}\n`);

    const cleanup = () => {
      try {
        const info = readRuntime(absRoot, key);
        if (info && info.pid === process.pid) {
          rmSync(runtimePath(absRoot, key), { force: true });
          const legacy = readRuntime(absRoot);
          if (legacy && legacy.pid === process.pid) rmSync(runtimePath(absRoot), { force: true });
        }
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
  // main() асинхронный: без .then() код возврата терялся и CLI всегда выходил с 0.
  Promise.resolve(main(process.argv.slice(2)))
    .then((code) => {
      if (typeof code === "number") process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`dashboard: ${err && err.message ? err.message : err}
`);
      process.exit(2);
    });
}
