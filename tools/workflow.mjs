#!/usr/bin/env node
// @ts-nocheck
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
 *   review-run --change ID --role reviewer|oracle --model PROVIDER/MODEL --base-ref BASE
 *          [--product-command JSON_ARGV] [--admission-policy PATH] [--dry-run|--resume-session DIR]
 *   stage-b --change ID --phase before|after --test-cmd COMMAND
 *          [--disposition simplified|lean-already]  freeze Stage-A tests and execute on A/B
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
 *
 * defer: workflow monolithic cli with ci gates | ceiling: 2500 lines | upgrade: split into workflow-ci and workflow-core modules
 */
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { readJsonlSafe } from "./session-log.mjs";
import { isWorkflowPath, isInsideGitRepo, getPorcelainEntries } from "./workflow-shared.mjs";
export { isWorkflowPath, isInsideGitRepo, getPorcelainEntries } from "./workflow-shared.mjs";
import { scanWorktree, isPathInsideRoot, isRealPathInsideRoot, isSecretOrCredentialPath } from "./worktree-snapshot.mjs";
import { printWorkflowHelp as printCoreWorkflowHelp } from "./installation/capabilities.mjs";
import { runWorkspaceCommand } from "./workflow/workspaces.mjs";
import { runClaimCommand } from "./workflow/claims.mjs";
import { doctorLite } from "./doctor-lite.mjs";
import { recordGate } from "./gate-counter.mjs";
function printWorkflowHelp() {
  printCoreWorkflowHelp();
  console.log("  review-run: --admission-policy PATH runs the controlled Node transport; --dry-run reads policy/ledger read-only; --resume-session DIR imports exact evidence.");
  console.log("  brief: --rounds N (default 2, max 5) --manifest PATH [--brief TEXT|PATH] runs interactive briefing rounds.");
  console.log("  settle: --change <name> --yes removes change worktree and branch after acceptance.");
}
const DIR = ".workflow";
const FILE = "state.json";
const BUDGETS_FILE = "budgets.json";
const METRICS_FILE = "metrics.jsonl";
const DEFAULT_BUDGETS = { T0: 10, T1: 25, T2: 45, T3: 45 };
const BUDGET_WARN_RATIO = 0.8;
const BUDGET_WARN_DEFAULT_TOKENS = 200_000;
const BUDGET_WARN_DEFAULT_CALLS = 45;
/* --------------------------------------------------------------------- core & state */

import {
  LADDER,
  ACCEPTANCE_RE,
  REQUIREMENTS,
  requiredFor,
  openspecDirProblems,
  openspecFileProblems,
  runOpenspecValidate,
  validateOpenspecArtifact,
  isChangeScopedKind,
  changeDirOf,
  parsePlanTickets,
  missingPlanDep,
  planCycleFrom,
  validatePlanCoverage,
  validateManifestRows,
  validateArtifacts,
  markOracleVerified,
  createArtifactRecord,
  statePath,
  budgetsPath,
  isPlainObject,
  loadBudgets,
  load,
  save,
  refreshSnapshot,
  assertWorkflowDirOwned,
  appendMetric,
  readMetricsRaw,
  buildMetricRecord,
  reconcileMetrics,
  loadMetrics,
  sleepSync,
  acquireLock,
  withStateLock,
  cmdMetrics,
  logEvent,
  recordAbandonedLane,
  suggestTier,
  cmdSuggest,
  checkExperienceFresh,
  hasValidExperienceLesson,
  findAcceptanceStaleness,
  loadSoftBudgets,
  getSessionConsumption,
  checkHandoffFile,
  resolveSessionFile,
} from "./workflow-core.mjs";
export { ACCEPTANCE_RE, REQUIREMENTS, requiredFor, openspecDirProblems, openspecFileProblems, runOpenspecValidate, validateOpenspecArtifact, isChangeScopedKind, changeDirOf, parsePlanTickets, missingPlanDep, planCycleFrom, validatePlanCoverage, validateManifestRows, validateArtifacts, markOracleVerified, createArtifactRecord };
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
 * Start or reuse the dashboard and report only the URL verified by its own HTTP health
 * probe. Reading dashboard.json here used to publish a stale or hung server's address.
 *
 * R08: the outcome is never silent. Either a live URL is printed, or an explicit
 * "unavailable (<reason>)" line names why. Observability stays best-effort and never
 * changes the workflow command's exit code.
 */
function autoOpenDashboard(root, flags) {
  if (flags && flags["no-dashboard"]) {
    console.log("  dashboard: disabled (--no-dashboard)");
    return { live: false, reason: "disabled" };
  }
  if (process.env.NF_NO_DASHBOARD === "1") {
    console.log("  dashboard: disabled (NF_NO_DASHBOARD=1)");
    return { live: false, reason: "disabled" };
  }
  const dash = join(dirname(fileURLToPath(import.meta.url)), "dashboard.mjs");
  if (!existsSync(dash)) {
    console.error("  dashboard: unavailable (dashboard.mjs missing from this installation)");
    return { live: false, reason: "missing-dashboard-module" };
  }
  const result = spawnSync(process.execPath, [dash, "--ensure", "--root", root], {
    encoding: "utf8",
    timeout: 35000,
    windowsHide: true,
  });
  const url = result.status === 0
    ? result.stdout.match(/Дашборд: (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/)?.[1]
    : null;
  if (!url) {
    const reason = result.error?.code === "ETIMEDOUT"
      ? "probe timed out"
      : result.signal
        ? `terminated by ${result.signal}`
        : (result.stderr.trim().split("\n")[0] || "server did not report a live URL");
    console.error(`  dashboard: unavailable (${reason})`);
    return { live: false, reason };
  }
  if (process.env.PASEO_AGENT_ID || process.env.PASEO_HOME || process.env.PASEO_CLI) {
    console.log(`  dashboard: ${url} — открой во вкладке Paseo: browser_new_tab("${url}")`);
  } else {
    console.log(`  dashboard: ${url} (сервер запущен, открывается в браузере)`);
  }
  return { live: true, url };
}


const ALLOWED_MODES = ["full", "semi", "interview", "manual"];
const ALLOWED_DEPTHS = ["strict", "normal", "deep"];

function cmdStart(root, flags) {
  const doc = doctorLite(root);
  if (!doc.ok) {
    console.error(`workflow doctor-lite WARN: ${doc.warns.join("; ")}`);
  }
  return withStateLock(root, () => {
    reconcileMetrics(root, { lockHeld: true });
    const tier = String(flags.tier || "").toUpperCase();
    if (!LADDER.includes(tier)) {
      console.error(`workflow: --tier must be one of ${LADDER.join(', ')} (got '${flags.tier || ''}')`);
      return 2;
    }

    const mode = flags.mode !== undefined ? String(flags.mode) : "semi";
    if (!ALLOWED_MODES.includes(mode)) {
      console.error(`workflow: --mode must be one of ${ALLOWED_MODES.join(', ')} (got '${flags.mode}')`);
      return 2;
    }

    const depth = flags.depth !== undefined ? String(flags.depth) : "normal";
    if (!ALLOWED_DEPTHS.includes(depth)) {
      console.error(`workflow: --depth must be one of ${ALLOWED_DEPTHS.join(', ')} (got '${flags.depth}')`);
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
            mode,
            depth,
            task: String(flags.task || "(untitled)"),
            startedAt: new Date().toISOString(),
            status: "refused",
            artifacts: {},
          };
        } else {
          st.mode = mode;
          st.depth = depth;
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
        // A lane whose owner died leaves the project permanently blocked and gives no
        // clue why. Report its age so an abandoned lane is distinguishable from a live
        // one; never expire silently — that would hide the interruption.
        const ageMs = Date.now() - new Date(prev.startedAt || 0).getTime();
        const ageHours = Number.isFinite(ageMs) ? ageMs / 36e5 : NaN;
        const ttlHours = Number(flags["ttl-hours"] ?? process.env.WORKFLOW_LANE_TTL_HOURS ?? 12);
        if (Number.isFinite(ageHours) && ageHours >= ttlHours) {
          console.error(`  ABANDONED: open ${ageHours.toFixed(1)}h (TTL ${ttlHours}h) — the owning session likely died.`);
          console.error(`  release it: workflow.mjs close --force --reason "abandoned lane from ${prev.session || 'unknown session'}"`);
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
      mode,
      depth,
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
        replacedTask: { task: prev.task, tier: prev.tier, startedAt: prev.startedAt },
      };
      recordAbandonedLane(root, prev, st, flags.reason);
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



function parseRenamePaths(filePath) {
  const norm = String(filePath || "").replace(/\\/g, "/");
  const b = norm.match(/^(.*?)\{(.*?)\s*=>\s*(.*?)\}(.*)$/);
  if (b) return [(b[1] + b[2] + b[4]).replace(/\/\/+/g, "/"), (b[1] + b[3] + b[4]).replace(/\/\/+/g, "/")];
  const a = norm.match(/^(.*?)\s*=>\s*(.*)$/);
  return a ? [a[1].replace(/\/\/+/g, "/"), a[2].replace(/\/\/+/g, "/")] : [norm];
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
        const propPath = join(fullPath, "proposal.md");
        if (!existsSync(propPath) || !statSync(propPath).isFile() || readFileSync(propPath, "utf8").trim().length === 0) {
          console.error(`workflow: ${kind} -> missing non-empty proposal.md in '${path}'.`);
          return 1;
        }
        const specsPath = join(fullPath, "specs");
        if (!existsSync(specsPath) || !statSync(specsPath).isDirectory() || readdirSync(specsPath).length === 0) {
          console.error(`workflow: ${kind} -> missing non-empty specs/ directory in '${path}'.`);
          return 1;
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
    // `mustContain` describes the ARTIFACT's file body (e.g. a manifest holds R## rows),
    // never the free-text note. Testing the note rejected valid submissions whenever the
    // operator described the work in prose instead of echoing the pattern.
    if (req.minDetail && detail && req.mustContain && /ACCEPT|REJECT/i.test(String(req.mustContain)) && !req.mustContain.test(detail)) {
      console.error(`workflow: ${kind} must state the outcome — expected ${req.mustContain}.`);
      console.error(`  e.g. --detail "ACCEPT: verified X and Y, no gaps"`);
      return 1;
    }
    // For a note whose contract is "acceptance check", the free text IS the artifact:
    // there is no file to test. 39 of 65 historical recon notes listed files and never
    // said how completion would be proven, which is what made the T1 gate decorative.
    if (req.detailMustContain && detail && !req.detailMustContain.test(detail)) {
      console.error(`workflow: ${kind} must name how the work is checked — got no acceptance evidence.`);
      console.error(`  e.g. --detail "files a.mjs,b.mjs; acceptance: node --test tools/tests/x.test.mjs passes"`);
      return 1;
    }

    const record = createArtifactRecord(root, st, kind, path, detail);
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

function recordCheckGate(root, ok) {
  recordGate({ gate: "workflow-check", result: ok ? "pass" : "fail", root });
}

function cmdCheck(root) {
  const doc = doctorLite(root);
  if (!doc.ok) {
    console.error(`workflow doctor-lite WARN: ${doc.warns.join("; ")}`);
  }
  const st = load(root);
  if (!st) { console.error("workflow: no task state. Run `start --tier <T> --task \"...\"`."); return 1; }
  const { reqs, missing, invalid, ok } = validateArtifacts(root, st);

  console.log(`workflow: ${st.tier} "${st.task}" — ${ok ? "COMPLETE" : "INCOMPLETE"}`);
  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    const isInvalid = invalid.some((inv) => inv.startsWith(`${r.kind}:`));
    console.log(`  ${a && !isInvalid ? "done" : "MISS"} ${r.kind.padEnd(11)} ${a && a.path ? a.path : r.label}`);
  }
  recordCheckGate(root, ok);
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


/** Kinds the dashboard colours; anything else is a typo, not a new state. */
const WAIT_KINDS = ["briefing", "spec", "plan", "design", "action", "stop"];

/**
 * Открыть ожидание пользователя: раунд брифинга, ручной гейт, вопрос перед
 * необратимым шагом, условие остановки.
 *
 * Почему это команда, а не догадка агента: дашборд читает `state.waiting` и по нему
 * останавливает счётчик рабочего времени. Без писателя оранжевое состояние и вычет
 * ожидания были недостижимы — поле читалось и никогда не заполнялось.
 */
function cmdAsk(root, flags, positional = []) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st || st.status !== "open") {
      console.error("workflow: no open task to wait on. Run `start` first.");
      return 2;
    }
    const kind = String(positional[0] || "").trim();
    if (!WAIT_KINDS.includes(kind)) {
      console.error(`workflow: ask <${WAIT_KINDS.join("|")}> --note "что ждём, одной строкой"`);
      return 2;
    }
    const note = flags.note ? String(flags.note).trim() : "";
    const nowIso = new Date().toISOString();

    if (!Array.isArray(st.waits)) st.waits = [];
    const open = st.waiting && st.waiting.from ? st.waiting : null;
    if (open && open.kind !== kind) {
      // Смена вида ожидания закрывает прежний интервал: иначе один вопрос
      // поглотил бы другой и вычет времени посчитался бы дважды.
      const ms = Math.max(0, new Date(nowIso).getTime() - new Date(open.from).getTime());
      st.waits.push({ kind: open.kind, from: open.from, to: nowIso, durationMs: ms });
    }
    // Повторный ask того же вида идемпотентен: `from` не сбрасывается, иначе
    // повторное сообщение обнуляло бы время, которое человек уже думает.
    st.waiting = { kind, from: open && open.kind === kind ? open.from : nowIso, note };
    save(root, st);
    logEvent(root, "ask", `${kind}${note ? ": " + note.slice(0, 120) : ""}`);
    console.log(`workflow: waiting for the user (${kind})${note ? ` — ${note}` : ""}`);
    return 0;
  });
}

/** Ответ пришёл: закрыть ожидание и записать интервал в waits. */
function cmdAnswered(root) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st) {
      console.error("workflow: no task state. Run `start` first.");
      return 2;
    }
    const open = st.waiting && st.waiting.from ? st.waiting : null;
    if (!open) {
      // Ответ без открытого ожидания — не ошибка: агент может перестраховаться.
      console.log("workflow: nothing was waiting.");
      return 0;
    }
    const nowIso = new Date().toISOString();
    if (!Array.isArray(st.waits)) st.waits = [];
    const ms = Math.max(0, new Date(nowIso).getTime() - new Date(open.from).getTime());
    st.waits.push({ kind: open.kind, from: open.from, to: nowIso, durationMs: ms });
    delete st.waiting;
    save(root, st);
    logEvent(root, "answered", `${open.kind} after ${Math.round(ms / 1000)}s`);
    console.log(`workflow: answered — ${open.kind} took ${Math.round(ms / 1000)}s of waiting`);
    return 0;
  });
}

function printStatusArtifacts(st, reqs) {
  console.log(`artifacts ${Object.keys(st.artifacts).length}/${reqs.length}`);
  for (const r of reqs) {
    const a = st.artifacts[r.kind];
    console.log(`  ${a ? "+" : "-"} ${r.kind}${a && a.path ? ` (${a.path})` : ""}`);
  }
}

function printStatusCost(root, st, flags, soft) {
  const costUsd = resolveCost(root, st, flags);
  const costLimit = soft.maxCostUsd ?? (typeof st.costBudgetUsd === "number" ? st.costBudgetUsd : undefined);
  const costStr = costUsd !== null ? `$${costUsd}` : "unverified";
  const limitStr = costLimit !== undefined ? `$${costLimit}` : "none";
  const isCostOver = Boolean(costLimit !== undefined && costUsd !== null && costUsd > costLimit);
  console.log(`cost spent/limit: ${costStr}/${limitStr}${isCostOver ? " (overrun)" : ""}`);
  if (isCostOver) {
    console.log(`BUDGET warning: cost overrun (${costStr}/${limitStr})`);
  }
}

function cmdStatus(root, flags = {}) {
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
  if (st.auto) console.log(`auto    enabled (allow: "${st.auto.allow}", maxDiff: ${st.auto.maxDiff})`);
  if (st.autoRefusal) console.log(`autoRefusal ${st.autoRefusal.reason} at ${st.autoRefusal.at}`);
  printStatusArtifacts(st, reqs);
  const soft = loadSoftBudgets(root, st.tier);
  const usage = getSessionConsumption(root, laneScope(st, flags));
  console.log(`budget  consumption ${usage.tokens}/${soft.tokens} tokens, ${usage.calls}/${soft.calls} calls`);
  const tokenRatio = soft.tokens > 0 ? usage.tokens / soft.tokens : 0;
  const callRatio = soft.calls > 0 ? usage.calls / soft.calls : 0;
  if (tokenRatio >= soft.warnRatio || callRatio >= soft.warnRatio) {
    console.log(`BUDGET warning: session approaching soft budget ceiling (${usage.tokens}/${soft.tokens} tokens, ${usage.calls}/${soft.calls} calls)`);
  }
  printStatusCost(root, st, flags, soft);
  return 0;
}

function firstFiniteNumber(...candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractEventCost(ev) {
  const u = ev.message?.usage || ev.data?.usage || ev.usage;
  return firstFiniteNumber(ev.costUsd, u?.totalCost, u?.cost?.total, u?.costUsd);
}

function isEventBefore(ev, sinceMs) {
  if (sinceMs <= 0) return false;
  const at = ev.timestamp || ev.at || ev.time || ev.message?.timestamp;
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) && t < sinceMs;
}

function parseSessionCost(filePath, sinceMs = 0) {
  if (!filePath || !existsSync(filePath)) return null;
  let totalCost = 0;
  let found = false;
  try {
    for (const ev of readJsonlSafe(filePath)) {
      if (!ev || typeof ev !== "object" || isEventBefore(ev, sinceMs)) continue;
      const c = extractEventCost(ev);
      if (c !== null) {
        totalCost += c;
        found = true;
      }
    }
  } catch {}
  return found ? Number(totalCost.toFixed(4)) : null;
}

function resolveCost(root, st, flags = {}) {
  const direct = firstFiniteNumber(
    flags.costUsd, flags.cost,
    st?.costUsd, st?.cost,
    st?.cost?.total_usd, st?.cost?.total,
    st?.usage?.costUsd
  );
  if (direct !== null) return direct;
  const sf = resolveSessionFile(root, laneScope(st, flags));
  const rawSince = flags.sinceMs ?? st?.startedAt;
  const sinceMs = rawSince ? new Date(rawSince).getTime() : 0;
  return parseSessionCost(sf, Number.isFinite(sinceMs) ? sinceMs : 0);
}

/**
 * Usage must be measured from the lane's own start. Counting the whole session made a
 * fresh T0 project inherit a developer's entire history (91M tokens / 494 calls on this
 * host) and refuse every close, including in tests that ran ten tool calls.
 */
function laneScope(st, flags = {}) {
  if (flags.tokens !== undefined || flags.calls !== undefined) return flags;
  if (flags.sinceMs !== undefined) return { ...flags, sinceMs: Number(flags.sinceMs) };
  const startMs = st?.startedAt ? new Date(st.startedAt).getTime() : NaN;
  return { ...flags, sinceMs: Number.isFinite(startMs) ? startMs : 0 };
}

/**
 * Single budget evaluation shared by `close` and `check-budget`, so the gate that
 * blocks and the command that reports can never disagree about the numbers.
 */
function evaluateBudget(root, st, flags = {}) {
  const soft = loadSoftBudgets(root, st.tier);
  const usage = getSessionConsumption(root, laneScope(st, flags));
  const warnTokens = Math.floor(soft.tokens * soft.warnRatio);
  const warnCalls = Math.floor(soft.calls * soft.warnRatio);
  const costUsd = resolveCost(root, st, flags);
  const costLimit = soft.maxCostUsd ?? (typeof st.costBudgetUsd === "number" ? st.costBudgetUsd : undefined);
  const isCostOver = Boolean(costLimit !== undefined && costUsd !== null && costUsd > costLimit);
  const isOver = usage.tokens >= warnTokens || usage.calls >= warnCalls || isCostOver;
  const handoff = isOver ? checkHandoffFile(root, st.startedAt) : null;
  const over = isOver && !handoff?.valid;
  return { soft, usage, warnTokens, warnCalls, costUsd, costLimit, isCostOver, isOver, handoff, over };
}
function formatBudgetCounts({ soft, usage, costUsd, costLimit, isCostOver }) {
  const costStr = costUsd !== null ? `$${costUsd}` : "unverified";
  const limitStr = costLimit !== undefined ? `$${costLimit}` : "none";
  const costText = `cost spent/limit: ${costStr}/${limitStr}${isCostOver ? " (overrun)" : ""}`;
  return `${usage.tokens}/${soft.tokens} tokens, ${usage.calls}/${soft.calls} calls, ${costText}`;
}

function emitCheckBudget(flags, payload, text, isError = false) {
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else if (isError) console.error(text);
  else console.log(text);
}

function cmdCheckBudget(root, flags = {}) {
  const st = load(root);
  if (!st) {
    emitCheckBudget(flags, { ok: false, error: "no active task" }, "workflow check-budget: no active task.", true);
    return 2;
  }
  const evalResult = evaluateBudget(root, st, flags);
  const { soft, usage, warnTokens, warnCalls, costUsd, costLimit, isCostOver, handoff, over } = evalResult;
  const budget = { tokens: soft.tokens, calls: soft.calls, maxCostUsd: soft.maxCostUsd ?? null };
  const threshold = { tokens: warnTokens, calls: warnCalls, ratio: soft.warnRatio, maxCostUsd: costLimit ?? null };
  const counts = formatBudgetCounts(evalResult);
  const consumption = { ...usage, costUsd };
  const costStatus = costUsd === null ? "unverified" : (isCostOver ? "overrun" : "ok");
  if (!over && !handoff) {
    emitCheckBudget(flags, { ok: true, overBudget: false, consumption, budget, threshold, costStatus, message: "under budget threshold" }, `workflow check-budget: under budget threshold (${counts}).`);
    return 0;
  }
  if (handoff?.valid) {
    emitCheckBudget(flags, { ok: true, overBudget: true, consumption, budget, threshold, handoff, costStatus, message: "over budget, valid fresh handoff present" }, `workflow check-budget: over budget threshold (${counts}), but valid fresh .workflow/handoff.md present.`);
    return 0;
  }
  const err = `workflow check-budget: budget threshold exceeded (${counts}). Requires .workflow/handoff.md with РЕШЕНИЯ / ТУПИКИ / ДАЛЬШЕ sections newer than task start (${st.startedAt}). ${handoff?.reason ? `Current handoff state: ${handoff.reason}.` : ""}`.trim();
  emitCheckBudget(flags, { ok: false, overBudget: true, consumption, budget, threshold, handoff, costStatus, error: err }, err, true);
  return 1;
}

/** Close-time budget gate: same evaluation, different refusal message. */
function checkBudgetState(root, st, flags = {}) {
  // flags carries --tokens/--calls: dropping them made the gate ignore an explicitly
  // stated consumption and pass an exhausted lane.
  const evalResult = evaluateBudget(root, { ...st, tier: st.tier }, flags);
  if (!evalResult.over) return 0;
  const counts = formatBudgetCounts(evalResult);
  console.error(`workflow: cannot close ${st.tier} — budget threshold exceeded (${counts}).`);
  console.error(`  write .workflow/handoff.md with РЕШЕНИЯ / ТУПИКИ / ДАЛЬШЕ (${evalResult.handoff?.reason || "missing"}),`);
  console.error(`  or close with --force --reason "<why the budget overrun is accepted>".`);
  logEvent(root, "budget-refusal", `${st.tier} — ${st.task} (${counts})`);
  return 1;
}

function pathMatchesAllow(filePath, pattern) {
  const normPath = filePath.replace(/\\/g, "/");
  const patterns = String(pattern || "").split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
  for (const pat of patterns) {
    const normPat = pat.replace(/\\/g, "/");
    const regexStr = "^" + normPat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/(?<!\.)\*/g, "[^/]*") + "$";
    try {
      if (new RegExp(regexStr).test(normPath)) return true;
    } catch {}
  }
  return false;
}

function measureAutoDiff(root, st) {
  if (!isInsideGitRepo(root)) {
    st.autoSkipReason = "non-git environment; skipped tree diff measurement";
    return { ok: true, isGit: false };
  }
  const porcelain = getPorcelainEntries(root);
  if (!porcelain) return { ok: false, error: "git status failed in git repository" };
  const changedPaths = new Set();
  let totalLines = 0;

  for (const { code, rel } of porcelain) {
    if (code === "??") {
      changedPaths.add(rel);
      try {
        const content = readFileSync(join(root, rel), "utf8");
        totalLines += content.split("\n").length;
      } catch {
        return { ok: false, error: `failed to read untracked file '${rel}'` };
      }
    }
  }

  try {
    const numstatOut = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--numstat", "--relative", "HEAD"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
    });
    for (const line of numstatOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const [addStr, delStr] = parts;
      const file = parts.slice(2).join(trimmed.includes("\t") ? "\t" : " ").trim();
      const paths = parseRenamePaths(file);
      if (paths.every(isWorkflowPath)) continue;
      if (addStr === "-" || delStr === "-") return { ok: false, error: `binary file '${file}' not measurable: binary not measurable` };
      for (const p of paths) if (!isWorkflowPath(p)) changedPaths.add(p);
      totalLines += (Number(addStr) || 0) + (Number(delStr) || 0);
    }
  } catch {
    return { ok: false, error: "git diff failed in git repository" };
  }

  if (st.auto?.allow) {
    for (const p of changedPaths) {
      if (!pathMatchesAllow(p, st.auto.allow)) return { ok: false, error: `changed file '${p}' escapes allow pattern '${st.auto.allow}'` };
    }
  }

  const cap = st.auto?.maxDiff ?? 20;
  if (totalLines > cap) return { ok: false, error: `measured diff lines (${totalLines}) exceed cap of ${cap}` };
  return { ok: true, isGit: true, totalLines };
}

/** Guarded-auto refusal checks, extracted so `cmdClose` stays within its complexity limit. */
function checkAutoClose(root, st, flags) {
  // An explicit --diff-lines is the caller's measurement and short-circuits git: a
  // repository-less or freshly-initialised directory has no HEAD to diff against, and
  // failing there refused a close that already stated its own line count.
  const hasExplicit = flags["diff-lines"] !== undefined;
  const autoCheck = hasExplicit
    ? (() => {
        // Still record why the tree diff was not measured, so a reviewer can tell a
        // caller-supplied count from a verified one instead of trusting the number.
        // Both facts are recorded: whether the directory is a repository at all, and
        // that the number came from the caller rather than from a tree diff.
        st.autoSkipReason = isInsideGitRepo(root)
          ? "non-git environment; skipped tree diff measurement (diff-lines supplied by caller)"
          : "non-git environment; skipped tree diff measurement";
        return { ok: true, isGit: false, totalLines: Number(flags["diff-lines"]) };
      })()
    : measureAutoDiff(root, st);
  if (!autoCheck.ok) {
    console.error(`workflow: auto close failed — ${autoCheck.error}`);
    return 1;
  }
  if (flags["diff-lines"] !== undefined) {
    const diffLines = Number(flags["diff-lines"]);
    const cap = st.auto?.maxDiff ?? 20;
    if (Number.isNaN(diffLines) || diffLines > cap) {
      console.error(`workflow: auto close failed — diff lines (${diffLines}) exceed cap of ${cap}`);
      return 1;
    }
  }
  return 0;
}

import {
  isStageReported,
  checkStageObject,
  extractReportedFromArray,
  extractReportedFromObject,
  hasOracleStage,
  checkUnverifiedOracleArtifact,
  getReportedStages,
  checkStageState,
  recordStage,
  setStageVerified,
  recordGatePass,
  cmdStage,
  cmdGatePass,
  formatDeviationParts,
  buildDeviationRecord,
  applyCloseDeviation,
} from "./workflow-ci.mjs";
function handleNonOpenStatus(root, st) {
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

function enforceForcedGate(hasViolation, flags, msgNoForce, msgNeedReason) {
  if (!hasViolation) return 0;
  if (!flags.force) {
    const msgs = Array.isArray(msgNoForce) ? msgNoForce : [msgNoForce];
    for (const m of msgs) console.error(m);
    return 1;
  }
  if (!flags.reason) {
    console.error(msgNeedReason);
    return 1;
  }
  return 0;
}
function cmdClose(root, flags) {
  const closeResult = withStateLock(root, () => {
    const st = load(root);
    if (!st) { console.error("workflow: no task state."); return 2; }

    // The budget gate existed but nothing called it: a lane could run to 399/45
    // calls and close cleanly. Exhausted budget now refuses the close unless a fresh
    // handoff records where the work stands, or the operator forces with a reason.
    // `--force --reason` stays the hatch, and the deviation is recorded below.
    if (!flags.force) {
      const budgetCode = checkBudgetState(root, st, flags);
      if (budgetCode !== 0) return budgetCode;
    }

    // Closing twice appends a second metric for the same task: `metrics` then counts
    // one task as two and invents a duration between the two closes.
    if (st.status !== "open") return handleNonOpenStatus(root, st);

    if (flags.auto || st.auto) {
      const autoResult = checkAutoClose(root, st, flags);
      if (autoResult !== 0) return autoResult;
    }

    const { missing, invalid } = validateArtifacts(root, st);

    const missingCode = enforceForcedGate(
      missing.length > 0, flags,
      [`workflow: cannot close ${st.tier} — ${missing.length} artifact(s) missing: ${missing.join(', ')}`,
       '  finish them, or close with --force --reason "<why>" to record the deviation.'],
      'workflow: --force requires --reason "<why the artifact is absent>"'
    );
    if (missingCode !== 0) return missingCode;

    const invalidCode = enforceForcedGate(
      invalid.length > 0, flags,
      `workflow: cannot close ${st.tier} — retained evidence invalid:\n  ${invalid.join('\n  ')}`,
      'workflow: --force requires --reason "<why the invalid evidence is accepted>"'
    );
    if (invalidCode !== 0) return invalidCode;

    let staleAcceptance = null;
    if (st.artifacts.oracle) {
      staleAcceptance = findAcceptanceStaleness(root, st);
      const staleCode = enforceForcedGate(
        Boolean(staleAcceptance), flags,
        [`workflow: cannot close ${st.tier} — acceptance is STALE.`, `  ${staleAcceptance}`, '  re-run the oracle on the current tree, or close with --force --reason "<why>"'],
        'workflow: --force requires --reason "<why the stale acceptance is accepted>"'
      );
      if (staleCode !== 0) return staleCode;
    }

    const stageCheck = checkStageState(root, st, flags);
    if (!stageCheck.ok) return stageCheck.exitCode;

    let noExperience = false;
    if (st.tier === "T2" || st.tier === "T3") {
      const exp = checkExperienceFresh(root, st.startedAt);
      if (!exp.ok) {
        const expCode = enforceForcedGate(
          true, flags,
          `workflow: cannot close ${st.tier} — no experience lesson appended (${exp.checked} files checked); append 'cue | lesson | evidence' to .workflow/experience/<domain>.md, or close with --force --reason "<why>"`,
          'workflow: --force requires --reason "<why no lesson was recorded>"'
        );
        if (expCode !== 0) return expCode;
        noExperience = true;
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
  const deviationText = applyCloseDeviation(st, flags, {
    missing, invalid, staleAcceptance, unverifiedStages: stageCheck.unverifiedStages, noExperience,
  });
  if (deviationText) {
    logEvent(root, "close", `${st.tier} — ${st.task} (force: ${flags.reason})`, { forced: true });
    console.log(`workflow: closed with DEVIATION — ${deviationText} (${flags.reason})`);
  } else {
    logEvent(root, "close", `${st.tier} — ${st.task}`);
    console.log(`workflow: ${st.tier} task closed, all artifacts present.`);
  }
  const soft = loadSoftBudgets(root, st.tier);
  if (st.costBudgetUsd === undefined && soft.maxCostUsd !== undefined) {
    st.costBudgetUsd = soft.maxCostUsd;
  }
  if (st.costUsd === undefined) {
    st.costUsd = resolveCost(root, st, flags);
  }
  const metricRecord = buildMetricRecord(st);
  st.metric = metricRecord;
  save(root, st);
  appendMetric(root, metricRecord);
  return 0;
  });
  recordGate({ gate: "workflow-close", result: closeResult === 0 ? "pass" : "fail", root });
  return closeResult;
}
import {
  cmdCheckCi,
  reviewAttempts,
  cmdReviewRun,
  cmdStageB,
  cmdBrief,
  confirmSettle,
  resolveSettleDocTargets,
  resolveSettleGitTargets,
  resolveSettleTargets,
  removeSettleWorktrees,
  removeSettleBranches,
  cmdSettle,
  isProtectedRefName,
  PROTECTED_BRANCH_RE,
} from "./workflow-ci.mjs";
export { checkQualityGates } from "./workflow-ci.mjs";

export function runWorkflowCli(argv = [], options = {}) {
  const args = parse(argv);
  const root = args.flags.root ? String(args.flags.root) : (options.cwd || process.cwd());
  const cmd = args._[0];
  let code;
  switch (cmd) {
    case "workspace": case "integrate": code = runWorkspaceCommand(cmd, root, args.flags, args._.length); break;
    case "claim": case "release": case "context": code = runClaimCommand(cmd, root, args.flags, args._.length); break;
    case "start":
      try {
        code = cmdStart(root, args.flags);
      } catch (err) {
        if (err && /refusing symlinked state dir/.test(err.message || "")) {
          console.error(err.message);
          code = 2;
          break;
        }
        throw err;
      }
      if (code === 0 && !options.noDashboard) autoOpenDashboard(root, args.flags);
      break;
    case "suggest":      code = cmdSuggest(args.flags); break;
    case "artifact":     code = cmdArtifact(root, args.flags); break;
    case "check":        code = cmdCheck(root); break;
    case "status":       code = cmdStatus(root, args.flags); break;
    case "ask":          code = cmdAsk(root, args.flags, args._.slice(1)); break;
    case "answered":     code = cmdAnswered(root, args.flags); break;
    case "check-budget": code = cmdCheckBudget(root, args.flags); break;
    case "close":        code = cmdClose(root, args.flags); break;
    case "escalate":     code = cmdEscalate(root, args.flags); break;
    case "metrics":      code = cmdMetrics(root); break;
    case "check-ci":     code = cmdCheckCi(root, args.flags); break;
    case "review-run":   code = cmdReviewRun(root, args.flags, Math.max(0, args._.length - 1)); break;
    case "stage-b":      code = cmdStageB(root, args.flags); break;
    case "brief":        code = cmdBrief(root, args.flags, options); break;
    case "stage":        code = cmdStage(root, args.flags); break;
    case "gate-pass":    code = cmdGatePass(root, args.flags); break;
    case "settle":       code = cmdSettle(root, { ...args.flags, _: args._ }); break;
    default:
      if (cmd !== undefined) console.error(`workflow: unknown command '${cmd}'\n`);
      printWorkflowHelp();
      code = cmd !== undefined ? 2 : 0;
  }
  return code;
}

/* ---------------------------------------------------------------------- exports and main */

export { suggestTier, loadBudgets, DEFAULT_BUDGETS, BUDGET_WARN_RATIO, BUDGET_WARN_DEFAULT_TOKENS, BUDGET_WARN_DEFAULT_CALLS, cmdStart, cmdArtifact, cmdCheck, cmdStatus, cmdCheckBudget, cmdEscalate, cmdClose, checkExperienceFresh, hasValidExperienceLesson, cmdMetrics, loadMetrics, appendMetric, reconcileMetrics, acquireLock, withStateLock, statePath, budgetsPath, isPlainObject, refreshSnapshot, assertWorkflowDirOwned, readMetricsRaw, buildMetricRecord, sleepSync, load, save, parse, cmdCheckCi, cmdReviewRun, cmdStageB, cmdBrief, printWorkflowHelp, ALLOWED_MODES, ALLOWED_DEPTHS, recordStage, setStageVerified, recordGatePass, getReportedStages, cmdStage, cmdGatePass, cmdSettle, confirmSettle, resolveSettleDocTargets, resolveSettleGitTargets, resolveSettleTargets, removeSettleWorktrees, removeSettleBranches, isProtectedRefName, PROTECTED_BRANCH_RE };

import { fileURLToPath } from "node:url";

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const result = runWorkflowCli(process.argv.slice(2));
  if (result && typeof result.then === "function") {
    result.then((c) => { process.exitCode = typeof c === "number" ? c : 0; });
  } else {
    process.exitCode = result;
  }
}
