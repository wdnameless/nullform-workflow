#!/usr/bin/env node
/**
 * tools/workflow-core.mjs — shared state, persistence, locking, metrics, session usage, and suggest helpers.
 * Zero external dependencies. Node 18+ / Bun.
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync, lstatSync, statSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, basename, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJsonlSafe } from "./session-log.mjs";
import { scanWorktree, isSecretOrCredentialPath, isPathInsideRoot, isRealPathInsideRoot } from "./worktree-snapshot.mjs";
import { parseRequirement, validateManifestVerify } from "./requirements.mjs";
import { validateOracleArtifact, validateReviewEvidence, isPositiveOracleVerdict } from "./review/evidence.mjs";

export const DIR = ".workflow";
export const FILE = "state.json";
export const BUDGETS_FILE = "budgets.json";
export const METRICS_FILE = "metrics.jsonl";

export const DEFAULT_BUDGETS = { T0: 10, T1: 25, T2: 45, T3: 45 };
export const BUDGET_WARN_RATIO = 0.8;
export const BUDGET_WARN_DEFAULT_TOKENS = 200_000;
export const BUDGET_WARN_DEFAULT_CALLS = 45;

export const LADDER = ["T0", "T1", "T2", "T3"];

export function statePath(root) { return join(root, DIR, FILE); }
export function budgetsPath(root) { return join(root, DIR, BUDGETS_FILE); }

/** Plain object guard: `null`, arrays and scalars are not task state. */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadBudgets(root) {
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

export function load(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    if (!isPlainObject(parsed) || !LADDER.includes(parsed.tier)) return null;
    return {
      mode: parsed.mode || "semi",
      depth: parsed.depth || "normal",
      ...parsed,
      artifacts: isPlainObject(parsed.artifacts) ? parsed.artifacts : {},
    };
  } catch {
    return null;
  }
}

export function assertWorkflowDirOwned(root) {
  const dir = join(root, DIR);
  let st = null;
  try { st = lstatSync(dir); } catch { return; }
  if (st.isSymbolicLink()) throw new Error(`workflow: refusing symlinked state dir: ${dir}`);
}

export function refreshSnapshot(root) {
  if (process.env.NF_NO_DASHBOARD === "1") return;
  import("./dashboard.mjs").then((dash) => {
    try {
      const data = dash.collectDashboardState ? dash.collectDashboardState(root) : null;
      if (data) dash.writeSnapshot(root, data);
    } catch {}
  }).catch(() => {});
}

export function save(root, st) {
  try {
    if (st && typeof st === "object") {
      if (!Array.isArray(st.beats)) st.beats = [];
      st.beats.push(new Date().toISOString());
      if (st.beats.length > 2000) st.beats.splice(0, st.beats.length - 2000);
    }
  } catch {}
  const target = statePath(root);
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  mkdirSync(dirname(target), { recursive: true });
  assertWorkflowDirOwned(root);
  writeFileSync(tmp, JSON.stringify(st, null, 2));
  renameSync(tmp, target);
  refreshSnapshot(root);
}

export function appendMetric(root, record) {
  const p = join(root, DIR, METRICS_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  appendFileSync(p, line, "utf8");
}

export function readMetricsRaw(root) {
  const p = join(root, DIR, METRICS_FILE);
  if (!existsSync(p)) return [];
  const content = readFileSync(p, "utf8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed)) out.push(parsed);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

export function buildMetricRecord(st) {
  const closedMs = new Date(st.closedAt || new Date().toISOString()).getTime();
  const startedMsRaw = st.startedAt ? new Date(st.startedAt).getTime() : NaN;
  const startedMs = Number.isNaN(startedMsRaw) ? closedMs : startedMsRaw;
  const durationMs = Math.max(0, closedMs - startedMs);
  const artifactsCount = st.artifacts ? Object.keys(st.artifacts).length : 0;
  const deviation = st.deviation?.forced ? st.deviation : null;
  const costUsd = typeof st.costUsd === "number" && Number.isFinite(st.costUsd)
    ? st.costUsd
    : (typeof st.cost === "number" && Number.isFinite(st.cost) ? st.cost : null);
  const costBudgetUsd = typeof st.costBudgetUsd === "number" && Number.isFinite(st.costBudgetUsd)
    ? st.costBudgetUsd
    : (typeof st.maxCostUsd === "number" && Number.isFinite(st.maxCostUsd) ? st.maxCostUsd : null);
  const costOverrun = Boolean(costUsd !== null && costBudgetUsd !== null && costUsd > costBudgetUsd);
  const costStatus = costUsd === null ? "unverified" : (costOverrun ? "overrun" : "ok");
  const record = {
    task: st.task || "(untitled)",
    tier: st.tier,
    startedAt: st.startedAt || st.closedAt,
    closedAt: st.closedAt,
    durationMs,
    forced: Boolean(deviation),
    auto: st.auto ?? null,
    artifactsCount,
    costUsd,
    costBudgetUsd,
    costStatus,
    costOverrun,
  };
  if (deviation) {
    record.reason = String(deviation.reason || "(no reason recorded)");
    record.deviationKind = deviation.replacedTask ? "replaced-lane" : "incomplete-close";
  }
  return record;
}

export function reconcileMetrics(root, { lockHeld = false } = {}) {
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

export function loadMetrics(root) {
  reconcileMetrics(root);
  return readMetricsRaw(root);
}

export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

export function acquireLock(root, timeoutMs = 5000, staleMs = 60000) {
  const dir = join(root, DIR);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }
  assertWorkflowDirOwned(root);
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

export function withStateLock(root, fn, options = {}) {
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

export function logEvent(root, kind, text, extra = {}) {
  try {
    const dir = join(root, ".workflow");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    assertWorkflowDirOwned(root);
    const file = join(dir, "events.jsonl");
    const entry = {
      at: new Date().toISOString(),
      kind,
      text,
      ...extra,
    };
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

export function recordAbandonedLane(root, prev, next, reason) {
  const closedAt = new Date();
  appendMetric(root, {
    task: prev.task || "(untitled)",
    tier: prev.tier,
    startedAt: prev.startedAt || closedAt.toISOString(),
    closedAt: closedAt.toISOString(),
    durationMs: Math.max(0, closedAt.getTime() - new Date(prev.startedAt || closedAt).getTime()),
    forced: true,
    reason: `replaced by new task '${next.task}' (${reason})`,
    deviationKind: "abandoned-lane",
    auto: prev.auto ?? null,
    artifactsCount: prev.artifacts ? Object.keys(prev.artifacts).length : 0,
  });
}

export function cmdMetrics(root) {
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

  const forced = list.filter((m) => m.forced);
  if (forced.length) {
    const byReason = new Map();
    for (const m of forced) {
      const reason = String(m.reason || "(reason not recorded)").trim();
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
    const ranked = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
    console.log("Причины force-закрытий:");
    for (const [reason, count] of ranked.slice(0, 10)) {
      console.log(`  ${count}x ${reason.length > 120 ? `${reason.slice(0, 117)}...` : reason}`);
    }
    const repeated = ranked.filter(([, count]) => count > 1);
    if (repeated.length) {
      console.log(`  повторяются: ${repeated.map(([r, c]) => `${c}x "${r.length > 60 ? `${r.slice(0, 57)}...` : r}"`).join("; ")}`);
      console.log("  повтор — сигнал править skill/rule, а не закрывать заново");
    }
  }
  return 0;
}

export const KEYWORDS_T3_EXPLICIT = [
  /(?:несколько фич|множество задач|параллельн|мульти-фич|multi-feature|программа)/i,
];
export const VERB_PAIR_T3 = /\b(?:add|implement|build|create|refactor|добавить|реализовать)\b[\s\S]{0,80}?\b(?:and|plus|и)\b[\s\S]{0,80}?\b(?:add|implement|build|create|refactor|добавить|реализовать)\b/i;

export const KEYWORDS_T2 = [
  /\b(?:schema|migration|database|db|migration|architectur|redesign|refactor-all)\b/i,
  /(?:схема|миграци|архитектур|баз[аы]\s+данных|редизайн)/i,
];

export const KEYWORDS_NEW_DEP_OR_API = [
  /\b(?:dep|dependency|package|npm|install|api|endpoint|contract|breaking)\b/i,
  /(?:зависимост|пакет|эндпоинт|контракт|апи)/i,
];

export function isUnfamiliarDir(file) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)(?:experimental|legacy|vendor|unfamiliar|new-module|external)\//i.test(normalized);
}

export function getTopLevelDir(file) {
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.?\//, "");
  const slashIdx = normalized.indexOf("/");
  if (slashIdx > 0) {
    return normalized.slice(0, slashIdx);
  }
  return normalized ? "." : "";
}

export function extractSignalKeywords(taskStr) {
  if (!taskStr) return [];
  const matched = new Set();
  const lower = taskStr.toLowerCase();

  const t3Literals = [
    "multi-feature", "несколько фич", "множество задач",
    "параллельн", "мульти-фич", "программа",
  ];
  for (const token of t3Literals) {
    if (lower.includes(token)) {
      matched.add(token);
    }
  }
  if (VERB_PAIR_T3.test(taskStr)) {
    matched.add("verb-pair-t3");
  }

  const t2Regexes = [
    /\b(?:schema|migration|database|db|architectur\w*|redesign|refactor-all)\b/gi,
    /(?:схем\w*|миграц\w*|архитектур\w*|баз[аы]\s+данных|редизайн\w*)/gi,
  ];
  for (const re of t2Regexes) {
    const hits = taskStr.match(re);
    if (hits) {
      for (const h of hits) {
        matched.add(h.toLowerCase());
      }
    }
  }

  return [...matched];
}

export function suggestTier({ files = [], task = "" }) {
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

  if (hasT3Kw) {
    tier = "T3";
    matchedRules++;
    reasons.push("задача содержит ключевые слова множественных фич или объединения задач ('and', 'plus', 'несколько фич')");
  }

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

  if (reasons.length === 0) {
    matchedRules++;
    reasons.push("базовое локальное изменение");
  }

  const dirSpread = [...new Set(fileList.map(getTopLevelDir).filter(Boolean))];
  const matchedKeywords = extractSignalKeywords(taskStr);
  const rationale = {
    fileCount: count,
    dirSpread,
    keywords: matchedKeywords,
  };

  const confidence = Number((Math.min(matchedRules, totalRules) / totalRules).toFixed(2));
  return { tier, confidence, reasons, rationale };
}

export function cmdSuggest(flags) {
  const rawFiles = flags.files ? String(flags.files) : "";
  const files = rawFiles ? rawFiles.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const task = flags.task ? String(flags.task) : "";
  const result = suggestTier({ files, task });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

export function loadSoftBudgets(root, tier = null) {
  const p = budgetsPath(root);
  const tierCalls = tier && DEFAULT_BUDGETS[tier] ? DEFAULT_BUDGETS[tier] : BUDGET_WARN_DEFAULT_CALLS;
  const def = { tokens: BUDGET_WARN_DEFAULT_TOKENS, calls: tierCalls, warnRatio: BUDGET_WARN_RATIO, maxCostUsd: undefined };
  if (!existsSync(p)) return def;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    const tierEntry = tier && raw.tiers ? raw.tiers[tier] : undefined;
    const tierOverride = tierEntry && typeof tierEntry.calls === "number" && tierEntry.calls > 0
      ? tierEntry.calls
      : (typeof tierEntry === "number" && tierEntry > 0 && Number.isInteger(tierEntry) ? tierEntry : null);
    const tierCost = typeof tierEntry === "number" && Number.isFinite(tierEntry)
      ? tierEntry
      : (tierEntry && typeof tierEntry.maxCostUsd === "number" && Number.isFinite(tierEntry.maxCostUsd) ? tierEntry.maxCostUsd : undefined);
    const maxCostUsd = typeof tierCost === "number" && Number.isFinite(tierCost)
      ? tierCost
      : (typeof raw.maxCostUsd === "number" && Number.isFinite(raw.maxCostUsd) ? raw.maxCostUsd : undefined);
    return {
      tokens: typeof raw.tokens === "number" && raw.tokens > 0 ? raw.tokens : def.tokens,
      calls: tierOverride ?? (typeof raw.calls === "number" && raw.calls > 0 ? raw.calls : def.calls),
      warnRatio: typeof raw.warnRatio === "number" && raw.warnRatio > 0 ? raw.warnRatio : def.warnRatio,
      maxCostUsd,
    };
  } catch { return def; }
}

export function eventTimeMs(ev) {
  const at = ev.timestamp || ev.at || ev.time || ev.message?.timestamp;
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

export function eventContextSize(ev) {
  const u = ev.message?.usage || ev.data?.usage || ev.usage;
  if (!u) return 0;
  return typeof u.totalTokens === "number"
    ? u.totalTokens
    : (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
}

export function isToolCallEvent(ev) {
  return ev.type === "toolCall" || ev.type === "tool_call" || ev.type === "tool_use";
}

export function eventToolCalls(ev) {
  if (isToolCallEvent(ev)) return 1;
  if (Array.isArray(ev.message?.tool_calls)) return ev.message.tool_calls.length;
  const blk = Array.isArray(ev.message?.content) ? ev.message.content : Array.isArray(ev.content) ? ev.content : null;
  return blk ? blk.filter((b) => b && (b.type === "toolCall" || b.type === "tool_call" || b.type === "tool_use")).length : 0;
}

export function parseSessionUsage(filePath, sinceMs = 0) {
  let tokens = 0, calls = 0;
  for (const ev of readJsonlSafe(filePath)) {
    if (!ev || typeof ev !== "object") continue;
    if (sinceMs > 0) {
      const t = eventTimeMs(ev);
      if (Number.isFinite(t) && t < sinceMs) continue;
    }
    const size = eventContextSize(ev);
    if (size > tokens) tokens = size;
    calls += eventToolCalls(ev);
  }
  return { tokens, calls };
}

export function findJsonlFiles(dir) {
  const out = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...findJsonlFiles(full));
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  } catch {}
  return out;
}

export function findAcceptanceStaleness(root, st) {
  const oracleArtifact = st.artifacts?.oracle;
  const acceptedAt = oracleArtifact?.at;
  if (!acceptedAt) return null;
  const acceptedMs = new Date(acceptedAt).getTime();
  if (Number.isNaN(acceptedMs)) return null;

  const snapshot = oracleArtifact.snapshot;
  const current = scanWorktree(root);

  return current.isGit
    ? findGitStaleness(root, snapshot, current, acceptedAt)
    : findNonGitStaleness(snapshot, current, acceptedAt, acceptedMs);
}

export function findGitStaleness(_root, snapshot, current, acceptedAt) {
  const newer = [];
  const deleted = [];
  const untrackedAdded = [];

  for (const [rel, meta] of Object.entries(current.tracked)) {
    const snap = snapshot?.tracked?.[rel];
    if (snap) {
      if (!meta.isSecret && !snap.isSecret && meta.hash !== snap.hash) {
        newer.push(rel);
      }
    } else {
      const untrackedSnap = snapshot?.untracked?.[rel];
      if (untrackedSnap) {
        if (!meta.isSecret && meta.hash !== untrackedSnap.hash) {
          newer.push(rel);
        }
      } else {
        newer.push(rel);
      }
    }
  }

  if (snapshot && snapshot.tracked) {
    for (const rel of Object.keys(snapshot.tracked)) {
      if (!(rel in current.tracked)) deleted.push(rel);
    }
  }

  if (snapshot && snapshot.untracked) {
    for (const rel of Object.keys(snapshot.untracked)) {
      if (!(rel in current.tracked) && !(rel in current.untracked)) deleted.push(rel);
    }
  }

  for (const [rel, meta] of Object.entries(current.untracked)) {
    const snap = snapshot?.untracked?.[rel];
    if (!snap) {
      if (!isSecretOrCredentialPath(rel)) untrackedAdded.push(rel);
    } else if (!meta.isSecret && meta.hash !== snap.hash) {
      newer.push(rel);
    }
  }

  if (snapshot?.secretDigest !== current.secretDigest) newer.push("tracked credential content");

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

export function findNonGitStaleness(snapshot, current, acceptedAt, acceptedMs) {
  if (!snapshot || !snapshot.files) {
    const newer = Object.keys(current.files).filter((rel) => current.files[rel].mtimeMs > acceptedMs);
    if (newer.length > 0) {
      return `${newer.length} file(s) changed after the oracle verdict (${acceptedAt}): ${newer.slice(0, 5).join(", ")}`;
    }
    return "cannot verify tree freshness in non-git directory without acceptance snapshot";
  }

  const newer = [];
  const deleted = [];
  const added = [];

  for (const [rel, snap] of Object.entries(snapshot.files)) {
    if (!(rel in current.files)) {
      deleted.push(rel);
    } else if (snap.isSecret) {
      if (current.files[rel].mtimeMs !== snap.mtimeMs || current.files[rel].size !== snap.size) {
        newer.push(rel);
      }
    } else if (current.files[rel].hash !== snap.hash) {
      newer.push(rel);
    }
  }
  for (const rel of Object.keys(current.files)) {
    if (!(rel in snapshot.files)) added.push(rel);
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

export function findNewestSessionJsonl(dir) {
  try {
    if (!existsSync(dir)) return null;
    if (statSync(dir).isFile() && dir.endsWith(".jsonl")) return dir;
    const files = findJsonlFiles(dir);
    let newest = null;
    for (const f of files) {
      try {
        const st = statSync(f);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: f, mtimeMs: st.mtimeMs };
      } catch {}
    }
    return newest ? newest.path : null;
  } catch { return null; }
}

export function sessionFileForRoot(root) {
  const fromEnv = process.env.PI_SESSION_FILE || process.env.OMP_SESSION_FILE;
  if (!fromEnv || !existsSync(fromEnv)) return null;
  const declared = declaredCwd(fromEnv);
  return declared && resolve(declared).toLowerCase() === resolve(root).toLowerCase() ? fromEnv : null;
}

export function resolveSessionFile(root, flags = {}) {
  if (flags.sessions) {
    const found = findNewestSessionJsonl(resolve(root, String(flags.sessions)));
    if (found) return found;
  }
  const own = sessionFileForRoot(root);
  if (own) return own;
  for (const d of [join(root, DIR, "sessions"), join(root, "agent", "sessions"), join(root, "sessions")]) {
    const found = findNewestSessionJsonl(d);
    if (found) return found;
  }
  return newestSessionForRoot(join(homedir(), ".omp", "agent", "sessions"), root);
}

export function newestSessionForRoot(dir, root) {
  for (const f of newestFirstSessions(dir)) {
    const declared = declaredCwd(f);
    if (declared && resolve(declared).toLowerCase() !== resolve(root).toLowerCase()) continue;
    return f;
  }
  return null;
}

export function newestFirstSessions(dir) {
  const out = [];
  try {
    if (!existsSync(dir)) return out;
    for (const f of findJsonlFiles(dir)) {
      try { out.push({ path: f, mtimeMs: statSync(f).mtimeMs }); } catch {}
    }
  } catch { return out; }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.path);
}

export function declaredCwd(file) {
  try {
    for (const ev of readJsonlSafe(file)) {
      if (ev && ev.type === "session" && typeof ev.cwd === "string") return ev.cwd;
    }
  } catch {}
  return null;
}

export function getSessionConsumption(root, flags = {}) {
  const t = flags.tokens !== undefined ? Number(flags.tokens) : null;
  const c = flags.calls !== undefined ? Number(flags.calls) : null;
  if (t !== null && !Number.isNaN(t) && c !== null && !Number.isNaN(c)) return { tokens: t, calls: c };
  const sf = resolveSessionFile(root, flags);
  const sinceMs = flags.sinceMs ? Number(flags.sinceMs) : 0;
  const parsed = sf ? parseSessionUsage(sf, Number.isFinite(sinceMs) ? sinceMs : 0) : { tokens: 0, calls: 0 };
  return { tokens: t !== null && !Number.isNaN(t) ? t : parsed.tokens, calls: c !== null && !Number.isNaN(c) ? c : parsed.calls };
}

export function hasValidExperienceLesson(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return text.split(/\r?\n/).some((line) => {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) return false;
    const cue = parts[0].replace(/^[-*]\s*/, "").trim();
    return cue.length > 0 && parts[1].length > 0 && parts[2].length > 0;
  });
}

export function checkExperienceFresh(root, startedAt) {
  try {
    const dir = join(root, DIR, "experience"), files = readdirSync(dir).filter((f) => f.endsWith(".md")), startMs = startedAt ? new Date(startedAt).getTime() : 0;
    return files.some((f) => {
      const st = statSync(join(dir, f), { throwIfNoEntry: false });
      if (!st || st.mtimeMs <= startMs) return false;
      try {
        const text = readFileSync(join(dir, f), "utf8");
        return hasValidExperienceLesson(text);
      } catch { return false; }
    }) ? { ok: true } : { ok: false, checked: files.length };
  } catch { return { ok: false, checked: 0 }; }
}

export function checkHandoffFile(root, startedAt) {
  const p = join(root, DIR, "handoff.md");
  if (!existsSync(p)) return { exists: false, fresh: false, valid: false, path: join(DIR, "handoff.md"), reason: "file missing" };
  try {
    const st = statSync(p);
    const startMs = startedAt ? new Date(startedAt).getTime() : 0;
    const fresh = Number.isFinite(startMs) ? st.mtimeMs > startMs : true;
    if (!fresh) return { exists: true, fresh: false, valid: false, path: join(DIR, "handoff.md"), reason: "stale mtime" };
    const txt = readFileSync(p, "utf8");
    const valid = /РЕШЕНИЯ/i.test(txt) && /ТУПИКИ/i.test(txt) && /ДАЛЬШЕ/i.test(txt);
    return { exists: true, fresh: true, valid, path: join(DIR, "handoff.md"), reason: valid ? null : "missing sections (РЕШЕНИЯ/ТУПИКИ/ДАЛЬШЕ)" };
  } catch (err) { return { exists: true, fresh: false, valid: false, path: join(DIR, "handoff.md"), reason: err.message }; }
}

export const ACCEPTANCE_RE = /(accept|verif|check|prove|proof|proven|test(?:s|ed)?\b|pass(?:es|ed)?\b|green|criteria|criterion|exit\s*code|repro|assert|smoke|suite|\d+\s*\/\s*\d+|провер|приёмк|приемк|критери|тест|готов)/i;

export const REQUIREMENTS = {
  T0: [
    { kind: "lane", label: "lane declared (start --tier)", auto: true },
  ],
  T1: [
    { kind: "recon", label: "recon notes: files touched + acceptance check", path: null, minDetail: 20, detailMustContain: ACCEPTANCE_RE },
  ],
  T2: [
    { kind: "manifest", label: "manifest.md with R## rows + verbatim user quotes", path: "openspec/changes/<name>/manifest.md", requiresPath: true, mustContain: /R\d\d/ },
    { kind: "openspec", label: "openspec change validated", path: "openspec/changes/<name>", requiresPath: true },
    { kind: "interfaces", label: "interfaces.md: boundaries + signatures + owners", path: "openspec/changes/<name>/interfaces.md", requiresPath: true, minDetail: 40 },
    { kind: "oracle", label: "oracle verdict + its reasons", path: null, minDetail: 30, mustContain: /ACCEPT|REJECT/i },
  ],
  T3: [
    { kind: "worktree", label: "isolated worktree per major slice (worktrees.md: slice, path, branch)", path: "openspec/changes/<name>/worktrees.md", requiresPath: true, minDetail: 40, detailMustContain: /worktree/i },
  ],
};

/** Everything required at `tier`, in ladder order. */
export function requiredFor(tier) {
  const upto = LADDER.indexOf(tier);
  if (upto < 0) return [];
  const out = [];
  for (let i = 0; i <= upto; i++) {
    for (const r of REQUIREMENTS[LADDER[i]]) out.push({ ...r, tier: LADDER[i] });
  }
  return out;
}

export function openspecDirProblems(root, a, fullPath) {
  const problems = [];
  if (!statSync(fullPath).isDirectory()) return [`openspec: path '${a.path}' must be a directory`];
  let entries = [];
  try { entries = readdirSync(fullPath); } catch {}
  if (entries.length === 0) return [`openspec: directory '${a.path}' is empty`];
  for (const entry of entries) {
    const entryPath = join(a.path, entry);
    if (!isRealPathInsideRoot(root, entryPath)) return [`openspec: entry '${entryPath}' real path must stay inside project root`];
  }
  return problems;
}

export function openspecFileProblems(a, fullPath) {
  const problems = [];
  const nonEmpty = (p) => existsSync(p) && statSync(p).isFile() && readFileSync(p, "utf8").trim().length > 0;
  if (!nonEmpty(join(fullPath, "proposal.md"))) problems.push(`openspec: missing proposal.md in '${a.path}'`);
  if (!nonEmpty(join(fullPath, "tasks.md"))) problems.push(`openspec: missing tasks.md in '${a.path}'`);
  const specsPath = join(fullPath, "specs");
  if (!existsSync(specsPath) || !statSync(specsPath).isDirectory() || readdirSync(specsPath).length === 0) {
    problems.push(`openspec: missing specs/ directory in '${a.path}'`);
  }
  return problems;
}

export function runOpenspecValidate(root, fullPath) {
  const changeId = basename(fullPath);
  const localCli = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@fission-ai", "openspec", "bin", "openspec.js");
  const res = existsSync(localCli)
    ? spawnSync(process.execPath, [localCli, "validate", changeId, "--strict"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000 })
    : spawnSync("openspec", ["validate", changeId, "--strict"], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000, shell: process.platform === "win32",
      });
  if (res.error) return `openspec: could not run 'openspec validate ${changeId}' (${res.error.code || res.error.message}); the change is UNVERIFIED, not valid`;
  if (res.status !== 0) {
    const detail = `${res.stdout || ""}${res.stderr || ""}`.trim().split(/\r?\n/).filter(Boolean).slice(0, 4).join(" / ");
    return `openspec: '${changeId}' does not validate (${detail || `exit ${res.status}`})`;
  }
  return null;
}

export function validateOpenspecArtifact(root, a, fullPath, invalid) {
  invalid.push(...openspecDirProblems(root, a, fullPath));
  if (invalid.length) return;
  invalid.push(...openspecFileProblems(a, fullPath));
  const tasksPath = join(fullPath, "tasks.md");
  if (existsSync(tasksPath)) {
    const planProblem = validatePlanCoverage(readFileSync(tasksPath, "utf8"));
    if (planProblem) invalid.push(`openspec: tasks.md ${planProblem}`);
  }
  if (invalid.length) return;
  const verdict = runOpenspecValidate(root, fullPath);
  if (verdict) invalid.push(verdict);
}

/** Kinds whose file must live inside the current change directory. */
export function isChangeScopedKind(kind) {
  return kind === "manifest" || kind === "interfaces";
}

/** The change directory recorded for this task, or null when none is bound yet. */
export function changeDirOf(st) {
  const rel = st?.artifacts?.openspec?.path;
  return rel ? String(rel) : null;
}

/**
 * Checks the ticket list in tasks.md for an unstartable plan.
 */
export function parsePlanTickets(tasksBody) {
  const tickets = new Map();
  for (const line of String(tasksBody || "").split(/\r?\n/)) {
    const m = /^\s*-\s*\[[ xX]\]\s*\**(T-\d+)\**/i.exec(line);
    if (!m) continue;
    const deps = /Blocked-by:\s*(.*)$/i.exec(line);
    const raw = deps ? deps[1] : "";
    tickets.set(m[1].toUpperCase(), (raw.match(/T-\d+/gi) || []).map((d) => d.toUpperCase()));
  }
  return tickets;
}

export function missingPlanDep(tickets) {
  for (const [id, deps] of tickets) {
    for (const dep of deps) if (!tickets.has(dep)) return `${id} is blocked by ${dep}, which is not in this plan`;
  }
  return null;
}

export function planCycleFrom(tickets, id) {
  const seen = new Set([id]);
  const stack = [...(tickets.get(id) || [])];
  while (stack.length) {
    const next = stack.pop();
    if (next === id) return `blocked-by cycle: ${id} cannot start`;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(tickets.get(next) || []));
  }
  return null;
}

export function validatePlanCoverage(tasksBody) {
  const tickets = parsePlanTickets(tasksBody);
  if (tickets.size === 0) return null;
  const missing = missingPlanDep(tickets);
  if (missing) return missing;
  for (const id of tickets.keys()) {
    const cycle = planCycleFrom(tickets, id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateManifestRows(body) {
  const rows = String(body || "").split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  const headerRow = rows[0] || "";
  const parsed = rows.map((r) => parseRequirement(r, headerRow)).filter(Boolean);
  if (parsed.length === 0) return "no requirement rows parse (expected | R01 | <verbatim quote> | ... | <status> |)";
  const ids = new Set(parsed.map((r) => r.id));
  if (ids.size !== parsed.length) return "duplicate requirement IDs";
  const verifyProblem = validateManifestVerify(headerRow, rows);
  if (verifyProblem) return verifyProblem;
  for (const row of rows) {
    const req = parseRequirement(row, headerRow);
    if (!req) continue;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    const quote = cells.filter((c) => c !== req.id && !/^(open|in-spec|in-ticket|done|placeholder|deferred|dropped)$/i.test(c));
    if (quote.length === 0 || quote.every((c) => c.length < 3)) {
      return `row '${req.id}' carries no verbatim quote`;
    }
  }
  return null;
}

export function validateArtifacts(root, st) {
  const reqs = requiredFor(st.tier);
  const missing = [];
  const invalid = [];

  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    if (!a) {
      missing.push(r.kind);
      continue;
    }

    if (r.detailMustContain && !r.detailMustContain.test(String(a.detail || ""))) {
      invalid.push(`${r.kind}: note records no acceptance evidence (expected ${r.detailMustContain})`);
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
      if (r.kind === "openspec") {
        validateOpenspecArtifact(root, a, fullPath, invalid);
      } else {
        const s = statSync(fullPath);
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
        const boundChange = changeDirOf(st);
        if (boundChange && isChangeScopedKind(r.kind)) {
          const relFromChange = relative(join(root, boundChange), fullPath).replace(/\\/g, "/");
          if (relFromChange.startsWith("..") || isAbsolute(relFromChange)) {
            invalid.push(`${r.kind}: '${a.path}' belongs to another change, not '${boundChange}'`);
            continue;
          }
        }
        if (r.kind === "manifest") {
          const rowProblem = validateManifestRows(body);
          if (rowProblem) invalid.push(`manifest: ${rowProblem}`);
        }
      }
    }

    if (r.kind === "oracle") {
      validateOracleArtifact(root, a, st, invalid);
      if (st.tier === "T2" || st.tier === "T3") {
        const changeId = st.artifacts?.openspec?.path ? basename(st.artifacts.openspec.path) : null;
        if (changeId) {
          const revRes = validateReviewEvidence({ root, changeId, tier: st.tier });
          if (!revRes.ok) {
            for (const err of revRes.errors) invalid.push(err);
          }
        }
      }
    }
  }

  return { reqs, missing, invalid, ok: missing.length === 0 && invalid.length === 0 };
}

export function markOracleVerified(root, st, path, detail) {
  let isOracleAccept = isPositiveOracleVerdict(detail || "");
  if (!isOracleAccept && path && existsSync(join(root, path))) {
    try {
      isOracleAccept = isPositiveOracleVerdict(readFileSync(join(root, path), "utf8"));
    } catch {}
  }
  if (st.stages) {
    if (isPlainObject(st.stages) && st.stages.oracle) {
      st.stages.oracle = { ...(isPlainObject(st.stages.oracle) ? st.stages.oracle : {}), status: "done", verified: isOracleAccept };
    } else if (Array.isArray(st.stages)) {
      const idx = st.stages.findIndex((s) => (s?.id || s?.name) === "oracle");
      if (idx >= 0) st.stages[idx] = { ...st.stages[idx], status: "done", verified: isOracleAccept };
    }
  }
  return isOracleAccept;
}

export function createArtifactRecord(root, st, kind, path, detail) {
  const verified = kind === "oracle" ? markOracleVerified(root, st, path, detail) : false;
  const record = { at: new Date().toISOString(), path, detail, verified };
  if (kind === "oracle") record.snapshot = scanWorktree(root);
  return record;
}
