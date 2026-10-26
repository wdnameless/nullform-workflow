#!/usr/bin/env node
/**
 * tools/dashboard.mjs — Nullform Workflow: сервер дашборда + CLI.
 *
 * Слои: dashboard-collectors.mjs (сбор), dashboard-ui.mjs (шаблон).
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

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "./brief.mjs";
import {
  projectToken, isAllowedHost, isCompatibleDashboard, buildWaves, calibrationHint,
  runChecks, collectDashboardData, validateSessionKey, sessionKey, portForSession,
  DASHBOARD_BUILD, DASHBOARD_PROTOCOL, DASHBOARD_PROTOCOL_VERSION, CHECKS_CACHE,
} from "./dashboard-collectors.mjs";
import { generateDashboardHtml } from "./dashboard-ui.mjs";
import { serveArchRoute, serveDiffRoute, sanitizeArchState, runLifecycleCommand, runtimePath, readRuntime, writeRuntime } from "./dashboard-routes.mjs";
export {
  DASHBOARD_BUILD, DASHBOARD_PROTOCOL, DASHBOARD_PROTOCOL_VERSION,
  REQUIRED_ARTIFACTS_BY_TIER, calibrationHint, collectCritique, collectDashboardData,
  collectGitStats, collectHistory, collectRequirements, collectRunState, collectWaves,
  computeGates, isAllowedHost, isCompatibleDashboard, parseManifestRequirements,
  projectToken, scanModules,
} from "./dashboard-collectors.mjs";
export { collectArchDrill, collectSymbolInventory, isBinaryName } from "./arch-drill.mjs";
export { sanitizeArchDrill, sanitizeArchState, serveArchRoute, serveDiffRoute, stopDashboardServer, killProjectOrphans, isOwnServerCommand, readProcessCmdline, STOP_DELAY_S, stopLater, runLifecycleCommand, runtimePath, readRuntime, writeRuntime, RUNTIME_FILE } from "./dashboard-routes.mjs";
export { generateDashboardHtml, esc } from "./dashboard-ui.mjs";
export { buildSketch, toExcalidraw, layoutSketch, sketchBoxPath, sketchEdgePath, seedOf } from "./dashboard-sketch.mjs";

/* ------------------------------------------------------------------ */
/*  Server, runtime file, auto-launch                                  */
/* ------------------------------------------------------------------ */
let SERVER_SESSION = null;

/** Живой ли дашборд на порту (быстрый health-пинг). */
export async function isServerAlive(port, timeoutMs = 900, absRoot = null, session = null) {
  const probed = await probeDashboard(port, timeoutMs);
  if (!probed) return false;
  if (absRoot) return isCompatibleDashboard(probed, absRoot, session);
  return probed.ok === true;
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

/** Период в секундах, который страница получает на то, чтобы дочитать финальное
 * состояние, прежде чем сервер погаснет. Ровно как в autopilot: их поллинг —
 * 10 с; наш — 2 с, поэтому 12 с с запасом покрывают 6 опросов. */
/** Мы внутри рабочего пространства Paseo? */
export function isPaseoWorkspace() {
  return Boolean(process.env.PASEO_AGENT_ID || process.env.PASEO_HOME || process.env.PASEO_CLI);
}

/** Открыть URL в браузере по умолчанию (вне Paseo IDE). */
export function openInBrowser(url) {
  // Внутри Paseo никогда не запускаем внешний браузер ОС: дашборд открывается только в IDE browser (browser_new_tab).
  if (isPaseoWorkspace() && process.env.NF_FORCE_SYSTEM_BROWSER !== "1") return;
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

/** Попытка занять порт; null — порт занят. */
function tryListen(port, absRoot, session = null, options = {}) {
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => handleRequest(req, res, absRoot, session, options));
    server.once("error", () => resolvePort(null));
    server.once("listening", () => resolvePort({ server, port }));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * R05: Санитизация состояния для HTTP-ответов (/api/state, /, dashboard.html).
 * Исключает чувствительные свободные данные (сообщения, аргументы вызовов,
 * текст задач, произвольные детали оракула, патчи, пути файлов), сохраняя
 * структурные ключи, статусы, тайминги и счётчики для рендера.
 */
/** Три поля «глазами человека» одним вызовом: сборщик от них не растёт. */
function sanitizeHumanGap(metrics) {
  return {
    checksAge: sanitizeChecksAge(metrics?.checksAge),
    needed: sanitizeNeeded(metrics?.needed),
    blind: sanitizeBlind(metrics?.blind),
  };
}

/** Возраст автопроверок: дни и признак устаревания. */
function sanitizeChecksAge(raw) {
  if (!raw) return null;
  return { days: raw.days === null ? null : Math.max(0, Number(raw.days) || 0), stale: Boolean(raw.stale) };
}

/** «Понадобится от тебя»: только имена и координаты, значения не проходят. */
function sanitizeNeeded(raw) {
  if (!raw) return null;
  const list = (arr, n, map) => (Array.isArray(arr) ? arr.slice(0, n).map(map) : []);
  return {
    envKeys: list(raw.envKeys, 40, (k) => String(k).replace(/[^A-Z0-9_]/g, "").slice(0, 60)),
    placeholders: list(raw.placeholders, 40, (p) => ({
      file: String(p?.file || "").replace(/[^a-zA-Z0-9._/-]/g, "").slice(0, 120),
      line: Math.max(0, Number(p?.line) || 0),
      text: redactSecrets(String(p?.text || "")).slice(0, 120),
    })),
    assumptions: list(raw.assumptions, 20, (a) => String(a).slice(0, 180)),
  };
}

/** Слепая приёмка: два числа и расхождения. */
function sanitizeBlind(raw) {
  if (!raw) return null;
  return {
    checked: Math.max(0, Number(raw.checked) || 0),
    matched: Math.max(0, Number(raw.matched) || 0),
    disagreements: (Array.isArray(raw.disagreements) ? raw.disagreements : []).slice(0, 12).map((d) => String(d).slice(0, 180)),
    source: raw.source ? String(raw.source).replace(/[^a-zA-Z0-9._/-]/g, "").slice(0, 120) : null,
  };
}

/**
 * Строки критики: коллектор отдаёт `{ verdicts, checks, checksAge }`, а не массив.
 * До этого `.map` у объекта не существовал, и в браузер уходил пустой список —
 * карточка критики была недостижима.
 */
function critiqueRows(raw) {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.verdicts) ? raw.verdicts : [];
}

export function sanitizeHttpState(data) {
  if (!data) return data;

  const ALLOWED_TIERS = new Set(["T0", "T1", "T2", "T3"]);
  const tier = ALLOWED_TIERS.has(data.task?.tier) ? data.task.tier : "T1";

  const ALLOWED_TASK_STATUSES = new Set(["idle", "open", "in_progress", "closed"]);
  const taskStatus = ALLOWED_TASK_STATUSES.has(data.task?.status) ? data.task.status : "open";

  const ALLOWED_KINDS = new Set(["start", "artifact", "check", "close", "tool", "error", "result", "assistant", "user", "notice", "event"]);
  const ALLOWED_STAGES = new Set(["lane", "recon", "spec", "manifest", "interfaces", "tasks", "verification", "oracle", "closed"]);
  const ALLOWED_STATUSES = new Set([
    "started", "closed", "check", "recorded", "ok", "error", "pending", "in_progress", "done", "skipped", "missed", "ready", "active", "idle", "message", "start",
    ...ALLOWED_STAGES,
  ]);

  const STAGE_NAMES = {
    lane: "Ярус и постановка",
    recon: "Разведка и контекст",
    spec: "Спецификация OpenSpec",
    manifest: "Манифест изменений",
    interfaces: "Интерфейсы и TDD",
    tasks: "Параллельные подзадачи",
    verification: "Сводная верификация",
    oracle: "Оракул и аудит",
    closed: "Задача закрыта",
  };

  const STAGE_WAVES = {
    lane: 0,
    recon: 1,
    spec: 2,
    manifest: 2,
    interfaces: 3,
    tasks: 3,
    verification: 4,
    oracle: 4,
    closed: 4,
  };

  const stages = (data.stages || []).map((s) => {
    const id = ALLOWED_STAGES.has(s?.id) ? s.id : "lane";
    const st = ALLOWED_STATUSES.has(s?.status) ? s.status : "pending";
    const note = s?.note === "skipped" || s?.note === "missed" ? s.note : "";
    return {
      id,
      name: STAGE_NAMES[id] || "Этап",
      wave: STAGE_WAVES[id] ?? 0,
      status: st,
      detail: "",
      note,
      tier: s?.tier ? (ALLOWED_TIERS.has(s.tier) ? s.tier : tier) : undefined,
      durationMs: typeof s?.durationMs === "number" ? Math.max(0, s.durationMs) : undefined,
    };
  });

  const curId = ALLOWED_STAGES.has(data.currentStage?.id) ? data.currentStage.id : "lane";
  const currentStage = {
    id: curId,
    name: STAGE_NAMES[curId] || "—",
    wave: STAGE_WAVES[curId] ?? 0,
    detail: "",
  };

  const fleet = [
    { role: "@orchestrator", name: "Оркестратор", wave: 0, status: taskStatus === "closed" ? "idle" : "active" },
    { role: "@explorer", name: "Разведчик AST", wave: 1, status: "ready" },
    { role: "@librarian", name: "Библиотекарь", wave: 1, status: "ready" },
    { role: "@designer", name: "Дизайнер UI/UX", wave: 3, status: "ready" },
    { role: "@fixer", name: "Fixer (TDD)", wave: 3, status: "ready" },
    { role: "@oracle", name: "Оракул (приёмка)", wave: 4, status: "ready" },
  ];

  const waves = buildWaves(stages, fleet);

  const gitFiles = (data.git?.files || []).map((f) => ({
    path: String(f?.path || "").replace(/\\/g, "/"),
    added: Number(f?.added) || 0,
    deleted: Number(f?.deleted) || 0,
    status: f?.status === "untracked" ? "untracked" : "modified",
  }));

  const commitHash = typeof data.git?.commit?.hash === "string" ? data.git.commit.hash.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) : "";

  const git = {
    isRepo: Boolean(data.git?.isRepo),
    branch: String(data.git?.branch || "main"),
    commit: { hash: commitHash, when: "" },
    files: gitFiles,
    added: Number(data.git?.added) || 0,
    deleted: Number(data.git?.deleted) || 0,
    staged: Number(data.git?.staged) || 0,
    unstaged: Number(data.git?.unstaged) || 0,
    untracked: Number(data.git?.untracked) || 0,
  };

  const ALLOWED_REQ_STATUSES = new Set(["done", "in-spec", "implemented", "dropped", "pending", "open", "closed", "todo"]);
  const reqItems = (data.metrics?.requirements?.items || []).map((r) => ({
    id: typeof r?.id === "string" && /^R\d+[a-z]?$/i.test(r.id) ? r.id : "R00",
    status: ALLOWED_REQ_STATUSES.has(r?.status) ? r.status : "in-spec",
  }));

  const reqByStatus = {};
  for (const [k, v] of Object.entries(data.metrics?.requirements?.byStatus || {})) {
    if (ALLOWED_REQ_STATUSES.has(k)) {
      reqByStatus[k] = Number(v) || 0;
    }
  }

  const debtItems = (data.metrics?.debt?.items || []).map((_, i) => ({
    file: `marker #${i + 1}`,
    line: 0,
    what: "debt marker",
    ceiling: "",
    upgrade: "",
  }));

  const memStatus = data.metrics?.memory?.status === "fresh" || data.metrics?.memory?.status === "overdue"
    ? data.metrics.memory.status
    : "fresh";

  const metrics = {
    briefCoverage: Number(data.metrics?.briefCoverage) || 0,
    requirements: {
      total: Number(data.metrics?.requirements?.total) || reqItems.length,
      byStatus: reqByStatus,
      items: reqItems,
      change: String(data.metrics?.requirements?.change || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50),
    },
    debt: {
      total: Number(data.metrics?.debt?.total) || 0,
      noTrigger: Number(data.metrics?.debt?.noTrigger) || 0,
      items: debtItems,
    },
    memory: {
      status: memStatus,
      daysSince: typeof data.metrics?.memory?.daysSince === "number" ? data.metrics.memory.daysSince : null,
    },
    checks: null,
  };
  Object.assign(metrics, sanitizeHumanGap(data.metrics));

  // Коллектор отдаёт объект `{ verdicts, checks, checksAge }`, а не массив: до этой
  // правки `.map` у объекта не существовал, и в браузер уходил пустой список —
  // карточка критики и возраст кэша проверок были недостижимы.
  const critique = critiqueRows(data.critique).map((c) => {
    const verdict = c?.verdict === "accept" || c?.verdict === "reject" || c?.verdict === "mixed" ? c.verdict : "unknown";
    return {
      change: String(c?.change || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50),
      file: "oracle.md",
      verdict,
      concerns: Number(c?.concerns) || 0,
      blockers: Number(c?.blockers) || 0,
      size: Number(c?.size) || 0,
    };
  });

  const recentHistory = (data.history?.recent || []).map((h) => ({
    tier: ALLOWED_TIERS.has(h?.tier) ? h.tier : "T1",
    task: `Задача ${ALLOWED_TIERS.has(h?.tier) ? h.tier : "T1"}`,
    durationMs: Number(h?.durationMs) || 0,
    forced: Boolean(h?.forced),
  }));

  const byTier = {};
  for (const [k, v] of Object.entries(data.history?.byTier || {})) {
    if (ALLOWED_TIERS.has(k)) byTier[k] = Number(v) || 0;
  }

  const history = {
    total: Number(data.history?.total) || 0,
    medianMs: Number(data.history?.medianMs) || 0,
    byTier,
    recent: recentHistory,
  };

  const events = (data.events || []).map((e) => {
    const rawKind = String(e?.kind || "").toLowerCase();
    const kind = ALLOWED_KINDS.has(rawKind) ? rawKind : "event";
    const rawStatus = String(e?.status || "").toLowerCase();
    const st = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : "ok";
    return {
      at: e?.at || null,
      kind,
      status: st,
    };
  });

  const ALLOWED_TOOLS = new Set(["read", "edit", "write", "bash", "glob", "grep", "lsp", "ast_grep", "hub", "yield", "fast_edit", "fastcompact", "tool"]);
  const ALLOWED_ROLES = new Set(["assistant", "user", "notice", "result", "error"]);
  const ALLOWED_LOG_KINDS = new Set(["tool", "error", "result", "assistant", "user", "notice"]);
  const ALLOWED_LOG_STATUSES = new Set(["start", "ok", "error", "message", "notice"]);

  const logEntries = (data.log?.entries || []).map((e) => {
    const rawKind = String(e?.kind || "").toLowerCase();
    const kind = ALLOWED_LOG_KINDS.has(rawKind) ? rawKind : "tool";
    const rawLabel = String(e?.label || "").toLowerCase();
    const label = ALLOWED_TOOLS.has(rawLabel) || ALLOWED_ROLES.has(rawLabel) ? rawLabel : (kind === "result" ? "result" : "tool");
    const rawStatus = String(e?.status || "").toLowerCase();
    const status = ALLOWED_LOG_STATUSES.has(rawStatus) ? rawStatus : (kind === "error" ? "error" : "ok");
    return {
      at: e?.timestamp || e?.at || null,
      kind,
      label,
      status,
    };
  });

  const ALLOWED_USAGE_STATUSES = new Set(["active", "idle", "busy", "running", "stopped", "done", "error"]);
  const u = data.session?.usage;
  const usage = u ? {
    at: Number(u.at) || Date.now(),
    stale: Boolean(u.stale),
    name: null,
    provider: String(u.provider || "provider").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30),
    model: String(u.model || "model").split("/").pop()?.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "model",
    status: ALLOWED_USAGE_STATUSES.has(String(u.status).toLowerCase()) ? String(u.status).toLowerCase() : "active",
    cwd: null,
    createdAt: null,
    updatedAt: null,
    inputTokens: Number(u.inputTokens) || 0,
    outputTokens: Number(u.outputTokens) || 0,
    cachedTokens: Number(u.cachedTokens) || 0,
    costUsd: typeof u.costUsd === "number" ? u.costUsd : null,
  } : null;

  const session = {
    key: "local",
    name: "session",
    paseoAgentId: null,
    transcript: null,
    usage,
  };

  const modules = (data.modules || []).map((m) => ({
    name: String(m?.name || ""),
    path: String(m?.path || ""),
    fileCount: Number(m?.fileCount) || 0,
    totalLines: Number(m?.totalLines) || 0,
    files: (m?.files || []).map((f) => ({
      name: String(f?.name || ""),
      lines: Number(f?.lines) || 0,
    })),
  }));

  const { arch, archDrill, archGraph } = sanitizeArchState(data);

  let run = null;
  if (data.run && typeof data.run === "object") {
    const ALLOWED_RUN_STATUSES = new Set(["open", "waiting", "closed", "failed", "working"]);
    const runStatus = ALLOWED_RUN_STATUSES.has(data.run.status) ? data.run.status : (data.run.open ? "open" : "closed");
    run = {
      open: Boolean(data.run.open),
      status: runStatus,
      tier: ALLOWED_TIERS.has(data.run.tier) ? data.run.tier : "T1",
      task: `Задача ${ALLOWED_TIERS.has(data.run.tier) ? data.run.tier : "T1"}`,
      change: data.run.change ? String(data.run.change).replace(/[^a-zA-Z0-9_-]/g, "") : null,
      startedAt: data.run.startedAt || null,
      closedAt: data.run.closedAt || null,
      stages: (data.run.stages || []).map((s) => ({
        id: String(s?.id || ""),
        status: ["done", "in_progress", "pending", "missed", "skipped"].includes(s?.status) ? s.status : "pending",
        durationMs: Number(s?.durationMs) || 0,
      })),
      requirements: (data.run.requirements || []).map((r) => ({
        id: String(r?.id || ""),
        text: redactSecrets(String(r?.text || "")).replace(/[A-Za-z0-9_-]*SECRET[A-Za-z0-9_-]*/gi, "[REDACTED]").slice(0, 200),
        status: ["done", "open", "deferred", "dropped"].includes(r?.status) ? r.status : "open",
      })),
      waves: (data.run.waves || []).map((w) => ({
        n: Number(w?.n) || 1,
        tickets: (w?.tickets || []).map((t) => ({
          id: String(t?.id || ""),
          title: String(t?.title || t?.id || ""),
          status: String(t?.status || "pending"),
          lines: Number(t?.lines) || 0,
          ...(t?.zone ? { zone: t.zone } : {}),
          ...(t?.requirements ? { requirements: t.requirements } : {}),
        })),
      })),
      calibration: data.run.calibration ? {
        targetLines: Number(data.run.calibration.targetLines) || 3000,
        linesPerTicket: Number(data.run.calibration.linesPerTicket) || 3000,
        minLines: Number(data.run.calibration.minLines) || 1500,
        maxLines: Number(data.run.calibration.maxLines) || 4500,
        totalLines: Number(data.run.calibration.totalLines) || 0,
        totalTickets: Number(data.run.calibration.totalTickets) || 0,
        avgLinesPerTicket: Number(data.run.calibration.avgLinesPerTicket) || 0,
        hint: String(data.run.calibration.hint || calibrationHint(data.run.calibration.avgLinesPerTicket || 0)),
      } : {
        targetLines: 3000,
        linesPerTicket: 3000,
        minLines: 1500,
        maxLines: 4500,
        totalLines: 0,
        totalTickets: 0,
        avgLinesPerTicket: 0,
        hint: "ok",
      },
      gates: {
        G1: { ok: data.run.gates?.G1?.ok ?? null, label: String(data.run.gates?.G1?.label || "Manifest recorded"), status: data.run.gates?.G1?.status || "open" },
        G2: { ok: data.run.gates?.G2?.ok ?? null, label: String(data.run.gates?.G2?.label || "OpenSpec valid"), status: data.run.gates?.G2?.status || "open" },
        G3: { ok: data.run.gates?.G3?.ok ?? null, label: String(data.run.gates?.G3?.label || "Interfaces recorded"), status: data.run.gates?.G3?.status || "open" },
        G4: { ok: data.run.gates?.G4?.ok ?? null, label: String(data.run.gates?.G4?.label || "Oracle ACCEPT"), status: data.run.gates?.G4?.status || "open" },
      },
      waits: (data.run.waits || []).map((w) => ({
        kind: String(w?.kind || "wait"),
        from: String(w?.from || ""),
        to: String(w?.to || ""),
        durationMs: Number(w?.durationMs) || 0,
      })),
      beats: (data.run.beats || []).map((b) => String(b)),
      activeMs: Math.max(0, Number(data.run.activeMs) || 0),
      waitMs: Math.max(0, Number(data.run.waitMs) || 0),
      feed: (data.run.feed || []).map((f) => ({
        t: String(f?.t || ""),
        kind: String(f?.kind || "event"),
        text: redactSecrets(String(f?.text || "")).replace(/[A-Za-z0-9_-]*SECRET[A-Za-z0-9_-]*/gi, "[REDACTED]").slice(0, 200),
      })),
      rev: String(data.run.rev || ""),
      pendingQuestion: data.run.pendingQuestion ? redactSecrets(String(data.run.pendingQuestion)).slice(0, 300) : (data.run.question ? redactSecrets(String(data.run.question)).slice(0, 300) : ""),
    };
  }

  return {
    timestamp: data.timestamp || new Date().toISOString(),
    root: "",
    session,
    events,
    log: { file: data.log?.file ? "активна" : null, entries: logEntries },
    arch,
    archDrill,
    archGraph,
    project: {
      name: String(data.project?.name || "project"),
      branch: String(data.project?.branch || data.git?.branch || "main"),
      commit: { hash: commitHash, when: "" },
    },
    task: {
      title: `Задача ${tier}`,
      tier,
      status: taskStatus,
      startedAt: data.task?.startedAt || null,
      elapsedMs: Number(data.task?.elapsedMs) || 0,
      budget: Number(data.task?.budget) || 25,
    },
    progress: {
      percent: Number(data.progress?.percent) || 0,
      stagesDone: Number(data.progress?.stagesDone) || 0,
      stagesRequired: Number(data.progress?.stagesRequired) || 0,
      stagesSkipped: Number(data.progress?.stagesSkipped) || 0,
      artifactsDone: Number(data.progress?.artifactsDone) || 0,
      artifactsTotal: Number(data.progress?.artifactsTotal) || 0,
    },
    stages,
    currentStage,
    timing: {
      elapsedMs: Number(data.timing?.elapsedMs) || 0,
      remainingMin: data.timing?.remainingMin ?? null,
      remainingMax: data.timing?.remainingMax ?? null,
      medianTaskMs: Number(data.timing?.medianTaskMs) || 0,
    },
    metrics,
    waves,
    git,
    modules,
    critique,
    history,
    fleet,
    run,
  };
}

/** HTTP-обработчик: страница, /api/state, /api/diff, /api/health. */
function handleRequest(req, res, absRoot, session = null, options = {}) {
  const host = req.headers.host;
  if (!isAllowedHost(host)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden: invalid Host");
    return;
  }

  const currentSession = sessionKey(session || SERVER_SESSION);
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      project: projectToken(absRoot),
      protocol: DASHBOARD_PROTOCOL,
      protocolVersion: DASHBOARD_PROTOCOL_VERSION,
      build: DASHBOARD_BUILD,
      session: currentSession,
    }));
    return;
  }

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    const raw = collectDashboardData(absRoot, { session: currentSession });
    res.end(JSON.stringify(sanitizeHttpState(raw)));
    return;
  }

  if (url.pathname === "/api/diff" && serveDiffRoute({ res, absRoot, file: url.searchParams.get("file") || "" })) {
    return;
  }

  if (url.pathname === "/api/arch.sketch" || url.pathname === "/api/arch.excalidraw") {
    serveArchRoute({
      res,
      pathname: url.pathname,
      searchParams: url.searchParams,
      absRoot,
      collectState: () => collectDashboardData(absRoot, { session: currentSession }),
      projectToken,
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  const raw = collectDashboardData(absRoot, { session: currentSession });
  res.end(generateDashboardHtml(sanitizeHttpState(raw), options));
}

/** Запустить сервер дашборда на первом свободном порту. */
export async function startLiveServer(root, port = 4200, { maxAttempts = 64, session = null, pollMs = 2000 } = {}) {
  const absRoot = resolve(root);
  const activeSession = sessionKey(session || SERVER_SESSION);
  for (let p = port; p < port + maxAttempts; p++) {
    const bound = await tryListen(p, absRoot, activeSession, { pollMs });
    if (bound) return bound;
  }
  throw new Error(`нет свободного порта в диапазоне ${port}..${port + maxAttempts - 1}`);
}

/**
 * Автозапуск дашборда: если живой сервер уже есть — используем его,
 * иначе поднимаем фоновый процесс и (опционально) открываем браузер.
 * Никогда не бросает: дашборд — наблюдаемость, а не условие работы.
 */
const ensureDashboardInFlight = new Map();

export async function ensureDashboard(root, { open = true, port = null, session = null } = {}) {
  const absRoot = resolve(root);
  const key = sessionKey(session);
  const flightKey = `${absRoot}::${key}`;

  if (ensureDashboardInFlight.has(flightKey)) {
    return ensureDashboardInFlight.get(flightKey);
  }

  const promise = (async () => {
    try {
      return await _ensureDashboardImpl(absRoot, key, { open, port });
    } finally {
      ensureDashboardInFlight.delete(flightKey);
    }
  })();

  ensureDashboardInFlight.set(flightKey, promise);
  return promise;
}

async function _ensureDashboardImpl(absRoot, key, { open = true, port = null } = {}) {
  const chosenPort = port || portForSession(key);
  // В Paseo системный браузер не открываем: страницу показывает встроенный браузер IDE (browser_new_tab).
  const openSystem = Boolean(open) && !isPaseoWorkspace() && process.env.NF_NO_OPEN !== "1";
  // 1. Рантайм-файл: быстрый путь.
  const existing = readRuntime(absRoot, key);
  if (existing) {
    const probed = await probeDashboard(existing.port);
    if (isCompatibleDashboard(probed, absRoot, key)) {
      const url = `http://localhost:${existing.port}`;
      if (openSystem) openInBrowser(url);
      return { url, port: existing.port, started: false };
    }
  }

  // 2. Рантайм-файл потерян, а дашборд проекта жив (осиротевший демон):
  //    усыновляем его вместо запуска второго сервера на соседнем порту.
  for (let p = chosenPort; p < chosenPort + 64; p++) {
    const probed = await probeDashboard(p, 400);
    if (isCompatibleDashboard(probed, absRoot, key)) {
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
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readRuntime(absRoot, key);
    if (info && (!existing || info.pid !== existing.pid || info.port !== existing.port)) {
      const probed = await probeDashboard(info.port);
      if (isCompatibleDashboard(probed, absRoot, key)) {
        const url = `http://localhost:${info.port}`;
        if (openSystem) openInBrowser(url);
        return { url, port: info.port, started: true };
      }
    }
  }
  return { url: null, port: null, started: false, error: "сервер не поднялся за 5 с" };
}


/**
 * R12: Встраивание снимка состояния между маркерами /*STATE-BEGIN* / и /*STATE-END* /
 * для автономного просмотра через file:// (pure function, no file IO).
 * Экранирует </ как <\/.
 */
export function embedSnapshot(html, state) {
  if (typeof html !== 'string') {
    throw new TypeError('html must be a string');
  }
  const jsonStr = JSON.stringify(state ?? {}).replace(/<\//g, '<\\/');
  const payload = `\nwindow.NF_SNAPSHOT = ${jsonStr};\nwindow.STATE = window.NF_SNAPSHOT;\n`;

  const markerRegex = /(\/\*STATE-BEGIN\*\/)[\s\S]*?(\/\*STATE-END\*\/)/;
  if (markerRegex.test(html)) {
    return html.replace(markerRegex, `$1${payload}$2`);
  }
  return `${html}\n<script>/*STATE-BEGIN*/${payload}/*STATE-END*/</script>`;
}

/**
 * R12: Проверка принадлежности процесса серверу Nullform Harness по сигнатуре аргументов.
 * Чистый предикат (no process killing in this slice).
 */
export function isOwnServer(procCmd, dir = null) {
  if (!procCmd) return false;
  const cmd = Array.isArray(procCmd) ? procCmd.join(' ') : String(procCmd);
  const cmdNorm = cmd.replace(/\\/g, '/').toLowerCase();

  const isHarness = (cmdNorm.includes('dashboard.mjs') || cmdNorm.includes('dashboard')) &&
    (cmdNorm.includes('--serve') || cmdNorm.includes('-serve'));

  if (!isHarness) return false;
  if (!dir) return true;

  const dirNorm = resolve(dir).replace(/\\/g, '/').toLowerCase();
  const dirRelNorm = String(dir).replace(/\\/g, '/').toLowerCase();
  return cmdNorm.includes(dirNorm) || cmdNorm.includes(dirRelNorm);
}

/**
 * R12: Обнаружение параллельных живых сессий (коллизий):
 * возвращает true, если state.json не завершён И serve.pid свежий (<5 мин).
 */
export function detectCollision(dir) {
  const dirAbs = resolve(dir);
  const stateCandidates = [
    join(dirAbs, "state.json"),
    join(dirAbs, ".workflow", "state.json"),
  ];
  let statePath = null;
  for (const c of stateCandidates) {
    if (existsSync(c)) {
      statePath = c;
      break;
    }
  }
  if (!statePath) return false;

  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return false;
  }
  if (!state || typeof state !== "object") return false;

  const isFinished = state.status === "closed" || state.status === "done" || Boolean(state.closedAt) || Boolean(state.finishedAt);
  if (isFinished) return false;

  const pidCandidates = [
    join(dirAbs, "serve.pid"),
    join(dirAbs, ".workflow", "serve.pid"),
  ];
  let pidPath = null;
  for (const c of pidCandidates) {
    if (existsSync(c)) {
      pidPath = c;
      break;
    }
  }
  if (!pidPath) return false;

  try {
    const stat = statSync(pidPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const FIVE_MIN_MS = 5 * 60 * 1000;
    if (ageMs < FIVE_MIN_MS && ageMs >= -60000) {
      return true;
    }

    const content = readFileSync(pidPath, "utf8").trim();
    try {
      const parsed = JSON.parse(content);
      const ts = parsed.timestamp || parsed.startedAt || parsed.time;
      if (ts) {
        const parsedAge = Date.now() - new Date(ts).getTime();
        if (parsedAge < FIVE_MIN_MS && parsedAge >= -60000) {
          return true;
        }
      }
    } catch {}
  } catch {
    return false;
  }

  return false;
}

/** Простой флаг без значения: установить options[key] и вернуть true. */
const FLAG_ARGS = new Set(["--open", "--serve", "--ensure", "--no-open", "--checks", "--json", "--url", "--up", "--stop", "--stop-now", "--freeze", "--list"]);
const FLAG_KEYS = { "--open": "open", "--serve": "serve", "--ensure": "ensure", "--no-open": "noOpen", "--checks": "checks", "--json": "json", "--url": "url", "--up": "up", "--stop": "stop", "--stop-now": "stopNow", "--freeze": "freeze", "--list": "list" };

/** Числовой параметр с диапазоном: положить значение или ошибку в options. */
function takeRangedNumber(argv, i, rawArg, min, max, apply, errText) {
  const eq = rawArg.includes("=");
  const raw = eq ? rawArg.slice(rawArg.indexOf("=") + 1) : argv[i[0] + 1];
  if (!eq) i[0]++;
  const p = Number.parseInt(raw, 10);
  if (!Number.isFinite(p) || p < min || p > max) apply.errors.push(errText(raw));
  else apply.set(p);
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
    freeze: false,
    pollMs: 2000,
    up: false,
    stop: false,
    stopNow: false,
    errors: [],
  };
  const KNOWN = new Set(["root", "output", "open", "serve", "ensure", "no-open", "checks", "port", "json", "url", "list", "session", "help", "freeze", "poll", "poll-ms", "up", "stop", "stop-now"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (FLAG_ARGS.has(arg)) options[FLAG_KEYS[arg]] = true;
    else if (arg === "--poll" || arg.startsWith("--poll=") || arg === "--poll-ms" || arg.startsWith("--poll-ms=")) {
      const idx = [i];
      takeRangedNumber(argv, idx, arg, 1000, 3000,
        { errors: options.errors, set: (v) => { options.pollMs = v; } },
        (raw) => `--poll требует интервал от 1000 до 3000 мс (получено: ${JSON.stringify(raw)})`);
      i = idx[0];
    }
    else if (arg === "--session" || arg.startsWith("--session=")) {
      const raw = arg.startsWith("--session=") ? arg.slice("--session=".length) : argv[++i];
      try {
        validateSessionKey(raw);
        options.session = raw;
      } catch (err) {
        options.errors.push(err.message);
      }
    }
    else if (arg === "--root" || arg.startsWith("--root="))
      options.root = arg.startsWith("--root=") ? arg.slice("--root=".length) : argv[++i];
    else if (arg === "--output" || arg.startsWith("--output="))
      options.output = arg.startsWith("--output=") ? arg.slice("--output=".length) : argv[++i];
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const idx = [i];
      takeRangedNumber(argv, idx, arg, 1, 65535,
        { errors: options.errors, set: (v) => { options.port = v; } },
        (raw) => `--port требует валидный номер порта (получено: ${JSON.stringify(raw)})`);
      i = idx[0];
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (!KNOWN.has(name)) options.errors.push(`неизвестный параметр: ${arg}`);
    }
  }

  return options;
}

/** Печать списка дашбордов проекта с честной пометкой мёртвых записей. */
async function printDashboardList(absRoot, opts) {
  const rows = listDashboards(absRoot);
  // Мёртвые записи (процесс упал, рантайм-файл остался) честно помечаем.
  for (const r of rows) r.alive = r.port ? await isServerAlive(r.port, 900, absRoot) : false;
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
  --up              Поднять дашборд одной командой (сервер + страница), убрав чужих сирот
  --stop            Остановить дашборд этой сессии (через 12 с, чтобы страница дочитала финал)
  --no-open         Не открывать браузер (для фонового демона)
  --url             Напечатать адрес живого дашборда и выйти (для агентов)
  --checks          Прогнать быстрые гейты (auto-review, prompt-lint) и закэшировать
  --port <n>        Порт сервера (по умолчанию: 4200)
  --poll <ms>       Интервал опроса 1000–3000 мс (по умолчанию: 2000)
  --json            Вывести агрегированные метрики в JSON
  --freeze          Создать автономный HTML со снапшотом (dashboard-frozen.html)
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
  if (opts.list) return await printDashboardList(absRoot, opts);

  // --url: только адрес живого дашборда (для агентов и скриптов).
  if (opts.url) {
    const info = await ensureDashboard(absRoot, { open: false, port: opts.port, session: opts.session });
    if (info.url) {
      process.stdout.write(info.url + "\n");
      return 0;
    }
    process.stderr.write(`dashboard: ${info.error || "не удалось запустить"}\n`);
    return 1;
  }

  // --ensure: автозапуск (идемпотентно) — поднять фоновый сервер и открыть страницу.
  if (opts.ensure) {
    const info = await ensureDashboard(absRoot, { open: !opts.noOpen, port: opts.port, session: opts.session });
    if (info.url) {
      process.stdout.write(`Дашборд: ${info.url}${info.started ? " (запущен)" : " (уже работал)"}\n`);
      return 0;
    }
    process.stderr.write(`dashboard: ${info.error || "не удалось запустить"}\n`);
    return 1;
  }

  const life = await runLifecycleCommand({ root: absRoot, opts, ensure: ensureDashboard });
  if (life !== null) return life;

  if (opts.freeze) {
    const data = collectDashboardData(absRoot, { session: opts.session });
    const sanitized = sanitizeHttpState(data);
    const outPath = opts.output ? resolve(opts.output) : join(absRoot, "dashboard-frozen.html");
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, generateDashboardHtml(sanitized, { frozen: true, pollMs: opts.pollMs }), "utf8");
    process.stdout.write(`Автономный дашборд сгенерирован: ${outPath}\n`);
    return 0;
  }

  const data = collectDashboardData(absRoot);

  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }

  const outPath = opts.output ? resolve(opts.output) : join(absRoot, ".workflow", "dashboard.html");
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(outPath, generateDashboardHtml(sanitizeHttpState(data), { pollMs: opts.pollMs }), "utf8");
  process.stdout.write(`Дашборд сгенерирован: ${outPath}\n`);

  if (opts.serve) {
    SERVER_SESSION = key;
    const bound = await startLiveServer(absRoot, opts.port, { session: key, pollMs: opts.pollMs });
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

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  // main() асинхронный: без .then() код возврата терялся и CLI всегда выходил с 0.
  Promise.resolve(main(process.argv.slice(2)))
    .then((code) => {
      // process.exit() discards stdout still queued on a pipe; on macOS that
      // truncates large --json output. Set the code and let Node flush.
      if (typeof code === "number") process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`dashboard: ${err && err.message ? err.message : err}
`);
      process.exitCode = 2;
    });
}
