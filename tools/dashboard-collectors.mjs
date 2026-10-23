#!/usr/bin/env node
/**
 * tools/dashboard-collectors.mjs — сбор данных дашборда (выделено из dashboard.mjs 1:1).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanRepo } from "./debt-ledger.mjs";
import { redactSecrets } from "./brief.mjs";
import { readJsonlSafe, resolveLogFile } from "./session-log.mjs";
export function projectToken(absPath) {
  return createHash("sha256").update(resolve(absPath)).digest("hex").slice(0, 16);
}
function computeDashboardBuild() {
  try {
    const code = readFileSync(fileURLToPath(import.meta.url));
    return createHash("sha256").update(code).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

export const DASHBOARD_PROTOCOL = "nullform-dashboard/v2";
export const DASHBOARD_PROTOCOL_VERSION = 2;
export const DASHBOARD_BUILD = computeDashboardBuild();
/**
 * R15: Проверка заголовка Host.
 * Разрешены только loopback-адреса (localhost, 127.0.0.1, [::1]) с опциональным портом.
 * Любые внешние/враждебные хосты (включая DNS rebinding вроде attacker.example) отклоняются.
 */
export function isAllowedHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return false;
  const raw = hostHeader.trim().toLowerCase();
  if (!raw) return false;

  // IPv6: [::1] или [::1]:port или [0:0:0:0:0:0:0:1]
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close === -1) return false;
    const ip = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest && !/^:\d+$/.test(rest)) return false;
    return ip === "::1" || ip === "0:0:0:0:0:0:0:1";
  }

  // IPv4 или имя хоста: localhost, 127.0.0.1 с опциональным :port
  const parts = raw.split(":");
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^\d+$/.test(parts[1])) return false;
  const host = parts[0];
  return host === "localhost" || host === "127.0.0.1";
}

/**
 * R01: Проверка совместимости здоровья дашборда на порту.
 * Сервер должен возвращать ok: true, правильный токен проекта, актуальный протокол и сборку.
 * Устаревшие серверы (формат {ok, pid, root}), серверы других проектов или старых сборок не переиспользуются.
 */
export function isCompatibleDashboard(info, absRoot, session = null) {
  if (!info || typeof info !== "object") return false;
  if (info.ok !== true) return false;
  if (!info.project || info.project !== projectToken(absRoot)) return false;
  if (info.protocol !== DASHBOARD_PROTOCOL) return false;
  if (info.protocolVersion !== DASHBOARD_PROTOCOL_VERSION) return false;
  if (info.build !== DASHBOARD_BUILD) return false;
  if (session !== null && session !== undefined && info.session !== session) return false;
  return true;
}
export const CHECKS_CACHE = ".workflow/dashboard-checks.json";
/**
 * Обязательные артефакты по ярусам (совпадает с гейтом tools/workflow.mjs).
 * Всё, что не требуется ярусом, дашборд показывает как «не требуется», а не «не начато».
 */
export const REQUIRED_ARTIFACTS_BY_TIER = {
  T0: ["lane"], T1: ["lane", "recon"],
  T2: ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"],
  T3: ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"],
};

/** Все стадии 4-Wave SDD с привязкой к волне и артефакту. */
const STAGE_DEFS = [
  { id: "lane", name: "Ярус и постановка", wave: 0 }, { id: "recon", name: "Разведка и контекст", wave: 1 },
  { id: "manifest", name: "Манифест требований (R##)", wave: 2 }, { id: "openspec", name: "Спецификация OpenSpec", wave: 2 },
  { id: "interfaces", name: "Интерфейсы и владельцы", wave: 3 }, { id: "oracle", name: "Слепая приёмка Оракула", wave: 4 },
  { id: "closed", name: "Закрытие и архив", wave: 4 },
];

export function buildWaves(stages, fleet) {
  return [0, 1, 2, 3, 4].map((w) => ({
    wave: w,
    title: `ВОЛНА ${w}`,
    stages: stages.filter((s) => s.wave === w),
    agents: fleet.filter((f) => f.wave === w),
  }));
}

/* ------------------------------------------------------------------ */
/*  Data collection                                                    */
/* ------------------------------------------------------------------ */

/** Расширения, которые не считаем исходником: шрифты, медиа, архивы, замки. */
const BINARY_EXT = /\.(ttf|otf|woff2?|eot|png|jpe?g|gif|webp|svgz?|ico|bmp|mp[34]|wav|ogg|pdf|zip|gz|tar|7z|rar|xz|exe|dll|so|dylib|bin|wasm|db|sqlite3?|lock)$/i;
const isBinaryName = (name) => BINARY_EXT.test(name);
/** TTL-кэш для тяжёлых сборщиков: ограничивает пересчёт, не мешая свежести. */
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
function flattenDebtMarkers(parsed) {
  const items = [];
  for (const [file, markers] of Object.entries(parsed?.byFile || {})) {
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
  return items;
}

export function collectDebt(absRoot) {
  const script = join(absRoot, "tools", "debt-ledger.mjs");
  if (!existsSync(script)) return { total: 0, noTrigger: 0, items: [], note: "debt-ledger.mjs не найден" };

  // 1. Быстрый вызов в том же процессе без запуска дочерних процессов (0 окон node.exe)
  try {
    const parsed = scanRepo(absRoot);
    return { total: parsed.total || 0, noTrigger: parsed.noTrigger || 0, items: flattenDebtMarkers(parsed).slice(0, 40) };
  } catch {
    // Резервный вызов через CLI с обязательным windowsHide: true
    try {
      const res = spawnSync(process.execPath, [script, "--json", "--root", absRoot], {
        cwd: absRoot,
        encoding: "utf8",
        timeout: 20000,
        shell: false,
        windowsHide: true,
      });
      if (res.status !== 0) {
        return { total: 0, noTrigger: 0, items: [], note: "debt-ledger завершился с ошибкой" };
      }
      const parsed = JSON.parse(res.stdout);
      return { total: parsed.total || 0, noTrigger: parsed.noTrigger || 0, items: flattenDebtMarkers(parsed).slice(0, 40) };
    } catch {
      return { total: 0, noTrigger: 0, items: [], note: "debt-ledger JSON не разобран" };
    }
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

/**
 * Парсинг R## строк манифеста (3- или 4-колоночные таблицы).
 * Возвращает массив [{ id, text, status }], где text verbatim до 200 символов,
 * а status выводится из coverage / закрытия / явного столбца.
 */
export function parseManifestRequirements(file, state = null) {
  if (!file) return [];
  let content = "";
  if (typeof file === "string") {
    if (file.includes("|") && file.includes("\n")) {
      content = file;
    } else if (existsSync(file)) {
      try {
        content = readFileSync(file, "utf8");
      } catch {
        return [];
      }
    } else {
      return [];
    }
  } else {
    return [];
  }

  const items = [];
  const lines = content.split("\n");
  const isClosed = state && (state.status === "closed" || Boolean(state.artifacts?.oracle));

  for (const line of lines) {
    const m = line.match(/^\s*\|\s*(R\d+[a-z]?)\s*\|\s*([^|]+)\s*\|(.*)$/i);
    if (!m) continue;

    const id = m[1].trim();
    let text = m[2].trim();
    text = text.replace(/^["«](.*)["»]$/, "$1").trim();
    if (text.length > 200) {
      text = text.slice(0, 200);
    }

    const rest = m[3];
    const restCols = rest.split("|").map((c) => c.trim()).filter(Boolean);

    let status = null;
    for (let i = restCols.length - 1; i >= 0; i--) {
      const col = restCols[i].toLowerCase().replace(/[*_`]/g, "");
      if (["done", "verified", "proven", "closed", "pass", "accepted"].includes(col)) {
        status = "done";
        break;
      }
      if (["open", "in-spec", "in-ticket", "pending", "in_progress"].includes(col)) {
        status = "open";
        break;
      }
      if (["deferred", "dropped", "placeholder"].includes(col)) {
        status = col;
        break;
      }
    }

    if (!status) {
      status = isClosed ? "done" : "open";
    }

    items.push({ id, text, status });
  }

  return items;
}

/**
 * Рекомендация нарезки задач (~3000 строк/тикет).
 * merge если <1500, split если >4500, иначе ok.
 * @param {number} lines
 * @returns {"merge" | "split" | "ok"}
 */
export function calibrationHint(lines) {
  const n = Number(lines) || 0;
  if (n < 1500) return "merge";
  if (n > 4500) return "split";
  return "ok";
}

/**
 * Собирает волны тикетов из plan-check артефактов (tickets с wave/zone).
 * @param {string|object|Array} root Путь к корню репозитория или объекту/массиву с тикетами
 * @returns {Array<{ n: number, tickets: Array<{ id: string, title: string, status: string, lines: number }> }>}
 */
function readTicketsFile(p) {
  if (!p || !existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.tickets)) return raw.tickets;
  } catch {}
  return null;
}

export function collectWaves(root = ".") {
  let tickets = [];
  if (Array.isArray(root)) {
    tickets = root;
  } else if (root && typeof root === "object" && Array.isArray(root.tickets)) {
    tickets = root.tickets;
  } else {
    const absRoot = resolve(typeof root === "string" ? root : ".");
    tickets = readTicketsFile(absRoot) || [];

    if (tickets.length === 0) {
      const candidates = [
        join(absRoot, "tickets.json"),
        join(absRoot, "plan.json"),
        join(absRoot, ".workflow", "tickets.json"),
        join(absRoot, ".workflow", "plan.json"),
        join(absRoot, ".workflow", "plan-check.json"),
      ];
      for (const p of candidates) {
        const loaded = readTicketsFile(p);
        if (loaded) { tickets = loaded; break; }
      }
    }

    if (tickets.length === 0) {
      const statePath = join(absRoot, ".workflow", "state.json");
      if (existsSync(statePath)) {
        try {
          const st = JSON.parse(readFileSync(statePath, "utf8"));
          if (Array.isArray(st.tickets)) tickets = st.tickets;
          else if (st.plan && Array.isArray(st.plan.tickets)) tickets = st.plan.tickets;
        } catch {}
      }
    }

    if (tickets.length === 0) {
      const changesDir = join(absRoot, "openspec", "changes");
      if (existsSync(changesDir)) {
        try {
          for (const d of readdirSync(changesDir)) {
            const found = readTicketsFile(join(changesDir, d, "tickets.json")) ||
                          readTicketsFile(join(changesDir, d, "plan.json"));
            if (found) { tickets = found; break; }
          }
        } catch {}
      }
    }
  }

  if (!Array.isArray(tickets) || tickets.length === 0) {
    return [];
  }

  const waveMap = new Map();
  for (const t of tickets) {
    if (!t || typeof t !== "object") continue;
    const waveNum = typeof t.wave === "number" && Number.isInteger(t.wave) ? t.wave : (Number(t.n) || 1);
    if (!waveMap.has(waveNum)) {
      waveMap.set(waveNum, []);
    }

    let lines = 0;
    if (typeof t.lines === "number" && !Number.isNaN(t.lines)) {
      lines = t.lines;
    }

    waveMap.get(waveNum).push({
      id: String(t.id || ""),
      title: String(t.title || t.name || t.id || ""),
      status: String(t.status || (t.done ? "done" : "pending")),
      lines,
      ...(t.zone ? { zone: t.zone } : {}),
      ...(t.requirements ? { requirements: t.requirements } : {}),
    });
  }

  return Array.from(waveMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([n, tList]) => ({
      n,
      tickets: tList,
    }));
}

/**
 * Гейты качества G1–G4:
 * G1: manifest записан
 * G2: openspec валиден (proposal + tasks + specs)
 * G3: interfaces записан
 * G4: oracle ACCEPT
 */
export function computeGates(run) {
  const artifacts = run?.artifacts || {};
  const root = run?.root || "";
  let change = run?.change;
  if (!change && artifacts.manifest?.path) {
    const m = artifacts.manifest.path.match(/openspec\/changes\/([^/\\]+)/);
    if (m) change = m[1];
  }
  const changeDir = change ? join(root, "openspec", "changes", change) : null;

  // G1: manifest записан
  const g1Artifact = artifacts.manifest;
  let g1Ok = null;
  if (g1Artifact) {
    const p = g1Artifact.path ? join(root, g1Artifact.path) : (changeDir ? join(changeDir, "manifest.md") : null);
    if (p && existsSync(p)) {
      g1Ok = true;
    } else if (p) {
      g1Ok = false;
    } else {
      g1Ok = true;
    }
  }
  const G1 = {
    ok: g1Ok,
    status: g1Ok === true ? "pass" : g1Ok === false ? "fail" : "open",
    label: "Manifest recorded",
  };

  // G2: openspec валиден (proposal + tasks + specs есть)
  const g2Artifact = artifacts.openspec;
  let g2Ok = null;
  if (g2Artifact) {
    const dir = g2Artifact.path ? join(root, g2Artifact.path) : changeDir;
    if (dir && existsSync(dir)) {
      const hasProp = existsSync(join(dir, "proposal.md"));
      const hasTasks = existsSync(join(dir, "tasks.md"));
      const specsDir = join(dir, "specs");
      let hasSpecs = existsSync(join(dir, "spec.md"));
      if (!hasSpecs && existsSync(specsDir)) {
        try {
          hasSpecs = readdirSync(specsDir).length > 0;
        } catch {}
      }
      g2Ok = Boolean(hasProp && hasTasks && hasSpecs);
    } else {
      g2Ok = false;
    }
  }
  const G2 = {
    ok: g2Ok,
    status: g2Ok === true ? "pass" : g2Ok === false ? "fail" : "open",
    label: "OpenSpec valid",
  };

  // G3: interfaces записан
  const g3Artifact = artifacts.interfaces;
  let g3Ok = null;
  if (g3Artifact) {
    const p = g3Artifact.path ? join(root, g3Artifact.path) : (changeDir ? join(changeDir, "interfaces.md") : null);
    if (p && existsSync(p)) {
      g3Ok = true;
    } else if (p) {
      g3Ok = false;
    } else {
      g3Ok = true;
    }
  }
  const G3 = {
    ok: g3Ok,
    status: g3Ok === true ? "pass" : g3Ok === false ? "fail" : "open",
    label: "Interfaces recorded",
  };

  // G4: oracle ACCEPT
  const g4Artifact = artifacts.oracle;
  let g4Ok = null;
  if (g4Artifact) {
    const detail = String(g4Artifact.detail || "");
    if (/ACCEPT/i.test(detail) && !/REJECT/i.test(detail)) {
      g4Ok = true;
    } else if (/REJECT/i.test(detail)) {
      g4Ok = false;
    } else if (g4Artifact.path && existsSync(join(root, g4Artifact.path))) {
      try {
        const txt = readFileSync(join(root, g4Artifact.path), "utf8");
        if (/Verdict:\s*ACCEPT|ACCEPT:/i.test(txt)) g4Ok = true;
        else if (/Verdict:\s*REJECT|REJECT:/i.test(txt)) g4Ok = false;
      } catch {}
    } else if (changeDir && existsSync(join(changeDir, "oracle-verdict.md"))) {
      try {
        const txt = readFileSync(join(changeDir, "oracle-verdict.md"), "utf8");
        if (/Verdict:\s*ACCEPT|ACCEPT:/i.test(txt)) g4Ok = true;
        else if (/Verdict:\s*REJECT|REJECT:/i.test(txt)) g4Ok = false;
      } catch {}
    }
    if (g4Ok === null) {
      g4Ok = false;
    }
  }
  const G4 = {
    ok: g4Ok,
    status: g4Ok === true ? "pass" : g4Ok === false ? "fail" : "open",
    label: "Oracle ACCEPT",
  };

  return { G1, G2, G3, G4 };
}

/**
 * Сборка состояния активного/закрытого прогона (OpenSpec autopilot parity).
 * Читает .workflow/state.json, парсит R## из manifest.md, читает events.jsonl.
 * Возвращает null при отсутствии state.json.
 */
export function collectRunState(root = ".", _session = null) {
  const absRoot = resolve(root);
  const statePath = join(absRoot, ".workflow", "state.json");
  if (!existsSync(statePath)) return null;

  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
  if (!state || typeof state !== "object") return null;

  const artifacts = state.artifacts || {};

  let change = null;
  let manifestPath = null;
  if (artifacts.manifest?.path) {
    manifestPath = join(absRoot, artifacts.manifest.path);
    const m = artifacts.manifest.path.match(/openspec\/changes\/([^/\\]+)/);
    if (m) change = m[1];
  }
  if (!manifestPath || !existsSync(manifestPath)) {
    const changesDir = join(absRoot, "openspec", "changes");
    if (existsSync(changesDir)) {
      try {
        const dirs = readdirSync(changesDir).filter((d) => d !== "archive" && statSync(join(changesDir, d)).isDirectory());
        for (const d of dirs) {
          const p = join(changesDir, d, "manifest.md");
          if (existsSync(p)) {
            manifestPath = p;
            change = d;
            break;
          }
        }
      } catch {}
    }
  }

  const requirements = manifestPath ? parseManifestRequirements(manifestPath, state) : [];

  const rawEvents = readJsonlSafe(join(absRoot, ".workflow", "events.jsonl"));
  const feed = rawEvents.slice(-50).map((e) => ({
    t: e.at || e.t || new Date().toISOString(),
    kind: e.kind || "event",
    text: redactSecrets(String(e.text || "")).replace(/[A-Za-z0-9_-]*SECRET[A-Za-z0-9_-]*/gi, "[REDACTED]").slice(0, 200),
  }));

  const now = Date.now();
  const startedAt = state.startedAt ? new Date(state.startedAt).getTime() : now;
  const closedAt = state.closedAt ? new Date(state.closedAt).getTime() : null;

  const waits = [];
  if (Array.isArray(state.waits)) {
    for (const w of state.waits) {
      if (w) waits.push(w);
    }
  } else if (Array.isArray(state.journal?.waits)) {
    for (const w of state.journal.waits) {
      if (w) waits.push(w);
    }
  }

  const historyList = Array.isArray(state.history) ? state.history : rawEvents;
  let lastClose = null;
  for (const ev of historyList) {
    const k = ev?.kind || "";
    const at = ev?.at || ev?.t;
    if (k === "close" && at) {
      const msAt = new Date(at).getTime();
      if (!Number.isNaN(msAt) && msAt >= startedAt - 5000) {
        lastClose = at;
      }
    } else if ((k === "open" || k === "start") && lastClose && at) {
      const ms = new Date(at).getTime() - new Date(lastClose).getTime();
      if (ms > 0) {
        waits.push({ kind: "close/open", from: lastClose, to: at, durationMs: ms });
      }
      lastClose = null;
    }
  }

  if (state.waiting?.from) {
    const ms = Math.max(0, now - new Date(state.waiting.from).getTime());
    waits.push({ kind: state.waiting.kind || "waiting", from: state.waiting.from, to: new Date().toISOString(), durationMs: ms });
  }

  let waitMs = 0;
  for (const w of waits) {
    const dur = typeof w.durationMs === "number" ? w.durationMs : (new Date(w.to).getTime() - new Date(w.from).getTime());
    if (!Number.isNaN(dur) && dur > 0) {
      waitMs += dur;
    }
  }

  const totalElapsed = Math.max(0, (closedAt || now) - startedAt);
  const activeMs = Math.max(0, totalElapsed - waitMs);

  const RUN_STAGE_IDS = ["lane", "recon", "manifest", "openspec", "interfaces", "oracle"];
  let foundCurrent = false;
  const stages = RUN_STAGE_IDS.map((id) => {
    let status = "pending";
    let durationMs = 0;
    if (artifacts[id]) {
      status = "done";
    } else if (state.status === "closed") {
      status = "missed";
    } else if (!foundCurrent) {
      status = "in_progress";
      foundCurrent = true;
    }
    return { id, status, durationMs };
  });

  const waves = collectWaves(absRoot);
  let totalLines = 0;
  let totalTickets = 0;
  for (const w of waves) {
    for (const t of (w.tickets || [])) {
      totalLines += Number(t.lines) || 0;
      totalTickets++;
    }
  }
  const avgLines = totalTickets > 0 ? Math.round(totalLines / totalTickets) : 0;
  const calibration = {
    targetLines: 3000,
    linesPerTicket: 3000,
    minLines: 1500,
    maxLines: 4500,
    totalLines,
    totalTickets,
    avgLinesPerTicket: avgLines,
    hint: calibrationHint(avgLines),
  };

  const gates = computeGates({ root: absRoot, change, artifacts, state, stages, requirements, waits });

  const rev = createHash("sha256")
    .update(
      JSON.stringify({
        status: state.status,
        tier: state.tier,
        artifacts: state.artifacts,
        reqs: requirements,
        gates,
        waitsCount: waits.length,
        wavesCount: waves.length,
        totalLines,
        eventsCount: feed.length,
        closedAt: state.closedAt,
      })
    )
    .digest("hex")
    .slice(0, 12);

  return {
    open: state.status === "open",
    status: state.status || "open",
    tier: state.tier || "T1",
    task: state.task ? redactSecrets(state.task).replace(/[A-Za-z0-9_-]*SECRET[A-Za-z0-9_-]*/gi, "[REDACTED]") : "",
    change,
    startedAt: state.startedAt || null,
    closedAt: state.closedAt || null,
    stages,
    requirements,
    waves,
    calibration,
    gates,
    waits,
    beats: Array.isArray(state.beats) ? state.beats : (Array.isArray(state.journal?.beats) ? state.journal.beats : []),
    activeMs,
    waitMs,
    feed,
    rev,
  };
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
  const metricsPath = resolveLogFile(absRoot, [".workflow/metrics.jsonl"]);
  if (!metricsPath) {
    return { total: 0, medianMs: 0, byTier: {}, recent: [] };
  }

  const records = readJsonlSafe(metricsPath);

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
      windowsHide: true,
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
      windowsHide: true,
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
    name: null,
    paseoAgentId: process.env.PASEO_AGENT_ID || null,
    transcript: null,
    usage: null,
  };
  session.usage = collectSessionUsage(absRoot, session.key);
  if (session.usage && session.usage.name) {
    session.name = session.usage.name;
  }
  const sessionFile = newestSessionFile(absRoot);
  if (sessionFile) {
    session.transcript = sessionFile.name;
    if (!session.name) {
      try {
        const fd = openSync(sessionFile.path, "r");
        const buf = Buffer.alloc(4096);
        const readLen = readSync(fd, buf, 0, 4096, 0);
        closeSync(fd);
        const chunk = buf.toString("utf8", 0, readLen);
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === "title" && j.title) {
              session.name = j.title;
              break;
            }
          } catch {}
        }
      } catch {}
    }
  }
  if (!session.name && state && state.task) {
    session.name = state.task;
  }
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
    waves: buildWaves(stages, fleet),
    git,
    modules,
    critique: critique.verdicts,
    history,
    fleet,
    run: cached(`run:${absRoot}`, 1000, () => collectRunState(absRoot, options.session)),
  };
}

/* ------------------------------------------------------------------ */
/*  Session binding, events, logs, architecture tree                   */
/* ------------------------------------------------------------------ */

/** Файл событий воркфлоу: start/artifact/check/close — источник вкладки «Логи». */
export const EVENTS_FILE = ".workflow/events.jsonl";

/** Каталог рантайм-файлов дашбордов: по одному на (проект, сессия). */
export const DASHBOARDS_DIR = ".workflow/dashboards";
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** Валидация ключа сессии: отказ от пустых, слэшей, .., букв диска, зарезервированных имён. */
export function validateSessionKey(key) {
  if (typeof key !== "string" || key.trim().length === 0) throw new Error("Недопустимый ключ сессии: ключ не может быть пустым");
  if (key.includes("/") || key.includes("\\")) throw new Error(`Недопустимый ключ сессии "${key}": содержит разделители пути`);
  if (key.includes("..")) throw new Error(`Недопустимый ключ сессии "${key}": содержит ".."`);
  if (/^[a-zA-Z]:/.test(key) || key.includes(":")) throw new Error(`Недопустимый ключ сессии "${key}": содержит букву диска или двоеточие`);
  if (RESERVED_DEVICE_NAMES.test(key)) throw new Error(`Недопустимый ключ сессии "${key}": зарезервированное имя устройства`);
  if (/[<>:"/\\|?*\x00-\x1f]/.test(key)) throw new Error(`Недопустимый ключ сессии "${key}": содержит недопустимые символы`);
  return key;
}

/** Ключ сессии: явный --session, Paseo agent id, OMP session id, иначе «local». */
export function sessionKey(override = null) {
  if (override !== null && override !== undefined) return validateSessionKey(String(override));
  if (process.env.PASEO_AGENT_ID) return validateSessionKey(`paseo-${String(process.env.PASEO_AGENT_ID).slice(0, 8)}`);
  if (process.env.OMP_SESSION_ID) return validateSessionKey(`omp-${String(process.env.OMP_SESSION_ID).slice(0, 8)}`);
  return "local";
}

/** Стабильный порт для сессии: база + смещение от хеша ключа. */
export function portForSession(key, base = 4200, span = 60) {
  const valid = validateSessionKey(key);
  let h = 0;
  for (let i = 0; i < valid.length; i++) h = (h * 31 + valid.charCodeAt(i)) >>> 0;
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

/**
 * Быстрое извлечение метаданных агента напрямую с диска Paseo (без дочерних процессов).
 */
export function readAgentFromDisk(agentId) {
  if (!agentId) return null;
  const base = join(homedir(), ".paseo", "agents");
  if (!existsSync(base)) return null;
  try {
    for (const dir of readdirSync(base)) {
      const fullDir = join(base, dir);
      try {
        if (!statSync(fullDir).isDirectory()) continue;
      } catch { continue; }
      const file = join(fullDir, `${agentId}.json`);
      if (existsSync(file)) {
        const json = JSON.parse(readFileSync(file, "utf8"));
        return {
          Name: json.title || json.name || null,
          Provider: json.provider || null,
          Model: json.config?.model || json.runtimeInfo?.model || null,
          Status: json.lastStatus || json.status || null,
          Cwd: json.cwd || null,
          CreatedAt: json.createdAt || null,
          UpdatedAt: json.updatedAt || null,
          nativeHandle: json.persistence?.nativeHandle || null,
        };
      }
    }
  } catch {}
  return null;
}

/** Подсчёт расхода токенов из транскрипта сессии (JSONL) без вызова дочерних процессов. */
export function readSessionTokensFromTranscript(jsonlPath) {
  if (!jsonlPath || !existsSync(jsonlPath)) return null;
  try {
    const content = tailBytes(jsonlPath, 1024 * 1024);
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    for (const line of content.split("\n")) {
      if (!line.includes('"usage"') && !line.includes('"totalTokens"')) continue;
      try {
        const obj = JSON.parse(line);
        const u = obj.message?.usage || obj.data?.usage || obj.usage;
        if (u) {
          if (typeof u.input === "number") inputTokens += u.input;
          if (typeof u.output === "number") outputTokens += u.output;
          if (typeof u.cacheRead === "number") cachedTokens += u.cacheRead;
          if (typeof u.totalCost === "number") costUsd += u.totalCost;
          else if (typeof u.cost?.total === "number") costUsd += u.cost.total;
        }
      } catch {}
    }
    return { inputTokens, outputTokens, cachedTokens, costUsd: Number(costUsd.toFixed(4)) };
  } catch {
    return null;
  }
}

export function collectSessionUsage(absRoot, key) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return null;
  const cachePath = join(absRoot, DASHBOARDS_DIR, key + ".usage.json");

  // 1. Прямое чтение с диска без запуска процессов (0 окон node.exe / cmd.exe)
  const agent = readAgentFromDisk(agentId);
  if (agent) {
    let tokens = null;
    if (agent.nativeHandle) {
      tokens = readSessionTokensFromTranscript(agent.nativeHandle);
    }
    const data = {
      at: Date.now(),
      stale: false,
      name: agent.Name,
      provider: agent.Provider,
      model: agent.Model,
      status: agent.Status,
      cwd: agent.Cwd,
      createdAt: agent.CreatedAt,
      updatedAt: agent.UpdatedAt,
      inputTokens: tokens?.inputTokens || 0,
      outputTokens: tokens?.outputTokens || 0,
      cachedTokens: tokens?.cachedTokens || 0,
      costUsd: tokens?.costUsd ?? null,
    };
    try {
      const dir = dirname(cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ at: Date.now(), data }), "utf8");
    } catch {}
    return data;
  }

  // 2. Фолбэк на кэш
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached && cached.data) {
        const u = cached.data;
        const usage = u.LastUsage || {};
        return {
          at: cached.at,
          stale: true,
          name: u.Name || u.name || null,
          provider: u.Provider || u.provider || null,
          model: u.Model || u.model || null,
          status: u.Status || u.status || null,
          cwd: u.Cwd || u.cwd || null,
          createdAt: u.CreatedAt || u.createdAt || null,
          updatedAt: u.UpdatedAt || u.updatedAt || null,
          inputTokens: u.inputTokens ?? usage.InputTokens ?? 0,
          outputTokens: u.outputTokens ?? usage.OutputTokens ?? 0,
          cachedTokens: u.cachedTokens ?? usage.CachedTokens ?? 0,
          costUsd: u.costUsd ?? (typeof usage.CostUsd === "number" ? Number(usage.CostUsd.toFixed(4)) : null),
        };
      }
    } catch {}
  }

  return null;
}

/** События воркфлоу из .workflow/events.jsonl (последние N). */
export function collectEvents(absRoot, limit = 60) {
  const path = join(absRoot, EVENTS_FILE);
  if (!existsSync(path)) return [];
  const lines = tailBytes(path, 64 * 1024).split("\n").filter(Boolean);
  const out = [];
  const allowedStages = new Set(["lane", "recon", "spec", "manifest", "interfaces", "tasks", "verification", "oracle", "closed"]);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      let status = "ok";
      if (e.kind === "start") {
        status = "started";
      } else if (e.kind === "close") {
        status = "closed";
      } else if (e.kind === "artifact") {
        const firstWord = String(e.text || "").trim().split(/[\s:—]/)[0]?.toLowerCase();
        status = allowedStages.has(firstWord) ? firstWord : (e.status || "recorded");
      } else if (e.status) {
        status = String(e.status).slice(0, 30);
      }
      out.push({
        at: e.at || null,
        kind: e.kind || "event",
        status,
      });
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
      entries.push({
        at: e.timestamp || null,
        kind: "tool",
        label: d.toolName || "tool",
        status: "start",
      });
    } else if (e.type === "message") {
      const m = e.message || {};
      const role = m.role || "?";
      if (role === "toolResult") {
        const text = Array.isArray(m.content)
          ? m.content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim()
          : "";
        const isError = /^(error|ошибка|failed|exception)/i.test(text) || /exit code [1-9]/.test(text) || Boolean(m.isError);
        entries.push({
          at: e.timestamp || null,
          kind: isError ? "error" : "result",
          label: m.toolName || "result",
          status: isError ? "error" : "ok",
        });
      } else if (role === "assistant") {
        entries.push({
          at: e.timestamp || null,
          kind: "assistant",
          label: "assistant",
          status: "message",
        });
      } else if (role === "user") {
        entries.push({
          at: e.timestamp || null,
          kind: "user",
          label: "user",
          status: "message",
        });
      }
    } else if (e.type === "custom_message") {
      entries.push({
        at: e.timestamp || null,
        kind: "notice",
        label: e.customType || "notice",
        status: "notice",
      });
    }
  }

  return { file: "активна", entries: entries.slice(-limit) };
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
