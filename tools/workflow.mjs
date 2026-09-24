#!/usr/bin/env node
/**
 * workflow.mjs — tier enforcement for the portable workflow harness protocol.
 *
 * WHY THIS EXISTS
 * The lane classification and the 4-Wave artifacts were text rules in a prompt.
 * Measured over 38 real sessions: 0.7% of responses carried a lane header, 36%
 * produced a manifest, 13% used CONTEXT.md. Meanwhile `openspec` — an external
 * command with an exit code — was adopted in 84%. A rule the agent can silently
 * skip is not a rule. This turns the protocol into a command that FAILS when the
 * artifacts are missing.
 *
 * COMMANDS
 *   start  --tier T2 --task "..."   open a task, declare its lane
 *          [--auto --allow "<glob>" --max-diff <N>]  guarded auto for T0
 *   suggest --files a.ts,b.ts [--task "..."]  heuristic tier suggestion
 *   artifact --kind manifest --path openspec/changes/x/manifest.md
 *   check                            verify the tier's requirements; exit 1 if unmet
 *   status                           what is done / still required
 *   close  [--force --reason "..."]  finish the task
 *          [--auto] [--diff-lines N] finish guarded auto task
 *
 * TIER REQUIREMENTS (a tier requires everything the tiers below it require)
 *   T0  lane only            — trivial, 1-2 known files
 *   T1  + recon notes        — 3+ files / unfamiliar area
 *   T2  + manifest, openspec change, interfaces, oracle verdict
 *   T3  + worktree isolation — program of work
 *
 * State: .workflow/state.json (gitignored). Exit 0 ok, 1 unmet, 2 cannot run.
 * Budgets: .workflow/budgets.json (optional, defaults {T0:10, T1:25, T2:45, T3:45}).
 * Zero dependencies. Node 18+ / Bun.
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const DIR = ".workflow";
const FILE = "state.json";
const BUDGETS_FILE = "budgets.json";
const METRICS_FILE = "metrics.jsonl";
const DEFAULT_BUDGETS = { T0: 10, T1: 25, T2: 45, T3: 45 };

// Ordered: each tier inherits every requirement below it.
const LADDER = ["T0", "T1", "T2", "T3"];

const REQUIREMENTS = {
  T0: [
    { kind: "lane", label: "lane declared (start --tier)", auto: true },
  ],
  T1: [
    // minDetail: a one-word "done" is what makes a gate decorative. The floor is
    // low on purpose - enough that the field cannot be satisfied by accident.
    { kind: "recon", label: "recon notes: files touched + acceptance check", path: null, minDetail: 20 },
  ],
  T2: [
    { kind: "manifest", label: "manifest.md with R## rows + verbatim user quotes", path: "openspec/changes/<name>/manifest.md", requiresPath: true, mustContain: /R\d\d/ },
    { kind: "openspec", label: "openspec change validated", path: "openspec/changes/<name>", requiresPath: true },
    { kind: "interfaces", label: "interfaces.md: boundaries + signatures + owners", path: "openspec/changes/<name>/interfaces.md", requiresPath: true, minDetail: 40 },
    { kind: "oracle", label: "oracle verdict + its reasons", path: null, minDetail: 30, mustContain: /ACCEPT|REJECT/i },
  ],
  T3: [
    { kind: "worktree", label: "isolated worktree per major slice", path: null },
  ],
};

/** Everything required at `tier`, in ladder order. */
function requiredFor(tier) {
  const upto = LADDER.indexOf(tier);
  if (upto < 0) return [];
  const out = [];
  for (let i = 0; i <= upto; i++) {
    for (const r of REQUIREMENTS[LADDER[i]]) out.push({ ...r, tier: LADDER[i] });
  }
  return out;
}

/* --------------------------------------------------------------------- state */

function statePath(root) { return join(root, DIR, FILE); }
function budgetsPath(root) { return join(root, DIR, BUDGETS_FILE); }

/** Plain object guard: `null`, arrays and scalars are not task state. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadBudgets(root) {
  const p = budgetsPath(root);
  if (!existsSync(p)) return { ...DEFAULT_BUDGETS };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    return {
      T0: typeof raw.T0 === "number" ? raw.T0 : DEFAULT_BUDGETS.T0,
      T1: typeof raw.T1 === "number" ? raw.T1 : DEFAULT_BUDGETS.T1,
      T2: typeof raw.T2 === "number" ? raw.T2 : DEFAULT_BUDGETS.T2,
      T3: typeof raw.T3 === "number" ? raw.T3 : DEFAULT_BUDGETS.T3,
    };
  } catch {
    return { ...DEFAULT_BUDGETS };
  }
}

function load(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    // Corrupt/foreign state (not an object, unknown tier) means "no task", not
    // "a task with no requirements": otherwise `check` reports COMPLETE on `{}`
    // and `status` dies with a TypeError on the missing artifacts map.
    if (!isPlainObject(parsed) || !LADDER.includes(parsed.tier)) return null;
    return { ...parsed, artifacts: isPlainObject(parsed.artifacts) ? parsed.artifacts : {} };
  }
  catch { return null; }
}

function save(root, st) {
  // Atomic write: a crash mid-write must never leave a truncated state.json.
  const target = statePath(root);
  // Уникальное имя временного файла: два агента в одном проекте не должны
  // затирать друг другу запись (раньше это был общий state.json.tmp).
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, JSON.stringify(st, null, 2));
  renameSync(tmp, target);
}

function appendMetric(root, record) {
  const p = join(root, DIR, METRICS_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  appendFileSync(p, line, "utf8");
}

function readMetricsRaw(root) {
  const p = join(root, DIR, METRICS_FILE);
  if (!existsSync(p)) return [];
  const content = readFileSync(p, "utf8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // "null" and scalars parse fine and then crash the aggregation.
      if (isPlainObject(parsed)) out.push(parsed);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function buildMetricRecord(st) {
  const closedMs = new Date(st.closedAt || new Date().toISOString()).getTime();
  const startedMsRaw = st.startedAt ? new Date(st.startedAt).getTime() : NaN;
  const startedMs = Number.isNaN(startedMsRaw) ? closedMs : startedMsRaw;
  const durationMs = Math.max(0, closedMs - startedMs);
  const artifactsCount = st.artifacts ? Object.keys(st.artifacts).length : 0;
  const isForced = Boolean(st.deviation?.forced);
  return {
    task: st.task || "(untitled)",
    tier: st.tier,
    startedAt: st.startedAt || st.closedAt,
    closedAt: st.closedAt,
    durationMs,
    forced: isForced,
    auto: st.auto ?? null,
    artifactsCount,
  };
}

function reconcileMetrics(root, { lockHeld = false } = {}) {
  const doReconcile = () => {
    const st = load(root);
    if (!st || st.status !== "closed") return null;

    const records = readMetricsRaw(root);
    const alreadyRecorded = records.some((m) =>
      m.task === st.task &&
      m.startedAt === (st.startedAt || st.closedAt) &&
      m.closedAt === st.closedAt
    );

    if (!alreadyRecorded) {
      const metricRecord = st.metric || buildMetricRecord(st);
      appendMetric(root, metricRecord);
      return metricRecord;
    }
    return null;
  };

  if (lockHeld) {
    return doReconcile();
  }
  return withStateLock(root, doReconcile);
}

function loadMetrics(root) {
  reconcileMetrics(root);
  return readMetricsRaw(root);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function acquireLock(root, timeoutMs = 5000, staleMs = 60000) {
  const dir = join(root, DIR);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }
  const lockFile = join(dir, "state.lock");
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  while (true) {
    try {
      const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
      writeFileSync(lockFile, payload, { flag: "wx" });
      return () => {
        try {
          if (existsSync(lockFile)) {
            try {
              const data = JSON.parse(readFileSync(lockFile, "utf8"));
              if (data.token === token) {
                rmSync(lockFile, { force: true });
              }
            } catch {}
          }
        } catch {}
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      try {
        if (existsSync(lockFile)) {
          let info = null;
          try {
            const content = readFileSync(lockFile, "utf8");
            info = JSON.parse(content);
          } catch {
            // Bounded wait on unparsable lock: only clean up if older than 1000ms
            try {
              const s = statSync(lockFile);
              if (Date.now() - s.mtimeMs > 1000) {
                rmSync(lockFile, { force: true });
                continue;
              }
            } catch {}
          }

          if (info && info.pid && typeof info.pid === "number") {
            let isDead = false;
            try {
              process.kill(info.pid, 0);
            } catch (kErr) {
              if (kErr.code === "ESRCH") isDead = true;
            }
            const isExpired = typeof staleMs === "number" && staleMs > 0 && (Date.now() - (info.createdAt || 0) > staleMs);
            // Recover if process is verified dead OR if wall-clock stale fallback expired
            if (isDead || isExpired) {
              try { rmSync(lockFile, { force: true }); } catch {}
              continue;
            }
          }
        }
      } catch {}

      if (Date.now() >= deadline) {
        return null;
      }
      sleepSync(25);
    }
  }
}

function withStateLock(root, fn, options = {}) {
  const release = acquireLock(root, options.timeoutMs, options.staleMs);
  if (!release) {
    console.error("workflow: could not acquire state lock; timed out waiting for concurrent operation.");
    return 1;
  }
  try {
    return fn();
  } finally {
    release();
  }
}

function cmdMetrics(root) {
  const list = loadMetrics(root);
  if (list.length === 0) {
    console.log("задач пока нет");
    return 0;
  }

  const total = list.length;
  const byTier = {};
  const durations = [];
  let forcedCount = 0;
  let autoCount = 0;

  for (const m of list) {
    const t = m.tier || "UNKNOWN";
    byTier[t] = (byTier[t] || 0) + 1;
    if (typeof m.durationMs === "number" && !Number.isNaN(m.durationMs)) {
      durations.push(m.durationMs);
    }
    if (m.forced) forcedCount++;
    if (m.auto) autoCount++;
  }

  durations.sort((a, b) => a - b);
  const sum = durations.reduce((acc, v) => acc + v, 0);
  const avgMs = durations.length ? Math.round(sum / durations.length) : 0;
  let medMs = 0;
  if (durations.length) {
    const mid = Math.floor(durations.length / 2);
    medMs = durations.length % 2 !== 0 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
  }

  console.log(`Всего задач: ${total}`);
  console.log("По тирам:");
  for (const t of LADDER) {
    if (byTier[t]) console.log(`  ${t}: ${byTier[t]}`);
  }
  for (const [k, v] of Object.entries(byTier)) {
    if (!LADDER.includes(k)) console.log(`  ${k}: ${v}`);
  }
  console.log(`Средняя длительность: ${avgMs} мс`);
  console.log(`Медианная длительность: ${medMs} мс`);
  console.log(`Force-закрытий: ${forcedCount}`);
  console.log(`Авто-режимов: ${autoCount}`);
  return 0;
}
/* ------------------------------------------------------------------- suggest */

const KEYWORDS_T3_EXPLICIT = [
  /(?:несколько фич|множество задач|параллельн|мульти-фич|multi-feature|программа)/i,
];
// "add X and implement Y" — two independent feature verbs joined by and/plus.
// Bare "and" alone is NOT a program signal: "migration and schema update" is one feature.
const VERB_PAIR_T3 = /\b(?:add|implement|build|create|refactor|добавить|реализовать)\b[\s\S]{0,80}?\b(?:and|plus|и)\b[\s\S]{0,80}?\b(?:add|implement|build|create|refactor|добавить|реализовать)\b/i;

const KEYWORDS_T2 = [
  /\b(?:schema|migration|database|db|migration|architectur|redesign|refactor-all)\b/i,
  /(?:схема|миграци|архитектур|баз[аы]\s+данных|редизайн)/i,
];

const KEYWORDS_NEW_DEP_OR_API = [
  /\b(?:dep|dependency|package|npm|install|api|endpoint|contract|breaking)\b/i,
  /(?:зависимост|пакет|эндпоинт|контракт|апи)/i,
];

function isUnfamiliarDir(file) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  // Heuristic: top-level dirs or paths that look like unknown/new/experimental modules
  return /(?:^|\/)(?:experimental|legacy|vendor|unfamiliar|new-module|external)\//i.test(normalized);
}

function suggestTier({ files = [], task = "" }) {
  const fileList = Array.isArray(files)
    ? files.filter(Boolean)
    : String(files || "").split(",").map((s) => s.trim()).filter(Boolean);
  const taskStr = String(task || "");

  const reasons = [];
  let totalRules = 4;
  let matchedRules = 0;

  const hasT3Kw = KEYWORDS_T3_EXPLICIT.some((re) => re.test(taskStr))
    || (VERB_PAIR_T3.test(taskStr) && !KEYWORDS_T2.some((re) => re.test(taskStr)));
  const hasT2Kw = KEYWORDS_T2.some((re) => re.test(taskStr));
  const hasDepOrApiKw = KEYWORDS_NEW_DEP_OR_API.some((re) => re.test(taskStr));
  const count = fileList.length;
  const hasUnfamiliar = fileList.some(isUnfamiliarDir);

  let tier = "T0";

  // Rule 1: Multi-feature keywords or program scope -> T3
  if (hasT3Kw) {
    tier = "T3";
    matchedRules++;
    reasons.push("задача содержит ключевые слова множественных фич или объединения задач ('and', 'plus', 'несколько фич')");
  }

  // Rule 2: Schema / migration / architecture keywords or >9 files -> at least T2
  if (count > 9 || hasT2Kw) {
    if (LADDER.indexOf("T2") > LADDER.indexOf(tier)) {
      tier = "T2";
    }
    matchedRules++;
    if (count > 9) {
      reasons.push(`большой охват файлов (${count} > 9), требуется manifest и OpenSpec`);
    }
    if (hasT2Kw) {
      reasons.push("задача затрагивает схему данных, миграции или архитектурные изменения");
    }
  }

  // Rule 3: 3-9 files or unfamiliar directory -> at least T1
  if ((count >= 3 && count <= 9) || hasUnfamiliar) {
    if (LADDER.indexOf("T1") > LADDER.indexOf(tier)) {
      tier = "T1";
    }
    matchedRules++;
    if (count >= 3 && count <= 9) {
      reasons.push(`затрагивается от 3 до 9 файлов (${count}), требуется разведка и recon notes`);
    }
    if (hasUnfamiliar) {
      reasons.push("обнаружены файлы в незнакомых или изолированных директориях");
    }
  }

  // Rule 4: Small scope: 1-2 files and no keywords -> T0
  if (count <= 2 && !hasT3Kw && !hasT2Kw) {
    if (hasDepOrApiKw) {
      if (LADDER.indexOf("T1") > LADDER.indexOf(tier)) {
        tier = "T1";
      }
      matchedRules++;
      reasons.push("обнаружены ключевые слова новых зависимостей или API изменений");
    } else {
      matchedRules++;
      reasons.push(`локальное изменение (${count === 0 ? "0-1" : count} файл(а)) без изменения зависимостей, API или схем данных`);
    }
  }

  // If no reasons collected yet (e.g. 0 files with standard prompt), provide default T0 reason
  if (reasons.length === 0) {
    matchedRules++;
    reasons.push("базовое локальное изменение");
  }

  const confidence = Number((Math.min(matchedRules, totalRules) / totalRules).toFixed(2));
  return { tier, confidence, reasons };
}

function cmdSuggest(flags) {
  const rawFiles = flags.files ? String(flags.files) : "";
  const files = rawFiles ? rawFiles.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const task = flags.task ? String(flags.task) : "";
  const result = suggestTier({ files, task });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/* ----------------------------------------------------------------------- cli */

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { o.flags[k] = next; i++; }
      else o.flags[k] = true;
    } else o._.push(a);
  }
  return o;
}

/**
 * Автозапуск дашборда (best-effort): поднимает фоновый сервер наблюдения и
 * открывает страницу. Никогда не влияет на код возврата воркфлоу — дашборд
 * это наблюдаемость, а не условие работы. Отключается --no-dashboard или NF_NO_DASHBOARD=1.
 */
function autoOpenDashboard(root, flags) {
  if (flags && flags["no-dashboard"]) return;
  if (process.env.NF_NO_DASHBOARD === "1") return;
  try {
    const dash = join(dirname(fileURLToPath(import.meta.url)), "dashboard.mjs");
    if (!existsSync(dash)) return;
    const child = spawn(process.execPath, [dash, "--ensure", "--root", root], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // Ждём до 2 с появления рантайм-файла с реальным URL, чтобы напечатать точный адрес
    let url = null;
    const rt = join(root, ".workflow", "dashboard.json");
    for (let i = 0; i < 25; i++) {
      try {
        if (existsSync(rt)) {
          const parsed = JSON.parse(readFileSync(rt, "utf8"));
          if (parsed && parsed.url) {
            url = parsed.url;
            break;
          }
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
    if (url) {
      if (process.env.PASEO_AGENT_ID || process.env.PASEO_HOME || process.env.PASEO_CLI) {
        console.log(`  dashboard: ${url} — открой во вкладке Paseo: browser_new_tab("${url}")`);
      } else {
        console.log(`  dashboard: ${url} (сервер запущен, открывается в браузере)`);
      }
    } else {
      console.log("  dashboard: автозапуск фоном (адрес — .workflow/dashboard.json)");
    }
  } catch {
    // молча: наблюдаемость не должна ломать гейт
  }
}

/** Событие воркфлоу для вкладки «Логи» дашборда: одна строка JSON. */
function logEvent(root, kind, text, extra = {}) {
  try {
    const dir = join(root, ".workflow");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), kind, text, ...extra }) + "\n";
    appendFileSync(join(dir, "events.jsonl"), line, "utf8");
  } catch {
    // журнал событий — наблюдаемость, а не условие работы
  }
}

function cmdStart(root, flags) {
  return withStateLock(root, () => {
    reconcileMetrics(root, { lockHeld: true });
    const tier = String(flags.tier || "").toUpperCase();
    if (!LADDER.includes(tier)) {
      console.error(`workflow: --tier must be one of ${LADDER.join(', ')} (got '${flags.tier || ''}')`);
      return 2;
    }

    const isAuto = Boolean(flags.auto);
    let autoConfig = null;
    if (isAuto) {
      // Guarded auto validation: tier must be T0; refuse T1+
      if (tier !== "T0") {
        const refusal = {
          at: new Date().toISOString(),
          tier,
          reason: `Guarded auto-mode refused: tier ${tier} exceeds maximum allowable tier T0`,
        };
        let st = load(root);
        if (!st) {
          st = {
            version: 1,
            tier,
            task: String(flags.task || "(untitled)"),
            startedAt: new Date().toISOString(),
            status: "refused",
            artifacts: {},
          };
        }
        st.autoRefusal = refusal;
        save(root, st);
        console.error(`workflow: guarded auto mode refused for ${tier} (only T0 allowed)`);
        return 1;
      }

      if (!flags.allow || typeof flags.allow !== "string" || !flags.allow.trim()) {
        console.error("workflow: --auto requires --allow \"<pattern>\" (e.g. --allow \"src/**\")");
        return 1;
      }

      const maxDiffNum = flags["max-diff"] !== undefined ? Number(flags["max-diff"]) : NaN;
      if (Number.isNaN(maxDiffNum) || maxDiffNum < 1 || maxDiffNum > 20) {
        console.error("workflow: --auto requires --max-diff <N> where 1 <= N <= 20");
        return 1;
      }

      autoConfig = {
        allow: String(flags.allow).trim(),
        maxDiff: maxDiffNum,
      };
    }

    const prev = load(root);
    if (prev && prev.status === "open") {
      if (!flags.force) {
        console.error(`workflow: task '${prev.task}' is already open at ${prev.tier}.`);
        const mine = process.env.PASEO_AGENT_ID
          ? `paseo-${String(process.env.PASEO_AGENT_ID).slice(0, 8)}`
          : "local";
        if (prev.session && prev.session !== mine) {
          console.error(`  opened by another session (${prev.session}); two agents in one project share the lane gate.`);
        }
        console.error(`  close it first, escalate it with 'escalate', or pass --force --reason "<why>" to replace it.`);
        return 2;
      }
      if (!flags.reason) {
        console.error(`workflow: --force replacement requires --reason "<why the active task is abandoned/replaced>"`);
        return 1;
      }
    }

    const budgets = loadBudgets(root);
    const tierBudget = budgets[tier] ?? DEFAULT_BUDGETS[tier] ?? 45;

    const st = {
      version: 1,
      tier,
      task: String(flags.task || "(untitled)"),
      startedAt: new Date().toISOString(),
      status: "open",
      session: process.env.PASEO_AGENT_ID
        ? `paseo-${String(process.env.PASEO_AGENT_ID).slice(0, 8)}`
        : process.env.OMP_SESSION_ID
          ? `omp-${String(process.env.OMP_SESSION_ID).slice(0, 8)}`
          : "local",
      artifacts: { lane: { at: new Date().toISOString(), path: null, detail: tier } },
    };
    if (autoConfig) {
      st.auto = autoConfig;
    }
    if (prev && prev.status === "open" && flags.force) {
      st.deviation = {
        forced: true,
        reason: String(flags.reason),
        replacedTask: {
          task: prev.task,
          tier: prev.tier,
          startedAt: prev.startedAt,
        },
      };
      logEvent(root, "replace", `${tier} — ${st.task} (replaced '${prev.task}': ${flags.reason})`);
      console.log(`workflow: replaced active task '${prev.task}' with DEVIATION (${flags.reason})`);
    }
    save(root, st);
    logEvent(root, "start", `${tier} — ${st.task}`);
    console.log(`workflow: ${tier} task opened — ${st.task}`);
    console.log(`  budget: ${tierBudget} tool calls for ${tier}`);
    if (autoConfig) {
      console.log(`  auto: guarded autonomous mode enabled (allow: "${autoConfig.allow}", max-diff: ${autoConfig.maxDiff})`);
    }
    printRemainingArtifacts(tier, st);
    return 0;
  });
}
function printRemainingArtifacts(tier, st) {
  const reqs = requiredFor(tier).filter((r) => !st.artifacts[r.kind]);
  if (reqs.length) {
    console.log(`  this tier further requires ${reqs.length} artifact(s):`);
    for (const r of reqs) console.log(`    - ${r.kind.padEnd(11)} ${r.label}`);
  } else {
    console.log(`  no further artifacts required at this tier.`);
  }
}


function hashFile(fullPath) {
  try {
    const buf = readFileSync(fullPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function isPathInsideRoot(root, userPath) {
  if (!userPath || typeof userPath !== "string") return false;
  const absRoot = resolve(root);
  const absTarget = resolve(root, userPath);
  const rel = relative(absRoot, absTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function isRealPathInsideRoot(root, userPath) {
  if (!userPath || typeof userPath !== "string") return false;
  if (!isPathInsideRoot(root, userPath)) return false;
  const fullPath = resolve(root, userPath);
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(fullPath);
    const rel = relative(realRoot, realTarget);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}
const GENERATED_DIRS = new Set([".tmp", ".archmap", ".codemap", ".opencode"]);
function isExcludedFromSnapshot(relPath) {
  if (!relPath) return true;
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const base = parts[parts.length - 1];
  if (parts.some((part) => GENERATED_DIRS.has(part)) ||
      parts[0] === "cache" || parts[0] === "logs") return true;

  // Exclude harness state, runtime state, caches, VCS
  if (
    normalized === DIR ||
    normalized.startsWith(`${DIR}/`) ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized.includes("/.git/") ||
    normalized === "node_modules" ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/")
  ) {
    return true;
  }

  // Security: NEVER read, touch or hash credentials, secret files, or model configs
  if (
    base === "models.yml" ||
    base === "models.yaml" ||
    base === "mcp.json" ||
    base.startsWith(".env") ||
    base.startsWith("secrets") ||
    /credentials|\.secret|secrets\.|\.key$|\.pem$/i.test(base)
  ) {
    return true;
  }

  return false;
}

function scanWorktree(root) {
  try {
    const trackedOut = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    });
    function collectFiles(output) {
      const map = {};
      for (const rel of output.split("\0")) {
        if (!rel || isExcludedFromSnapshot(rel)) continue;
        if (!isPathInsideRoot(root, rel) || !isRealPathInsideRoot(root, rel)) continue;
        const full = join(root, rel);
        const hash = hashFile(full);
        if (hash !== null) {
          try {
            const s = statSync(full);
            map[rel] = { hash, mtimeMs: s.mtimeMs, size: s.size };
          } catch {}
        }
      }
      return map;
    }
    const tracked = collectFiles(trackedOut);
    const untracked = collectFiles(untrackedOut);
    return { isGit: true, tracked, untracked };
  } catch {
    const files = {};
    function walk(dir, relPrefix = "") {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (isExcludedFromSnapshot(rel)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isPathInsideRoot(root, rel) || !isRealPathInsideRoot(root, rel)) continue;
          walk(full, rel);
        } else if (entry.isFile()) {
          if (!isPathInsideRoot(root, rel) || !isRealPathInsideRoot(root, rel)) continue;
          const hash = hashFile(full);
          if (hash !== null) {
            try {
              const s = statSync(full);
              files[rel] = { hash, mtimeMs: s.mtimeMs, size: s.size };
            } catch {}
          }
        }
      }
    }
    walk(root);
    return { isGit: false, files };
  }
}

function validateArtifacts(root, st) {
  const reqs = requiredFor(st.tier);
  const missing = [];
  const invalid = [];

  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    if (!a) {
      missing.push(r.kind);
      continue;
    }

    if (r.requiresPath || a.path) {
      if (!a.path) {
        invalid.push(`${r.kind}: missing required file path`);
        continue;
      }
      if (!isPathInsideRoot(root, a.path)) {
        invalid.push(`${r.kind}: path '${a.path}' must be a relative path inside project root`);
        continue;
      }
      const fullPath = join(root, a.path);
      if (!existsSync(fullPath)) {
        invalid.push(`${r.kind}: path '${a.path}' does not exist on disk`);
        continue;
      }
      if (!isRealPathInsideRoot(root, a.path)) {
        invalid.push(`${r.kind}: path '${a.path}' real path must stay inside project root`);
        continue;
      }
      const s = statSync(fullPath);
      if (r.kind === "openspec") {
        if (!s.isDirectory()) {
          invalid.push(`${r.kind}: path '${a.path}' must be a directory`);
          continue;
        }
        let entries = [];
        try { entries = readdirSync(fullPath); } catch {}
        if (entries.length === 0) {
          invalid.push(`${r.kind}: directory '${a.path}' is empty`);
          continue;
        }
        let hasExternalEntry = false;
        for (const entry of entries) {
          const entryPath = join(a.path, entry);
          if (!isRealPathInsideRoot(root, entryPath)) {
            invalid.push(`${r.kind}: entry '${entryPath}' real path must stay inside project root`);
            hasExternalEntry = true;
            break;
          }
        }
        if (hasExternalEntry) continue;
      } else {
        if (!s.isFile()) {
          invalid.push(`${r.kind}: path '${a.path}' must be a file`);
          continue;
        }
        let body = "";
        try { body = readFileSync(fullPath, "utf8"); } catch {}
        if (body.trim().length === 0) {
          invalid.push(`${r.kind}: file '${a.path}' is empty`);
          continue;
        }
        if (r.mustContain && !r.mustContain.test(body)) {
          invalid.push(`${r.kind}: file '${a.path}' does not contain expected pattern (${r.mustContain})`);
          continue;
        }
        if (r.kind === "interfaces" && body.trim().length < 10) {
          invalid.push(`${r.kind}: file '${a.path}' is too short (< 10 chars)`);
          continue;
        }
      }
    }

    if (r.kind === "oracle") {
      const detail = a.detail || "";
      const isNegated = /\b(?:NOT|NON|UN|CANNOT|NEVER|NO)\s+ACCEPT(?:ED)?\b/i.test(detail) || /\bREJECT(?:ED)?\b/i.test(detail);
      const isPositive = /(?:^|\n)\s*(?:#+\s*)?(?:Verdict:\s*)?ACCEPT(?::|\s|$)/i.test(detail) || /(?:^|\n)\s*\|\s*Verdict\s*\|\s*ACCEPT\b/i.test(detail);
      if (isNegated || !isPositive) {
        invalid.push("oracle: verdict is REJECT (must be ACCEPT)");
      }
      if (a.path) {
        const fullPath = join(root, a.path);
        if (existsSync(fullPath)) {
          let body = "";
          try { body = readFileSync(fullPath, "utf8"); } catch {}
          const bodyNegated = /\b(?:NOT|NON|UN|CANNOT|NEVER|NO)\s+ACCEPT(?:ED)?\b/i.test(body) || /\bREJECT(?:ED)?\b/i.test(body);
          const bodyPositive = /(?:^|\n)\s*(?:#+\s*)?(?:Verdict:\s*)?ACCEPT(?::|\s|$)/im.test(body) || /(?:^|\n)\s*\|\s*Verdict\s*\|\s*ACCEPT\b/i.test(body);
          if (bodyNegated || !bodyPositive) {
            invalid.push(`oracle: verdict in '${a.path}' is REJECT`);
          }
        }
      }
    }
  }

  return { reqs, missing, invalid, ok: missing.length === 0 && invalid.length === 0 };
}

function cmdArtifact(root, flags) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st || st.status !== "open") { console.error("workflow: no open task. Run `start` first."); return 2; }
    const kind = String(flags.kind || "");
    const reqs = requiredFor(st.tier);
    const req = reqs.find((r) => r.kind === kind);
    if (!req) {
      console.error(`workflow: '${kind}' is not required by ${st.tier}.`);
      console.error(`  required: ${reqs.map((r) => r.kind).join(', ')}`);
      return 2;
    }
    const path = flags.path ? String(flags.path).trim() : null;
    if (req.requiresPath && !path) {
      console.error(`workflow: ${kind} requires a file path (--path <file>).`);
      return 1;
    }

    if (path) {
      if (!isPathInsideRoot(root, path)) {
        console.error(`workflow: ${kind} -> '${path}' must be a relative path inside project root.`);
        return 1;
      }
      const fullPath = join(root, path);
      if (!existsSync(fullPath)) {
        console.error(`workflow: ${kind} -> '${path}' does not exist on disk.`);
        if (kind === "openspec") console.error(`  create it: openspec new change <name>   then  openspec validate <name>`);
        return 1;
      }
      if (!isRealPathInsideRoot(root, path)) {
        console.error(`workflow: ${kind} -> '${path}' real path must stay inside project root.`);
        return 1;
      }
      const stFile = statSync(fullPath);
      if (kind === "openspec") {
        if (!stFile.isDirectory()) {
          console.error(`workflow: ${kind} -> '${path}' must be a directory.`);
          return 1;
        }
        const entries = readdirSync(fullPath);
        if (entries.length === 0) {
          console.error(`workflow: ${kind} -> directory '${path}' is empty.`);
          return 1;
        }
        for (const entry of entries) {
          const entryPath = join(path, entry);
          if (!isRealPathInsideRoot(root, entryPath)) {
            console.error(`workflow: ${kind} -> entry '${entryPath}' real path must stay inside project root.`);
            return 1;
          }
        }
      } else {
        if (!stFile.isFile()) {
          console.error(`workflow: ${kind} -> '${path}' must be a file.`);
          return 1;
        }
        const body = readFileSync(fullPath, "utf8");
        if (body.trim().length === 0) {
          console.error(`workflow: ${kind} -> '${path}' is empty.`);
          return 1;
        }
        if (req.mustContain && !req.mustContain.test(body)) {
          console.error(`workflow: ${path} does not contain requirement rows (expected ${req.mustContain}).`);
          console.error(`  a manifest lists R01..Rnn, each with the verbatim quote it came from.`);
          return 1;
        }
        if (kind === "interfaces" && body.trim().length < 10) {
          console.error(`workflow: ${kind} -> '${path}' is too short to be a valid interfaces specification.`);
          return 1;
        }
      }
    }
    const detail = flags.detail ? String(flags.detail) : null;

    if (req.minDetail && (!detail || detail.trim().length < req.minDetail)) {
      console.error(`workflow: ${kind} needs a real description (>= ${req.minDetail} chars).`);
      console.error(`  got: ${detail ? JSON.stringify(detail) : "(nothing)"}`);
      console.error(`  record it: --detail "<what you actually did/verified>"`);
      return 1;
    }
    if (req.mustContain && detail && !req.mustContain.test(detail)) {
      console.error(`workflow: ${kind} must state the outcome — expected ${req.mustContain}.`);
      console.error(`  e.g. --detail "ACCEPT: verified X and Y, no gaps"`);
      return 1;
    }

    const record = { at: new Date().toISOString(), path, detail };
    if (kind === "oracle") {
      record.snapshot = scanWorktree(root);
    }
    st.artifacts[kind] = record;
    save(root, st);
    const done = Object.keys(st.artifacts).length;
    logEvent(root, "artifact", `${kind}${flags.detail ? ": " + String(flags.detail).slice(0, 120) : ""}`);
    console.log(`workflow: ${kind} recorded${path ? ` (${path})` : ""} — ${done}/${reqs.length} for ${st.tier}`);
    return 0;
  });
}

function cmdEscalate(root, flags) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st || st.status !== "open") {
      console.error("workflow: no open task to escalate. Run `start` first.");
      return 2;
    }

    const targetTier = String(flags.tier || "").toUpperCase();
    if (!LADDER.includes(targetTier)) {
      console.error(`workflow: --tier must be one of ${LADDER.join(", ")} (got '${flags.tier || ""}')`);
      return 2;
    }

    const currentIdx = LADDER.indexOf(st.tier);
    const targetIdx = LADDER.indexOf(targetTier);

    if (targetIdx <= currentIdx) {
      console.error(`workflow: escalation must be monotonic (cannot escalate from ${st.tier} to ${targetTier}).`);
      return 1;
    }

    const prevTier = st.tier;
    st.tier = targetTier;
    if (!st.artifacts) {
      st.artifacts = {};
    }
    st.artifacts.lane = {
      at: new Date().toISOString(),
      path: null,
      detail: `${targetTier} (escalated from ${prevTier})`,
    };

    st.escalatedAt = new Date().toISOString();
    st.escalations = [
      ...(st.escalations || []),
      { from: prevTier, to: targetTier, at: st.escalatedAt }
    ];

    const budgets = loadBudgets(root);
    const tierBudget = budgets[targetTier] ?? DEFAULT_BUDGETS[targetTier] ?? 45;

    save(root, st);
    logEvent(root, "escalate", `${prevTier} -> ${targetTier} — ${st.task}`);
    console.log(`workflow: task '${st.task}' escalated from ${prevTier} to ${targetTier}`);
    console.log(`  budget: ${tierBudget} tool calls for ${targetTier}`);

    printRemainingArtifacts(targetTier, st);
    return 0;
  });
}

function cmdCheck(root) {
  const st = load(root);
  if (!st) { console.error("workflow: no task state. Run `start --tier <T> --task \"...\"`."); return 1; }
  const { reqs, missing, invalid, ok } = validateArtifacts(root, st);

  console.log(`workflow: ${st.tier} "${st.task}" — ${ok ? "COMPLETE" : "INCOMPLETE"}`);
  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    const isInvalid = invalid.some((inv) => inv.startsWith(`${r.kind}:`));
    console.log(`  ${a && !isInvalid ? "done" : "MISS"} ${r.kind.padEnd(11)} ${a && a.path ? a.path : r.label}`);
  }
  if (!ok) {
    if (missing.length) {
      console.log(`\n${missing.length} artifact(s) missing for ${st.tier}.`);
      for (const m of missing) {
        const r = reqs.find((req) => req.kind === m);
        console.log(`  record it: node workflow.mjs artifact --kind ${m}${r?.path ? " --path <file>" : ""}`);
      }
    }
    if (invalid.length) {
      console.log(`\n${invalid.length} artifact(s) invalid for ${st.tier}:`);
      for (const inv of invalid) console.log(`  - ${inv}`);
    }
    return 1;
  }
  return 0;
}

function cmdStatus(root) {
  const st = load(root);
  if (!st) { console.log("workflow: no active task."); return 0; }
  const reqs = requiredFor(st.tier);
  const budgets = loadBudgets(root);
  const tierBudget = budgets[st.tier] ?? DEFAULT_BUDGETS[st.tier] ?? 45;
  console.log(`task    ${st.task}`);
  console.log(`tier    ${st.tier}`);
  console.log(`status  ${st.status}`);
  console.log(`started ${st.startedAt}`);
  console.log(`budget  ${tierBudget} tool calls for ${st.tier}`);
  if (st.auto) {
    console.log(`auto    enabled (allow: "${st.auto.allow}", maxDiff: ${st.auto.maxDiff})`);
  }
  if (st.autoRefusal) {
    console.log(`autoRefusal ${st.autoRefusal.reason} at ${st.autoRefusal.at}`);
  }
  console.log(`artifacts ${Object.keys(st.artifacts).length}/${reqs.length}`);
  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    console.log(`  ${a ? "+" : "-"} ${r.kind}${a && a.path ? ` (${a.path})` : ""}`);
  }
  return 0;
}


/**
 * Acceptance staleness: verifies full tree content state (tracked + untracked)
 * recorded at acceptance against current tree using SHA-256 content hashes,
 * timestamps, and file existence. Detects modified files even with matching
 * mtime/size or restored timestamps, deleted files, and newly added untracked files.
 */
function findAcceptanceStaleness(root, st) {
  const oracleArtifact = st.artifacts?.oracle;
  const acceptedAt = oracleArtifact?.at;
  if (!acceptedAt) return null;
  const acceptedMs = new Date(acceptedAt).getTime();
  if (Number.isNaN(acceptedMs)) return null;

  const snapshot = oracleArtifact.snapshot;
  const current = scanWorktree(root);

  if (current.isGit) {
    const newer = [];
    const deleted = [];
    const untrackedAdded = [];

    for (const [rel, meta] of Object.entries(current.tracked)) {
      const snap = snapshot?.tracked?.[rel];
      if (snap) {
        if (meta.hash !== snap.hash) {
          newer.push(rel);
        }
      } else {
        const untrackedSnap = snapshot?.untracked?.[rel];
        if (untrackedSnap) {
          if (meta.hash !== untrackedSnap.hash) {
            newer.push(rel);
          }
        } else {
          newer.push(rel);
        }
      }
    }

    if (snapshot && snapshot.tracked) {
      for (const rel of Object.keys(snapshot.tracked)) {
        if (!(rel in current.tracked)) {
          deleted.push(rel);
        }
      }
    }

    if (snapshot && snapshot.untracked) {
      for (const rel of Object.keys(snapshot.untracked)) {
        if (!(rel in current.tracked) && !(rel in current.untracked)) {
          deleted.push(rel);
        }
      }
    }

    for (const [rel, meta] of Object.entries(current.untracked)) {
      const snap = snapshot?.untracked?.[rel];
      if (!snap) {
        untrackedAdded.push(rel);
      } else if (meta.hash !== snap.hash) {
        newer.push(rel);
      }
    }

    const reasons = [];
    if (newer.length > 0) {
      reasons.push(`${newer.length} tracked file(s) changed after the oracle verdict (${acceptedAt}): ${newer.slice(0, 5).join(", ")}`);
    }
    if (deleted.length > 0) {
      reasons.push(`${deleted.length} tracked file(s) deleted after the oracle verdict (${acceptedAt}): ${deleted.slice(0, 5).join(", ")}`);
    }
    if (untrackedAdded.length > 0) {
      reasons.push(`${untrackedAdded.length} untracked source file(s) added after the oracle verdict (${acceptedAt}): ${untrackedAdded.slice(0, 5).join(", ")}`);
    }

    return reasons.length > 0 ? reasons.join("; ") : null;
  }

  // Non-git filesystem inspection
  if (!snapshot || !snapshot.files) {
    const newer = Object.keys(current.files).filter((rel) => current.files[rel].mtimeMs > acceptedMs);
    if (newer.length > 0) {
      return `${newer.length} file(s) changed after the oracle verdict (${acceptedAt}): ${newer.slice(0, 5).join(", ")}`;
    }
    return `cannot verify tree freshness in non-git directory without acceptance snapshot`;
  }

  const newer = [];
  const deleted = [];
  const added = [];

  for (const [rel, snap] of Object.entries(snapshot.files)) {
    if (!(rel in current.files)) {
      deleted.push(rel);
    } else if (current.files[rel].hash !== snap.hash) {
      newer.push(rel);
    }
  }

  for (const rel of Object.keys(current.files)) {
    if (!(rel in snapshot.files)) {
      added.push(rel);
    }
  }

  const reasons = [];
  if (newer.length > 0) {
    reasons.push(`${newer.length} file(s) changed after the oracle verdict (${acceptedAt}): ${newer.slice(0, 5).join(", ")}`);
  }
  if (deleted.length > 0) {
    reasons.push(`${deleted.length} file(s) deleted after the oracle verdict (${acceptedAt}): ${deleted.slice(0, 5).join(", ")}`);
  }
  if (added.length > 0) {
    reasons.push(`${added.length} file(s) added after the oracle verdict (${acceptedAt}): ${added.slice(0, 5).join(", ")}`);
  }

  return reasons.length > 0 ? reasons.join("; ") : null;
}
function cmdClose(root, flags) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st) { console.error("workflow: no task state."); return 2; }

    // Closing twice appends a second metric for the same task: `metrics` then counts
    // one task as two and invents a duration between the two closes.
    if (st.status !== "open") {
      if (st.status === "closed") {
        const restored = reconcileMetrics(root, { lockHeld: true });
        if (restored) {
          console.log(`workflow: task '${st.task}' was closed; recovered missing terminal metric.`);
          return 0;
        }
      }
      console.error(`workflow: task '${st.task}' is '${st.status}' — nothing to close. Run \`start\` for a new task.`);
      return 2;
    }

  if (flags.auto || st.auto) {
    if (flags["diff-lines"] !== undefined) {
      const diffLines = Number(flags["diff-lines"]);
      const cap = st.auto?.maxDiff ?? 20;
      if (Number.isNaN(diffLines) || diffLines > cap) {
        console.error(`workflow: auto close failed — diff lines (${diffLines}) exceed cap of ${cap}`);
        return 1;
      }
    }
  }

  const { missing, invalid } = validateArtifacts(root, st);

  if (missing.length && !flags.force) {
    console.error(`workflow: cannot close ${st.tier} — ${missing.length} artifact(s) missing: ${missing.join(', ')}`);
    console.error(`  finish them, or close with --force --reason "<why>" to record the deviation.`);
    return 1;
  }
  if (missing.length && flags.force && !flags.reason) {
    console.error(`workflow: --force requires --reason "<why the artifact is absent>"`);
    return 1;
  }

  if (invalid.length) {
    console.error(`workflow: cannot close ${st.tier} — retained evidence invalid:\n  ${invalid.join('\n  ')}`);
    return 1;
  }



  // Acceptance staleness: an ACCEPT verdict is evidence only for the tree it was
  // rendered against. Editing code after the oracle ran and then closing is the
  // cheapest way to ship unverified work, so refuse unless the verdict is newer
  // than the last change to a tracked file. `--force --reason` stays the hatch —
  // but it is recorded below, so the override never disappears silently.
  let staleAcceptance = null;
  if (st.artifacts.oracle) {
    staleAcceptance = findAcceptanceStaleness(root, st);
    if (staleAcceptance && !flags.force) {
      console.error(`workflow: cannot close ${st.tier} — acceptance is STALE.`);
      console.error(`  ${staleAcceptance}`);
      console.error(`  re-run the oracle on the current tree, or close with --force --reason "<why>"`);
      return 1;
    }
    if (staleAcceptance && flags.force && !flags.reason) {
      console.error(`workflow: --force requires --reason "<why the stale acceptance is accepted>"`);
      return 1;
    }
  }

  st.status = "closed";
  st.closedAt = new Date().toISOString();
  if (flags["diff-lines"] !== undefined) {
    st.diffLines = Number(flags["diff-lines"]);
  }
  // Deviation record: covers BOTH a missing artifact and an overridden stale
  // acceptance. Leaving the stale case unrecorded made the override invisible in
  // state.json and metrics (`forced: false`), i.e. the cheapest way to ship
  // unverified work left no trace at all.
  const deviation = {};
  if (missing.length && flags.force) {
    deviation.forced = true;
    deviation.reason = String(flags.reason);
    deviation.missing = missing.map((m) => m.kind);
  }
  if (staleAcceptance && flags.force) {
    deviation.forced = true;
    deviation.reason = String(flags.reason);
    deviation.staleAcceptance = staleAcceptance;
  }
  if (deviation.forced) {
    st.deviation = deviation;
    const what = [
      deviation.missing ? `missing ${deviation.missing.join(", ")}` : null,
      deviation.staleAcceptance ? "stale acceptance" : null,
    ].filter(Boolean).join(" + ");
    console.log(`workflow: closed with DEVIATION — ${what} (${deviation.reason})`);
  } else {
    logEvent(root, "close", `${st.tier} — ${st.task}`);
    console.log(`workflow: ${st.tier} task closed, all artifacts present.`);
  }
  const metricRecord = buildMetricRecord(st);
  st.metric = metricRecord;
  save(root, st);
  appendMetric(root, metricRecord);
  return 0;
  });
}
function cmdCheckCi(root, flags) {
  let tier = null;
  if (flags.labels !== undefined) {
    const raw = Array.isArray(flags.labels) ? flags.labels : String(flags.labels).split(/[\s,]+/);
    const matches = raw
      .map((l) => String(l).trim())
      .filter((l) => /^workflow:T[0-3]$/i.test(l))
      .map((l) => l.split(":")[1].toUpperCase());
    if (matches.length === 0) {
      console.error("workflow check-ci: PR missing required workflow tier label (workflow:T0, workflow:T1, workflow:T2, or workflow:T3).");
      return 1;
    }
    if (matches.length > 1) {
      console.error(`workflow check-ci: PR has ${matches.length} workflow tier labels; exactly one is required.`);
      return 1;
    }
    tier = matches[0];
    if (flags.tier && String(flags.tier).toUpperCase() !== tier) {
      console.error(`workflow check-ci: --tier (${flags.tier}) contradicts PR label (${tier}).`);
      return 1;
    }
  } else if (flags.tier) {
    tier = String(flags.tier).toUpperCase();
  }

  if (!tier || !["T0", "T1", "T2", "T3"].includes(tier)) {
    console.error("workflow check-ci: --tier T0|T1|T2|T3 is required.");
    return 1;
  }

  const baseRef = flags["base-ref"] || flags.baseRef || flags["base_ref"] || null;

  if (tier === "T0") {
    if (baseRef) {
      let changedFiles = null;
      try {
        let diffOut = "";
        try {
          diffOut = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
            cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
          });
        } catch {
          diffOut = execFileSync("git", ["diff", "--name-only", `${baseRef}..HEAD`], {
            cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
          });
        }
        changedFiles = diffOut.split("\n")
          .map((f) => f.trim())
          .filter((f) => f && !isExcludedFromSnapshot(f));
      } catch (err) {
        console.error(`workflow check-ci: failed to resolve or diff against base ref '${baseRef}': ${err.message}`);
        return 1;
      }

      if (changedFiles.length > 2) {
        const hasApprovedOverride = Boolean(flags.override || (flags.force && flags.reason));
        if (!hasApprovedOverride) {
          console.error(`workflow check-ci: T0 PR exceeds 1-2 file limit (${changedFiles.length} files changed against ${baseRef}) without approved override:\n  ${changedFiles.slice(0, 5).join("\n  ")}`);
          return 1;
        }
      }
    }
    console.log(`workflow check-ci: tier T0 passed (lean tier).`);
    return 0;
  }

  if (tier === "T1") {
    console.log(`workflow check-ci: tier T1 passed (lean tier).`);
    return 0;
  }

  // T2 and T3 require committed change artifacts
  const changeId = flags.change ? String(flags.change).trim() : null;
  if (!changeId) {
    console.error(`workflow check-ci: --change <id> is required for ${tier}.`);
    return 1;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(changeId)) {
    console.error(`workflow check-ci: invalid change id '${changeId}' (must be alphanumeric slug).`);
    return 1;
  }

  const relChangeDir = join("openspec", "changes", changeId);
  const changeDir = join(root, relChangeDir);
  if (!existsSync(changeDir) || !isRealPathInsideRoot(root, relChangeDir)) {
    console.error(`workflow check-ci: OpenSpec change directory '${changeDir}' does not exist or resolves outside project root.`);
    return 1;
  }

  // 1. Manifest
  const relManifest = join(relChangeDir, "manifest.md");
  const manifestPath = join(changeDir, "manifest.md");
  if (!existsSync(manifestPath) || !isRealPathInsideRoot(root, relManifest)) {
    console.error(`workflow check-ci: missing manifest.md in '${changeDir}' or resolves outside project root.`);
    return 1;
  }
  const manifestBody = readFileSync(manifestPath, "utf8");
  if (!/R\d\d/.test(manifestBody)) {
    console.error(`workflow check-ci: manifest.md in '${changeDir}' must contain requirement rows (R##).`);
    return 1;
  }

  // 2. Proposal (proposal.md)
  const relProposal = join(relChangeDir, "proposal.md");
  const proposalPath = join(changeDir, "proposal.md");
  if (!existsSync(proposalPath) || !isRealPathInsideRoot(root, relProposal) || !statSync(proposalPath).isFile() || readFileSync(proposalPath, "utf8").trim().length === 0) {
    console.error(`workflow check-ci: missing proposal.md in '${changeDir}'.`);
    return 1;
  }

  // 3. Tasks (tasks.md)
  const relTasks = join(relChangeDir, "tasks.md");
  const tasksPath = join(changeDir, "tasks.md");
  if (!existsSync(tasksPath) || !isRealPathInsideRoot(root, relTasks) || !statSync(tasksPath).isFile() || readFileSync(tasksPath, "utf8").trim().length === 0) {
    console.error(`workflow check-ci: missing tasks.md in '${changeDir}'.`);
    return 1;
  }

  // 4. Specs (specs/ directory)
  const relSpecs = join(relChangeDir, "specs");
  const specsDir = join(changeDir, "specs");
  if (!existsSync(specsDir) || !isRealPathInsideRoot(root, relSpecs) || !statSync(specsDir).isDirectory()) {
    console.error(`workflow check-ci: missing specs/ directory in '${changeDir}'.`);
    return 1;
  }
  const specEntries = readdirSync(specsDir);
  if (specEntries.length === 0) {
    console.error(`workflow check-ci: specs/ directory in '${changeDir}' is empty.`);
    return 1;
  }
  for (const entry of specEntries) {
    const relSpecEntry = join(relSpecs, entry);
    if (!isRealPathInsideRoot(root, relSpecEntry)) {
      console.error(`workflow check-ci: spec entry '${entry}' in '${changeDir}' resolves outside project root.`);
      return 1;
    }
  }

  // 5. Interfaces
  const relInterfaces = join(relChangeDir, "interfaces.md");
  const interfacesPath = join(changeDir, "interfaces.md");
  if (!existsSync(interfacesPath) || !isRealPathInsideRoot(root, relInterfaces)) {
    console.error(`workflow check-ci: missing interfaces.md in '${changeDir}' or resolves outside project root.`);
    return 1;
  }
  const interfacesBody = readFileSync(interfacesPath, "utf8");
  if (interfacesBody.trim().length === 0) {
    console.error(`workflow check-ci: interfaces.md in '${changeDir}' is empty.`);
    return 1;
  }

  // 6. Oracle / acceptance evidence
  let oraclePath = null;
  let relOracle = null;
  const entries = readdirSync(changeDir);
  for (const entry of entries) {
    if (/^oracle(-[A-Za-z0-9]+)?\.md$/i.test(entry) || entry.toLowerCase() === "acceptance.md") {
      oraclePath = join(changeDir, entry);
      relOracle = join(relChangeDir, entry);
      break;
    }
  }
  if (!oraclePath || !existsSync(oraclePath) || !isRealPathInsideRoot(root, relOracle)) {
    console.error(`workflow check-ci: missing oracle evidence in '${changeDir}' or resolves outside project root.`);
    return 1;
  }

  const oracleBody = readFileSync(oraclePath, "utf8");
  const isNegated = /\b(?:NOT|NON|UN|CANNOT|NEVER|NO)\s+ACCEPT(?:ED)?\b/i.test(oracleBody) || /\bREJECT(?:ED)?\b/i.test(oracleBody);
  const hasAnchoredPositive = /(?:^|\n)\s*(?:#+\s*)?(?:Verdict:\s*)?ACCEPT(?::|\s|$)/im.test(oracleBody) || /(?:^|\n)\s*\|\s*Verdict\s*\|\s*ACCEPT\b/i.test(oracleBody);
  if (isNegated || !hasAnchoredPositive) {
    console.error(`workflow check-ci: oracle evidence in '${oraclePath}' must state an explicit anchored positive ACCEPT verdict.`);
    return 1;
  }

  // 5. Worktree cleanliness check against post-acceptance changes
  try {
    const gitStatus = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
    });
    const dirty = gitStatus.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith(".workflow") && !l.includes("/.workflow/") && !l.includes(".workflow/"));
    if (dirty.length > 0) {
      console.error(`workflow check-ci: uncommitted changes detected in worktree after acceptance:\n  ${dirty.slice(0, 5).join("\n  ")}`);
      return 1;
    }
  } catch {
    // Non-git environment or git error
  }

  try {
    const oracleRel = relative(root, oraclePath).replace(/\\/g, "/");
    const oracleCommit = execFileSync("git", ["log", "-1", "--format=%H", "--", oracleRel], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
    }).trim();
    if (oracleCommit) {
      const postOracleDiff = execFileSync("git", ["diff", "--name-only", `${oracleCommit}..HEAD`], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
      }).trim();
      if (postOracleDiff) {
        const changedFiles = postOracleDiff.split("\n")
          .map((f) => f.trim())
          .filter((f) => f && !f.startsWith(".workflow/"));
        if (changedFiles.length > 0) {
          console.error(`workflow check-ci: files modified in commits after oracle acceptance (${oracleCommit.slice(0, 8)}):\n  ${changedFiles.slice(0, 5).join("\n  ")}`);
          return 1;
        }
      }
    }
  } catch {
    // If commit history is not available, ignore
  }

  console.log(`workflow check-ci: ${tier} evidence verified for change '${changeId}'.`);
  return 0;
}



/* ---------------------------------------------------------------------- main */

export { suggestTier, loadBudgets, DEFAULT_BUDGETS, cmdStart, cmdSuggest, cmdArtifact, cmdCheck, cmdStatus, cmdEscalate, cmdClose, cmdMetrics, loadMetrics, appendMetric, reconcileMetrics, acquireLock, withStateLock, load, save, parse, cmdCheckCi };

import { fileURLToPath } from "node:url";

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = parse(process.argv.slice(2));
  const root = args.flags.root ? String(args.flags.root) : process.cwd();
  const cmd = args._[0];

  let code;
  switch (cmd) {
    case "start":
      code = cmdStart(root, args.flags);
      // Автозапуск дашборда: только в CLI-режиме (не в тестах и не при программном вызове).
      if (code === 0) autoOpenDashboard(root, args.flags);
      break;
    case "suggest":  code = cmdSuggest(args.flags); break;
    case "artifact": code = cmdArtifact(root, args.flags); break;
    case "check":    code = cmdCheck(root); break;
    case "status":   code = cmdStatus(root); break;
    case "close":    code = cmdClose(root, args.flags); break;
    case "escalate": code = cmdEscalate(root, args.flags); break;
    case "metrics":  code = cmdMetrics(root); break;
    case "check-ci": code = cmdCheckCi(root, args.flags); break;
    default:
      console.log("workflow.mjs — tier enforcement\n");
      console.log("  node workflow.mjs suggest --files a.ts,b.ts [--task \"...\"]");
      console.log("  node workflow.mjs start --tier T2 --task \"add rate limiting\"");
      console.log("  node workflow.mjs start --tier T0 --auto --allow \"src/**\" --max-diff 5");
      console.log("  node workflow.mjs artifact --kind manifest --path openspec/changes/x/manifest.md");
      console.log("  node workflow.mjs check      # exit 1 if the tier's artifacts are missing");
      console.log("  node workflow.mjs status");
      console.log("  node workflow.mjs escalate --tier T2");
      console.log("  node workflow.mjs close [--force --reason \"...\"] [--auto] [--diff-lines N]");
      console.log("  node workflow.mjs metrics [--root .]");
      console.log("\nTiers: T0 lane · T1 +recon · T2 +manifest/openspec/interfaces/oracle · T3 +worktree");
      console.log("  node workflow.mjs check-ci --tier T2 --change <name>");
  }
  process.exit(code);
}
