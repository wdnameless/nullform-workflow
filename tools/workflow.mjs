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
 *   artifact --kind manifest --path openspec/changes/x/manifest.md
 *   check                            verify the tier's requirements; exit 1 if unmet
 *   status                           what is done / still required
 *   close  [--force --reason "..."]  finish the task
 *
 * TIER REQUIREMENTS (a tier requires everything the tiers below it require)
 *   T0  lane only            — trivial, 1-2 known files
 *   T1  + recon notes        — 3+ files / unfamiliar area
 *   T2  + manifest, openspec change, interfaces, oracle verdict
 *   T3  + worktree isolation — program of work
 *
 * State: .workflow/state.json (gitignored). Exit 0 ok, 1 unmet, 2 cannot run.
 * Zero dependencies. Node 18+ / Bun.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const DIR = ".workflow";
const FILE = "state.json";

/* ------------------------------------------------------------------- ladder */

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

function load(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); }
  catch { return null; }
}

function save(root, st) {
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(st, null, 2));
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

function cmdStart(root, flags) {
  const tier = String(flags.tier || "").toUpperCase();
  if (!LADDER.includes(tier)) {
    console.error(`workflow: --tier must be one of ${LADDER.join(', ')} (got '${flags.tier || ''}')`);
    return 2;
  }
  const prev = load(root);
  if (prev && prev.status === "open" && !flags.force) {
    console.error(`workflow: task '${prev.task}' is already open at ${prev.tier}.`);
    console.error(`  close it first, or pass --force to replace it.`);
    return 2;
  }
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
  save(root, st);
  console.log(`workflow: ${tier} task opened — ${st.task}`);
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
  console.log(`task    ${st.task}`);
  console.log(`tier    ${st.tier}`);
  console.log(`status  ${st.status}`);
  console.log(`started ${st.startedAt}`);
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
  if (missing.length) {
    st.deviation = { forced: true, reason: String(flags.reason), missing: missing.map((m) => m.kind) };
    console.log(`workflow: closed with DEVIATION — ${missing.map((m) => m.kind).join(', ')} (${st.deviation.reason})`);
  } else {
    console.log(`workflow: ${st.tier} task closed, all artifacts present.`);
  }
  save(root, st);
  return 0;
}

/* ---------------------------------------------------------------------- main */

const args = parse(process.argv.slice(2));
const root = args.flags.root ? String(args.flags.root) : process.cwd();
const cmd = args._[0];

let code;
switch (cmd) {
  case "start":    code = cmdStart(root, args.flags); break;
  case "artifact": code = cmdArtifact(root, args.flags); break;
  case "check":    code = cmdCheck(root); break;
  case "status":   code = cmdStatus(root); break;
  case "close":    code = cmdClose(root, args.flags); break;
  default:
    console.log("workflow.mjs — tier enforcement\n");
    console.log("  node workflow.mjs start --tier T2 --task \"add rate limiting\"");
    console.log("  node workflow.mjs artifact --kind manifest --path openspec/changes/x/manifest.md");
    console.log("  node workflow.mjs check      # exit 1 if the tier's artifacts are missing");
    console.log("  node workflow.mjs status");
    console.log("  node workflow.mjs close [--force --reason \"...\"]");
    console.log("\nTiers: T0 lane · T1 +recon · T2 +manifest/openspec/interfaces/oracle · T3 +worktree");
    code = 0;
}
process.exit(code);
