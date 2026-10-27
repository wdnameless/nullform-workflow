#!/usr/bin/env node
/**
 * tools/dashboard-routes.mjs — HTTP-часть карты архитектуры: санитизация дерева погружения
 * и отдача эскиза (JSON для рендера и .excalidraw для скачивания).
 *
 * Почему не в dashboard.mjs: маршрут — это единственное место, где состояние
 * превращается в файл для внешнего инструмента, и держать его рядом с общим
 * обработчиком значит раздувать функцию, которую читают при каждой правке API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSketch, toExcalidraw } from "./dashboard-sketch.mjs";
import { DASHBOARDS_DIR, sessionKey, validateSessionKey } from "./dashboard-collectors.mjs";

/**
 *
 * Строки только текстовые, числа ограничены, срезы ограничены: карта отдаётся в
 * браузер без пути к файлу и без содержимого — только имена, номера строк и счётчики.
 */
export function sanitizeArchDrill(raw) {
  const cleanFile = (f) => ({
    path: String(f?.path || "").replace(/\\/g, "/"),
    lines: Math.max(0, Number(f?.lines) || 0),
    truncated: Boolean(f?.truncated),
    symbols: (Array.isArray(f?.symbols) ? f.symbols : []).slice(0, 40).map((s) => ({
      name: String(s?.name || "anonymous").slice(0, 120),
      kind: "function",
      startLine: Math.max(0, Number(s?.startLine) || 0),
      endLine: Math.max(0, Number(s?.endLine) || 0),
      lines: Math.max(0, Number(s?.lines) || 0),
      internalCalls: Math.max(0, Number(s?.internalCalls) || 0),
    })),
  });
  const modules = (Array.isArray(raw?.modules) ? raw.modules : []).slice(0, 20).map((m) => ({
    name: String(m?.name || ""),
    files: Math.max(0, Number(m?.files) || 0),
    lines: Math.max(0, Number(m?.lines) || 0),
    truncated: Boolean(m?.truncated),
    children: (Array.isArray(m?.children) ? m.children : []).slice(0, 40).map(cleanFile),
  }));
  return {
    name: String(raw?.name || ""),
    files: Math.max(0, Number(raw?.files) || 0),
    lines: Math.max(0, Number(raw?.lines) || 0),
    modules,
  };
}

/**
 * Разрешить запрошенный уровень по состоянию, а не по строке запроса.
 *
 * `module` и `file` — идентификаторы из уже собранного дерева, поэтому подстановка
 * `..` или абсолютного пути просто не совпадёт ни с одним узлом и вернёт проект.
 */
function resolveLevel(drill, searchParams) {
  const moduleName = String(searchParams.get("module") || "").trim();
  const file = String(searchParams.get("file") || "").trim();
  const mod = drill.modules.find((m) => m.name === moduleName) || null;
  const safeFile = mod && file && mod.children.some((f) => f.path === file) ? file : null;
  return { module: mod ? mod.name : null, file: safeFile };
}

/** Имя файла для скачивания: только безопасные символы, всегда с расширением. */
function attachmentName(title) {
  return `${String(title || "architecture").replace(/[^a-zA-Z0-9._-]/g, "_")}.excalidraw`;
}

/**
 * Обработать /api/arch.sketch и /api/arch.excalidraw.
 *
 * Возвращает true, если запрос обслужен: вызывающий обработчик не должен после этого
 * писать ответ. Оба маршрута читают одно и то же состояние, поэтому считаются один раз.
 */
export function serveArchRoute({ res, pathname, searchParams, absRoot, collectState, projectToken }) {
  const raw = collectState();
  const drill = sanitizeArchDrill(raw.archDrill);
  const level = resolveLevel(drill, searchParams);
  const sketch = buildSketch(drill, raw.archGraph, level);

  if (pathname === "/api/arch.sketch") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(sketch));
    return true;
  }

  const title = `${drill.name || projectToken(absRoot)}-arch-${sketch.level}`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${attachmentName(title)}"`,
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(toExcalidraw(sketch, title), null, 2));
  return true;
}


/** Вид узла: файл, корень или каталог с исходного места. */
function nodeKindOf(node, isFile) {
  if (isFile) return "file";
  if (node.kind === "root") return "root";
  return node.kind || "dir";
}

/** Узел дерева «Схема»: та же форма, что и раньше, вынесена из общего обработчика. */
function cleanArchNode(node) {
  if (!node) return null;
  const isFile = node.kind === "file";
  const files = typeof node.files === "number"
    ? Math.max(0, node.files)
    : (Array.isArray(node.children) ? node.children.length : 0);
  return {
    name: String(node.name || ""),
    kind: nodeKindOf(node, isFile),
    lines: Number(node.lines) || 0,
    files: isFile ? undefined : files,
    path: node.path ? String(node.path).replace(/\\/g, "/") : undefined,
    children: Array.isArray(node.children) ? node.children.map(cleanArchNode).filter(Boolean) : undefined,
  };
}

/** Три представления архитектуры, которые уходят в браузер, одной функцией. */
export function sanitizeArchState(data) {
  const arch = cleanArchNode(data.arch) || { name: "project", kind: "dir", lines: 0, files: 0, children: [] };
  const archDrill = sanitizeArchDrill(data.archDrill);
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
  return { arch, archDrill, archGraph };
}

/**
 * Ответ на /api/diff: только метаданные (R05 — патч не отдаётся).
 *
 * Путь санитизируется здесь, а не в обработчике: маршрут отвечает за то, что он
 * читает, и `..` не должен зависеть от того, помнит ли о нём вызывающий.
 */
export function serveDiffRoute({ res, absRoot, file }) {
  const { added, deleted, found } = collectDiffMeta(absRoot, file);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(found
    ? [`+ добавлено строк: ${added}`, `- удалено строк: ${deleted}`, `Сводка: ${added + deleted} изменённых строк`, "(Метаданные: исходный патч скрыт политикой безопасности R05)"].join("\n")
    : ["+ добавлено строк: 0", "- удалено строк: 0", "(Метаданные: изменений не обнаружено)"].join("\n"));
  return true;
}

/** Счётчики изменений по файлу: `git diff --numstat`, иначе — размер нового файла. */
function collectDiffMeta(absRoot, file) {
  const safe = String(file || "").replace(/\.\./g, "").replace(/^[/\\]+/, "");
  const out = { added: 0, deleted: 0, found: false };
  if (!safe) return out;

  const statRes = spawnSync("git", ["diff", "HEAD", "--numstat", "--", safe], {
    cwd: absRoot, encoding: "utf8", timeout: 15000, shell: false, windowsHide: true,
  });
  for (const line of (statRes.stdout || "").trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    out.found = true;
    out.added += parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    out.deleted += parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
  }
  if (out.found) return out;

  const statusRes = spawnSync("git", ["status", "--porcelain", "--", safe], {
    cwd: absRoot, encoding: "utf8", timeout: 15000, shell: false, windowsHide: true,
  });
  if ((statusRes.stdout || "").trim().startsWith("??")) {
    out.found = true;
    out.added = countUntrackedLines(absRoot, safe);
  }
  return out;
}

/** Строки нового файла, прочитанного кусками: файл любого размера не грузится целиком. */
function countUntrackedLines(absRoot, safe) {
  let fd = null;
  try {
    const full = realpathSync(join(absRoot, safe));
    const rel = relative(absRoot, full);
    if (rel.startsWith("..") || isAbsolute(rel)) return 0;
    fd = openSync(full, "r");
    const buf = Buffer.alloc(65536);
    let n = 0;
    let nl = 0;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < n; i++) if (buf[i] === 10) nl++;
    }
    return nl + 1;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

/** Командная строка процесса по PID (Windows: CIM; POSIX: `ps`). Пустая строка при любой ошибке. */
export function readProcessCmdline(pid) {
  const id = Number(pid);
  if (!Number.isFinite(id)) return "";
  if (process.platform === "win32") {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${id}').CommandLine`], { encoding: "utf8", timeout: 8000, windowsHide: true });
      return String(out || "").trim();
    } catch {}
    return "";
  }
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(id)], { encoding: "utf8", timeout: 8000 });
    return String(out || "").trim();
  } catch {}
  return "";
}

/** Удалить рантайм-файл сессии и устаревший корневой, если он наш. */
export function removeRuntime(absRoot, key) {
  try { rmSync(runtimePath(absRoot, key), { force: true }); } catch {}
}

export const STOP_DELAY_S = 12;

/**
 * Сигнатуру процесса проверяем по командной строке, а не по порту или имени файла:
 * порт повторно занимается, а полная строка `node <abs>\tools\dashboard.mjs --serve --root <dir>`
 * принадлежит только нашему демону этого проекта.
 */
export function isOwnServerCommand(cmdline, { toolPath = null, root = null, sessionKey = null } = {}) {
  if (!cmdline || typeof cmdline !== "string") return false;
  const norm = cmdline.replace(/\\/g, "/").toLowerCase();
  // Идентичность — по хвосту пути инструмента, а не по абсолютному пути: процесс может
  // быть запущен относительным путём (`tools/dashboard.mjs` из корня), и тогда полного
  // пути в командной строке нет. Достаточно `tools/dashboard.mjs --serve` + корневой
  // каталог проекта из `--root`, который всегда абсолютный.
  const tail = (toolPath || "tools/dashboard.mjs").replace(/\\/g, "/").toLowerCase();
  const hasTool = norm.includes(tail) && norm.includes("--serve");
  const roots = [root, (() => { try { return resolve(root); } catch { return ""; } })()].map((r) => String(r || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean);
  const hasRoot = root ? roots.some((r) => norm.includes(r)) : true;
  const hasSession = sessionKey ? norm.includes(`--session ${sessionKey}`.toLowerCase()) || norm.includes(`--session=${sessionKey}`.toLowerCase()) : true;
  return hasTool && hasRoot && hasSession;
}

/**
 * Остановить свой демон этого проекта и сессии: читаем рантайм-файл, проверяем
 * команду процесса по PID, только потом SIGTERM. Чужой процесс с занявшим порт
 * номером PID — не наша цель.
 *
 * Возвращает "stopped:<pid>" | "already-stopped" | "stale-removed" | "refused:<why>".
 */
export function stopDashboardServer(root, { session = null } = {}) {
  const absRoot = resolve(root);
  const key = sessionKey(session);
  const info = readRuntime(absRoot, key);
  if (!info || typeof info.pid !== "number") return "already-stopped: no runtime file";
  const cmdline = readProcessCmdline(info.pid);
  if (!cmdline) {
    removeRuntime(absRoot, key);
    return "stale-removed: pid gone, runtime file deleted";
  }
  if (!isOwnServerCommand(cmdline, { root: absRoot })) {
    return "refused: pid is not our dashboard server";
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    return "already-stopped: kill failed (already dead)";
  }
  return `stopped:${info.pid}`;
}

/** Классифицировать одну рантайм-запись: мёртвая, чужая или сирота этого проекта. */
function classifyRuntimeEntry(absRoot, f) {
  let info = null;
  try { info = JSON.parse(readFileSync(join(absRoot, DASHBOARDS_DIR, f), "utf8")); } catch { return null; }
  if (!info || typeof info.pid !== "number") return null;
  const key = f.replace(/\.json$/, "");
  const cmdline = readProcessCmdline(info.pid);
  if (!cmdline) return { key, pid: info.pid, verdict: "pid dead" };
  if (!isOwnServerCommand(cmdline, { root: absRoot })) return { key, pid: info.pid, verdict: "not our server" };
  return { key, pid: info.pid, verdict: "orphan of this project" };
}

/** Убить сирот этого проекта: записи о демонах, процессы которых мертвы или чужие. */
export function killProjectOrphans(root, { dryRun = true } = {}) {
  const absRoot = resolve(root);
  const killed = [];
  const refused = [];
  let entries = [];
  try { entries = readdirSync(join(absRoot, DASHBOARDS_DIR)).filter((f) => f.endsWith(".json") && !f.endsWith(".usage.json")); } catch { return { killed, refused }; }
  for (const f of entries) {
    const entry = classifyRuntimeEntry(absRoot, f);
    if (!entry) continue;
    if (entry.verdict === "not our server") { refused.push({ key: entry.key, why: entry.verdict }); continue; }
    if (!dryRun) {
      if (entry.verdict === "orphan of this project") { try { process.kill(entry.pid, "SIGTERM"); } catch {} }
      removeRuntime(absRoot, entry.key);
    }
    killed.push({ key: entry.key, why: entry.verdict });
  }
  return { killed, refused };
}

/**
 * Точки --up/--stop/--stop-now одной функцией.
 *
 * Причина, а не вкус: прошлое размещение размазывало управление жизненным циклом
 * по main() в dashboard.mjs, и при очередном переносе один из вызовов повис на
 * несуществующей runLifecycleCommand — CLI падал до старта сервера.
 * Возвращает exit-код или null, если ни один флаг не задан.
 */
export async function runLifecycleCommand({ root: absRoot, opts, ensure }) {
  if (opts.up) {
    const sweep = killProjectOrphans(absRoot, { dryRun: false });
    for (const k of sweep.killed) process.stdout.write(`Убит сирота: ${k.key} (${k.why})\n`);
    const info = await ensure(absRoot, { open: !opts.noOpen, port: opts.port, session: opts.session });
    if (info.url) {
      const fresh = collectDashboardState(absRoot, { session: opts.session });
      writeSnapshot(absRoot, fresh);
      process.stdout.write(`Дашборд: ${info.url}${info.started ? " (запущен)" : " (уже работал)"}\n`);
      return 0;
    }
    process.stderr.write(`dashboard: ${info.error || "не удалось запустить"}\n`);
    return 1;
  }
  if (opts.stop) {
    stopLater(absRoot, opts.session);
    process.stdout.write(`Дашборд погаснет через ${STOP_DELAY_S} с\n`);
    return 0;
  }
  if (opts.stopNow) {
    await new Promise((r) => setTimeout(r, STOP_DELAY_S * 1000));
    process.stdout.write(stopDashboardServer(absRoot, { session: opts.session }) + "\n");
    return 0;
  }
  return null;
}

/** Файл рантайма: порт и pid живого сервера дашборда. */
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

export function stopLater(absRoot, session) {
  const selfPath = fileURLToPath(import.meta.url);
  const args = [selfPath, "--stop-now", "--root", absRoot];
  if (session) args.push("--session", String(session));
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * Состояние дашборда для снимка: то же самое, что отдаёт /api/state.
 * Нужна отдельная функция, потому что workflow.mjs дёргает её без HTTP.
 */
export function collectDashboardState(root, opts = {}) {
  return sanitizeHttpState(collectDashboardData(resolve(root), opts));
}

/**
 * Переписать .workflow/dashboard.html свежим состоянием, не трогая разметку.
 * Idempotent: если ничего не изменилось — файл не пишется, чтобы не шуметь mtime.
 */
export function writeSnapshot(root, state) {
  const absRoot = resolve(root);
  const pagePath = join(absRoot, ".workflow", "dashboard.html");
  let page = null;
  try {
    page = readFileSync(pagePath, "utf8");
  } catch {
    return false;
  }
  if (!page.includes("/*STATE-BEGIN*/")) return false;
  const next = embedSnapshot(page, state);
  if (next === page) return false;
  const tmp = `${pagePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, pagePath);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}
