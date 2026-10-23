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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "./brief.mjs";
import {
  projectToken, isAllowedHost, isCompatibleDashboard, buildWaves, calibrationHint,
  runChecks, collectDashboardData, validateSessionKey, sessionKey, portForSession, DASHBOARDS_DIR,
  DASHBOARD_BUILD, DASHBOARD_PROTOCOL, DASHBOARD_PROTOCOL_VERSION, CHECKS_CACHE,
} from "./dashboard-collectors.mjs";
import { generateDashboardHtml } from "./dashboard-ui.mjs";
export {
  DASHBOARD_BUILD, DASHBOARD_PROTOCOL, DASHBOARD_PROTOCOL_VERSION,
  REQUIRED_ARTIFACTS_BY_TIER, calibrationHint, collectCritique, collectDashboardData,
  collectGitStats, collectHistory, collectRequirements, collectRunState, collectWaves,
  computeGates, isAllowedHost, isCompatibleDashboard, parseManifestRequirements,
  projectToken, scanModules,
} from "./dashboard-collectors.mjs";
export { generateDashboardHtml } from "./dashboard-ui.mjs";

/* ------------------------------------------------------------------ */
/*  Server, runtime file, auto-launch                                  */
/* ------------------------------------------------------------------ */

/** Файл рантайма: порт и pid живого сервера дашборда. */
let SERVER_SESSION = null;

export const RUNTIME_FILE = ".workflow/dashboard.json"; // обратная совместимость (последняя сессия)

/** Рантайм-файл конкретной сессии: .workflow/dashboards/<key>.json */
export function runtimePath(root, key = null) {
  const absRoot = resolve(root);
  if (key === null || key === undefined) {
    const target = resolve(absRoot, RUNTIME_FILE);
    const rel = relative(absRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Целевой путь рантайма "${target}" выходит за пределы каталога проекта`);
    return target;
  }
  validateSessionKey(key);
  const dashboardsDir = resolve(absRoot, DASHBOARDS_DIR);
  const target = resolve(dashboardsDir, key + ".json");
  const rel = relative(dashboardsDir, target);
  if (rel.startsWith("..") || isAbsolute(rel) || dirname(target) !== dashboardsDir) {
    throw new Error(`Целевой путь рантайма "${target}" выходит за пределы каталога рантайма`);
  }
  return target;
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
export function readRuntime(root, key = null) {
  const p = runtimePath(root, key);
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
  const key = info && "key" in info && info.key !== null && info.key !== undefined ? info.key : null;
  const p = runtimePath(absRoot, key);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(info, null, 2);
  const writeAtomic = (target) => {
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  };
  writeAtomic(p);
  if (key) writeAtomic(runtimePath(absRoot));
  return p;
}

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
function tryListen(port, absRoot, session = null) {
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => handleRequest(req, res, absRoot, session));
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

  const critique = (data.critique || []).map((c) => {
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

  function cleanArchNode(node) {
    if (!node) return null;
    const isFile = node.kind === "file";
    const files = typeof node.files === "number" ? Math.max(0, node.files) : (Array.isArray(node.children) ? node.children.length : 0);
    return {
      name: String(node.name || ""),
      kind: isFile ? "file" : (node.kind === "root" ? "root" : (node.kind || "dir")),
      lines: Number(node.lines) || 0,
      files: isFile ? undefined : files,
      path: node.path ? String(node.path).replace(/\\/g, "/") : undefined,
      children: Array.isArray(node.children) ? node.children.map(cleanArchNode).filter(Boolean) : undefined,
    };
  }
  const arch = cleanArchNode(data.arch) || { name: "project", kind: "dir", lines: 0, files: 0, children: [] };

  const archGraph = {
    nodes: (data.archGraph?.nodes || []).map((n) => ({
      id: String(n.id || ""),
      files: Number(n.files) || 0,
      lines: Number(n.lines) || 0,
      external: Number(n.external) || 0,
      topFiles: Array.isArray(n.topFiles) ? n.topFiles.map((tf) => String(tf).replace(/\\/g, "/")) : [],
    })),
    edges: (data.archGraph?.edges || []).map((e) => ({
      from: String(e.from || ""),
      to: String(e.to || ""),
      weight: Number(e.weight) || 0,
      kinds: Array.isArray(e.kinds) ? e.kinds.map(String) : [],
    })),
  };
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
    };
  }

  return {
    timestamp: data.timestamp || new Date().toISOString(),
    root: "",
    session,
    events,
    log: { file: data.log?.file ? "активна" : null, entries: logEntries },
    arch,
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
function handleRequest(req, res, absRoot, session = null) {
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

  if (url.pathname === "/api/diff") {
    const file = url.searchParams.get("file") || "";
    const safe = file.replace(/\.\./g, "").replace(/^[/\\]+/, "");
    let added = 0;
    let deleted = 0;
    let found = false;

    if (safe) {
      const statRes = spawnSync("git", ["diff", "HEAD", "--numstat", "--", safe], {
        cwd: absRoot,
        encoding: "utf8",
        timeout: 15000,
        shell: false,
        windowsHide: true,
      });
      const statLines = (statRes.stdout || "").trim().split("\n").filter(Boolean);
      for (const line of statLines) {
        const parts = line.split("\t");
        if (parts.length >= 2) {
          found = true;
          added += parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
          deleted += parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
        }
      }
      if (!found) {
        const statusRes = spawnSync("git", ["status", "--porcelain", "--", safe], {
          cwd: absRoot,
          encoding: "utf8",
          timeout: 15000,
          shell: false,
          windowsHide: true,
        });
        const st = (statusRes.stdout || "").trim();
        if (st.startsWith("??")) {
          found = true;
          let fd = null;
          try {
            const full = realpathSync(join(absRoot, safe));
            const rel = relative(absRoot, full);
            if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("diff path escapes root");
            fd = openSync(full, "r");
            const buf = Buffer.alloc(65536);
            let n = 0, nl = 0;
            while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
              for (let i = 0; i < n; i++) if (buf[i] === 10) nl++;
            }
            added = nl + 1;
          } catch {
            added = 0;
          } finally {
            if (fd !== null) {
              try { closeSync(fd); } catch {}
            }
          }
        }
      }
    }

    let responseText = "";
    if (!found) {
      responseText = [
        "+ добавлено строк: 0",
        "- удалено строк: 0",
        "(Метаданные: изменений не обнаружено)",
      ].join("\n");
    } else {
      responseText = [
        `+ добавлено строк: ${added}`,
        `- удалено строк: ${deleted}`,
        `Сводка: ${added + deleted} изменённых строк`,
        "(Метаданные: исходный патч скрыт политикой безопасности R05)",
      ].join("\n");
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(responseText);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  const raw = collectDashboardData(absRoot, { session: currentSession });
  res.end(generateDashboardHtml(sanitizeHttpState(raw)));
}

/** Запустить сервер дашборда на первом свободном порту. */
export async function startLiveServer(root, port = 4200, { maxAttempts = 64, session = null } = {}) {
  const absRoot = resolve(root);
  const activeSession = sessionKey(session || SERVER_SESSION);
  for (let p = port; p < port + maxAttempts; p++) {
    const bound = await tryListen(p, absRoot, activeSession);
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
  const payload = `\nwindow.STATE = ${jsonStr};\n`;

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
    help: false,
    errors: [],
  };
  const KNOWN = new Set(["root", "output", "open", "serve", "ensure", "no-open", "checks", "port", "json", "url", "list", "session", "help", "freeze"]);

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
    else if (arg === "--freeze") options.freeze = true;
    else if (arg === "--list") options.list = true;
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
  if (opts.list) {
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

  if (opts.freeze) {
    const data = collectDashboardData(absRoot, { session: opts.session });
    const sanitized = sanitizeHttpState(data);
    const outPath = opts.output ? resolve(opts.output) : join(absRoot, "dashboard-frozen.html");
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, generateDashboardHtml(sanitized, { frozen: true }), "utf8");
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

  writeFileSync(outPath, generateDashboardHtml(sanitizeHttpState(data)), "utf8");
  process.stdout.write(`Дашборд сгенерирован: ${outPath}\n`);

  if (opts.serve) {
    SERVER_SESSION = key;
    const bound = await startLiveServer(absRoot, opts.port, { session: key });
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
