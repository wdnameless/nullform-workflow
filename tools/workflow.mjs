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
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";

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
    { kind: "manifest", label: "manifest.md with R## rows + verbatim user quotes", path: "openspec/changes/<name>/manifest.md", mustContain: /R\d\d/ },
    { kind: "openspec", label: "openspec change validated", path: "openspec/changes/<name>" },
    { kind: "interfaces", label: "interfaces.md: boundaries + signatures + owners", path: null, minDetail: 40 },
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
  const tmp = target + ".tmp";
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

function loadMetrics(root) {
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
    });
    child.unref();
    // Порт может отличаться (занят другим проектом) — не выдумываем адрес,
    // а показываем реальный, если рантайм-файл уже есть.
    let url = null;
    try {
      const rt = join(root, '.workflow', 'dashboard.json');
      if (existsSync(rt)) url = JSON.parse(readFileSync(rt, 'utf8')).url;
    } catch {}
    console.log(url ? `  dashboard: ${url}` : "  dashboard: автозапуск фоном (адрес — .workflow/dashboard.json)");
  } catch {
    // молча: наблюдаемость не должна ломать гейт
  }
}

function cmdStart(root, flags) {
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
  if (prev && prev.status === "open" && !flags.force) {
    console.error(`workflow: task '${prev.task}' is already open at ${prev.tier}.`);
    console.error(`  close it first, or pass --force to replace it.`);
    return 2;
  }

  const budgets = loadBudgets(root);
  const tierBudget = budgets[tier] ?? DEFAULT_BUDGETS[tier] ?? 45;

  const st = {
    version: 1,
    tier,
    task: String(flags.task || "(untitled)"),
    startedAt: new Date().toISOString(),
    status: "open",
    // Declaring a lane IS the lane artifact — `start --tier T2` is the act of
    // classifying. Requiring a second command for it would be ceremony.
    artifacts: { lane: { at: new Date().toISOString(), path: null, detail: tier } },
  };
  if (autoConfig) {
    st.auto = autoConfig;
  }
  save(root, st);
  console.log(`workflow: ${tier} task opened — ${st.task}`);
  console.log(`  budget: ${tierBudget} tool calls for ${tier}`);
  if (autoConfig) {
    console.log(`  auto: guarded autonomous mode enabled (allow: "${autoConfig.allow}", max-diff: ${autoConfig.maxDiff})`);
  }
  const reqs = requiredFor(tier).filter((r) => !st.artifacts[r.kind]);
  if (reqs.length) {
    console.log(`  this tier further requires ${reqs.length} artifact(s):`);
    for (const r of reqs) console.log(`    - ${r.kind.padEnd(11)} ${r.label}`);
  } else {
    console.log(`  no further artifacts required at this tier.`);
  }
  return 0;
}


function cmdArtifact(root, flags) {
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
  const path = flags.path ? String(flags.path) : null;
  // A claimed path must exist: "I wrote it" is the claim this exists to reject.
  if (path && !existsSync(join(root, path))) {
    console.error(`workflow: ${kind} -> '${path}' does not exist on disk.`);
    if (kind === "openspec") console.error(`  create it: openspec new change <name>   then  openspec validate <name>`);
    return 1;
  }
  const detail = flags.detail ? String(flags.detail) : null;

  // Evidence floor. Without this, `artifact --kind oracle --detail ok` satisfies a
  // T2 gate and the gate is theatre.
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
  // A manifest without requirement rows is not a manifest.
  if (req.mustContain && path) {
    try {
      const body = readFileSync(join(root, path), "utf8");
      if (!req.mustContain.test(body)) {
        console.error(`workflow: ${path} does not contain requirement rows (expected ${req.mustContain}).`);
        console.error(`  a manifest lists R01..Rnn, each with the verbatim quote it came from.`);
        return 1;
      }
    } catch { /* existence already checked above */ }
  }

  st.artifacts[kind] = { at: new Date().toISOString(), path, detail };
  save(root, st);
  const done = Object.keys(st.artifacts).length;
  console.log(`workflow: ${kind} recorded${path ? ` (${path})` : ""} — ${done}/${reqs.length} for ${st.tier}`);
  return 0;
}

function cmdCheck(root) {
  const st = load(root);
  if (!st) { console.error("workflow: no task state. Run `start --tier <T> --task \"...\"`."); return 1; }
  const reqs = requiredFor(st.tier);
  const missing = reqs.filter((r) => !st.artifacts[r.kind]);
  const ok = missing.length === 0;

  console.log(`workflow: ${st.tier} "${st.task}" — ${ok ? "COMPLETE" : "INCOMPLETE"}`);
  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    console.log(`  ${a ? "done" : "MISS"} ${r.kind.padEnd(11)} ${a && a.path ? a.path : r.label}`);
  }
  if (!ok) {
    console.log(`\n${missing.length} artifact(s) missing for ${st.tier}.`);
    for (const m of missing) console.log(`  record it: node workflow.mjs artifact --kind ${m.kind}${m.path ? " --path <file>" : ""}`);
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


function cmdClose(root, flags) {
  const st = load(root);
  if (!st) { console.error("workflow: no task state."); return 2; }

  // Closing twice appends a second metric for the same task: `metrics` then counts
  // one task as two and invents a duration between the two closes.
  if (st.status !== "open") {
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

  const reqs = requiredFor(st.tier);
  const missing = reqs.filter((r) => !st.artifacts[r.kind]);

  if (missing.length && !flags.force) {
    console.error(`workflow: cannot close ${st.tier} — ${missing.length} artifact(s) missing: ${missing.map((m) => m.kind).join(', ')}`);
    console.error(`  finish them, or close with --force --reason "<why>" to record the deviation.`);
    return 1;
  }
  // A forced close must state a reason: an unexplained deviation is the thing
  // this mechanism exists to make visible.
  if (missing.length && flags.force && !flags.reason) {
    console.error(`workflow: --force requires --reason "<why the artifact is absent>"`);
    return 1;
  }
  st.status = "closed";
  st.closedAt = new Date().toISOString();
  if (flags["diff-lines"] !== undefined) {
    st.diffLines = Number(flags["diff-lines"]);
  }
  if (missing.length) {
    st.deviation = { forced: true, reason: String(flags.reason), missing: missing.map((m) => m.kind) };
    console.log(`workflow: closed with DEVIATION — ${missing.map((m) => m.kind).join(', ')} (${st.deviation.reason})`);
  } else {
    console.log(`workflow: ${st.tier} task closed, all artifacts present.`);
  }
  save(root, st);
  const closedMs = new Date(st.closedAt).getTime();
  const startedMsRaw = st.startedAt ? new Date(st.startedAt).getTime() : NaN;
  const startedMs = Number.isNaN(startedMsRaw) ? closedMs : startedMsRaw;
  const durationMs = Math.max(0, closedMs - startedMs);
  const artifactsCount = st.artifacts ? Object.keys(st.artifacts).length : 0;
  const isForced = Boolean(missing.length && flags.force);
  const metricRecord = {
    task: st.task || "(untitled)",
    tier: st.tier,
    startedAt: st.startedAt || st.closedAt,
    closedAt: st.closedAt,
    durationMs,
    forced: isForced,
    auto: st.auto ?? null,
    artifactsCount,
  };
  appendMetric(root, metricRecord);
  return 0;
}


/* ---------------------------------------------------------------------- main */

export { suggestTier, loadBudgets, DEFAULT_BUDGETS, cmdStart, cmdSuggest, cmdArtifact, cmdCheck, cmdStatus, cmdClose, cmdMetrics, loadMetrics, appendMetric, load, save, parse };

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

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
    case "metrics":  code = cmdMetrics(root); break;
    default:
      console.log("workflow.mjs — tier enforcement\n");
      console.log("  node workflow.mjs suggest --files a.ts,b.ts [--task \"...\"]");
      console.log("  node workflow.mjs start --tier T2 --task \"add rate limiting\"");
      console.log("  node workflow.mjs start --tier T0 --auto --allow \"src/**\" --max-diff 5");
      console.log("  node workflow.mjs artifact --kind manifest --path openspec/changes/x/manifest.md");
      console.log("  node workflow.mjs check      # exit 1 if the tier's artifacts are missing");
      console.log("  node workflow.mjs status");
      console.log("  node workflow.mjs close [--force --reason \"...\"] [--auto] [--diff-lines N]");
      console.log("  node workflow.mjs metrics [--root .]");
      console.log("\nTiers: T0 lane · T1 +recon · T2 +manifest/openspec/interfaces/oracle · T3 +worktree");
  }
  process.exit(code);
}
