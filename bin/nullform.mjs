#!/usr/bin/env node
/**
 * bin/nullform.mjs — NULLFORM WORKFLOW npm CLI (init, doctor, update).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { installHarness, loadHostManifest, discoverCandidates } from "../tools/install-harness.mjs";
import { getDefaultRoot } from '../tools/installation/state.mjs';
import { runDoctor, printHumanReport } from "../tools/doctor.mjs";
import { runWorkflowCli } from "../tools/workflow.mjs";
import { acquireDeploymentLock, DeploymentJournal } from "../tools/installation/journal.mjs";
import { getCapabilitiesInfo, checkVersionAlignment } from "../tools/installation/capabilities.mjs";
import { inspectHarness, resolveHostHome } from "../tools/installation/profiles.mjs";
import { runSetup, runHeal } from "../tools/harness-setup.mjs";
import { probeHarness, defaultRunner } from "../tools/harness-probe.mjs";
import {
  PACKAGE_NAME,
  HARNESS_CHOICES,
  validateSafePath,
  getStateFilePath,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  parseSemVer,
  checkRelease,
  executeUpdate,
  sanitizeError,
  sanitizeResultObject,
} from "../tools/self-update.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PACKAGE_ROOT = resolve(__dirname, "..");

export {
  PACKAGE_NAME,
  HARNESS_CHOICES,
  getStateFilePath,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  sanitizeError,
};

export const HARNESS_MENU_ITEMS = [
  { index: 1, id: "claude", label: "Claude Code", description: "~/.claude/CLAUDE.md" },
  { index: 2, id: "codex", label: "OpenAI Codex", description: "~/.codex/AGENTS.md" },
  { index: 3, id: "opencode", label: "OpenCode", description: "Native configuration and adaptive AGENTS.md" },
  { index: 4, id: "cursor", label: "Cursor", description: "<project>/.cursor/rules/00-workflow.mdc (project-scoped)" },
  { index: 5, id: "omp", label: "Oh My Pi (OMP)", description: "~/.omp/agent & ~/.agents/skills" },
  { index: 6, id: "openclaw", label: "OpenClaw", description: "Native workspace and adaptive AGENTS.md" },
  { index: 7, id: "hermes", label: "Hermes Agent", description: "Selected profile: one native auto-load quality skill" },
  { index: 8, id: "openhuman", label: "OpenHuman", description: "Adaptive AGENTS.md" },
];

export function readPackageVersion(root = PACKAGE_ROOT) {
  validateSafePath(root, "root");
  const versionFile = join(resolve(root), "VERSION");
  if (existsSync(versionFile)) {
    try {
      const raw = readFileSync(versionFile, "utf8").trim();
      const sem = parseSemVer(raw);
      if (sem) return sem.raw;
    } catch (err) {
      throw new Error(`Corrupted VERSION file in ${root}: ${err.message}`);
    }
  }
  const pkgFile = join(resolve(root), "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
      if (typeof pkg.version === "string") {
        const sem = parseSemVer(pkg.version.trim());
        if (sem) return sem.raw;
      }
    } catch (err) {
      throw new Error(`Corrupted package.json in ${root}: ${err.message}`);
    }
  }
  throw new Error(`Package version metadata missing or corrupt in ${root}`);
}

/** Turn node:util parseArgs diagnostics into one-line operator-facing messages. */
function translateParseError(err) {
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const match = err.message.match(/'([^']+)'/);
    return new Error(`Unknown option "${match ? match[1] : ""}"`);
  }
  if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const match = err.message.match(/Option '([^'\s]+)/);
    return new Error(`Missing value for ${match ? match[1] : "option"}`);
  }
  return err;
}

/**
 * Commands that own their flags forward argv verbatim, so there is one parser per
 * surface instead of two that can drift apart. `quality` needs this for --stack,
 * --changed and --baseline; `workflow` has always worked this way.
 */
const PASSTHROUGH = { workflow: "workflowArgs", quality: "qualityArgs" };

const INIT_COMMANDS = ["init", "inspect", "doctor", "update", "capabilities", "evidence", "setup", "heal"];

function resolveInitCommand(positionals) {
  let command = null;
  for (const pos of positionals) {
    if (!INIT_COMMANDS.includes(pos)) throw new Error(`Unknown option or command "${pos}"`);
    if (command && command !== pos) throw new Error(`Unexpected command "${pos}" after "${command}"`);
    command = pos;
  }
  return command;
}

function parseTimeoutMs(raw) {
  if (!raw) return null;
  const val = parseInt(raw, 10);
  if (!Number.isFinite(val) || val <= 0) throw new Error("Invalid --timeout value");
  return val * 1000;
}

export function parseCliArgs(argv = []) {
  const head = Array.isArray(argv) ? argv[0] : undefined;
  if (head && Object.prototype.hasOwnProperty.call(PASSTHROUGH, head)) {
    return { command: head, [PASSTHROUGH[head]]: argv.slice(1), help: false };
  }

  const options = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    yes: { type: "boolean", short: "y" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    probe: { type: "boolean" },
    report: { type: "boolean" },
    "require-plugins": { type: "boolean" },
    "skip-plugin-check": { type: "boolean" },
    "skip-release-check": { type: "boolean" },
    interactive: { type: "boolean" },
    "no-interactive": { type: "boolean" },
    harness: { type: "string" },
    "target-harness": { type: "string" },
    root: { type: "string" },
    "project-root": { type: "string" },
    "user-home": { type: "string" },
    "host-home": { type: "string" },
    "host-manifest": { type: "string" },
    "agents-home": { type: "string" },
    mode: { type: "string" },
    prefix: { type: "string" },
    registry: { type: "string" },
    "api-url": { type: "string" },
    "release-url": { type: "string" },
    timeout: { type: "string" },
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw translateParseError(err);
  }

  const command = resolveInitCommand(parsed.positionals);
  if (parsed.values.probe && command !== "inspect") throw new Error("--probe is inspect-only");
  const timeoutMs = parseTimeoutMs(parsed.values.timeout);

  return {
    command,
    harness: parsed.values.harness || null,
    targetHarness: parsed.values["target-harness"] || null,
    root: parsed.values.root || null,
    projectRoot: parsed.values["project-root"] || null,
    userHome: parsed.values["user-home"] || null,
    hostHome: parsed.values["host-home"] || null,
    hostManifest: parsed.values["host-manifest"] || null,
    agentsHome: parsed.values["agents-home"] || null,
    mode: parsed.values.mode || null,
    prefix: parsed.values.prefix || null,
    registry: parsed.values.registry || null,
    apiUrl: parsed.values["api-url"] || null,
    releaseUrl: parsed.values["release-url"] || null,
    timeoutMs,
    yes: Boolean(parsed.values.yes),
    dryRun: Boolean(parsed.values["dry-run"]),
    force: Boolean(parsed.values.force),
    json: Boolean(parsed.values.json),
    quiet: Boolean(parsed.values.quiet),
    probe: Boolean(parsed.values.probe),
    report: Boolean(parsed.values.report),
    requirePlugins: Boolean(parsed.values["require-plugins"]),
    skipPluginCheck: Boolean(parsed.values["skip-plugin-check"]),
    skipReleaseCheck: Boolean(parsed.values["skip-release-check"]),
    interactive: parsed.values["no-interactive"] ? false : (parsed.values.interactive ?? true),
    help: Boolean(parsed.values.help),
    version: Boolean(parsed.values.version),
  };
}

export const HARNESS_MATRIX_PATH = join(PACKAGE_ROOT, "tools", "harness-matrix.json");

export function loadHarnessMatrix(matrixPath = HARNESS_MATRIX_PATH) {
  try {
    if (!existsSync(matrixPath)) return null;
    const raw = readFileSync(matrixPath, "utf8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "").trim();
    const data = JSON.parse(stripped);
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export function getHarnessMenuItems(matrixPath = HARNESS_MATRIX_PATH) {
  const matrix = (loadHarnessMatrix(matrixPath) || []).filter((e) => e && e.id);
  if (matrix.length === 0) return HARNESS_MENU_ITEMS;
  return matrix.map((entry, index) => ({
    index: index + 1,
    id: entry.id,
    label: entry.label || entry.id,
    description: entry.description || "",
  }));
}

export function resolveMenuSelection(rawInput, items = HARNESS_MENU_ITEMS) {
  if (typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed || trimmed === "q" || trimmed === "quit" || trimmed === "exit" || trimmed === "cancel") {
    return null;
  }
  const list = Array.isArray(items) && items.length > 0 ? items : HARNESS_MENU_ITEMS;
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10);
    if (idx >= 1 && idx <= list.length) {
      return list[idx - 1]?.id || null;
    }
    return null;
  }
  if (HARNESS_CHOICES.includes(trimmed)) {
    return trimmed;
  }
  const found = list.find((it) => it.id.toLowerCase() === trimmed);
  if (found) return found.id;
  return null;
}

function createPromptSession({ input = process.stdin, output = process.stdout, isTTY, idleTimeoutMs = 150 } = {}) {
  const effectiveTTY = isTTY ?? Boolean(input?.isTTY || process.env.NULLFORM_FORCE_TTY === "1");
  const lines = [];
  const waiters = [];
  let closed = false;

  const rl = createInterface({ input, output: effectiveTTY ? output : undefined, terminal: false });
  rl.on("line", (line) => (waiters.length > 0 ? waiters.shift()(line) : lines.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });

  const ask = (promptText) => {
    if (output && typeof output.write === "function") output.write(promptText);
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((res) => {
      let timer = null;
      const done = (val) => { clearTimeout(timer); res(val); };
      if (!effectiveTTY && idleTimeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = waiters.indexOf(done);
          if (idx !== -1) waiters.splice(idx, 1);
          res(null);
        }, idleTimeoutMs);
      }
      waiters.push(done);
    });
  };

  const close = () => { try { rl.close(); } catch {} };
  return { ask, close, isTTY: effectiveTTY };
}

export async function promptHarnessMenu({ session, output = process.stdout, json = false, matrixPath, current } = {}) {
  const ownSession = !session;
  const activeSession = session || createPromptSession({ output });
  const menuItems = getHarnessMenuItems(matrixPath);
  try {
    if (!json && output && typeof output.write === "function") {
      output.write("\nSelect target harness for NULLFORM WORKFLOW:\n");
      for (const item of menuItems) {
        output.write(`  ${item.index}) ${item.id.padEnd(10)} — ${item.label} (${item.description})\n`);
      }
    }
    const defHint = current ? ` [${current}]` : "";
    const answer = await activeSession.ask(`Enter harness number (1-${menuItems.length}) or name${defHint}: `);
    if (typeof answer !== "string") return null;
    const trimmed = answer.trim();
    if (trimmed === "..") return "..";
    if (trimmed === "" && current) return current;
    return resolveMenuSelection(trimmed, menuItems);
  } finally {
    if (ownSession) activeSession.close();
  }
}

function cleanPromptInput(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

export async function promptFlowStep({ session, output = process.stdout, current = "quick" } = {}) {
  if (output && typeof output.write === "function") {
    output.write("\nSelect installation flow:\n");
    output.write("  1) quick    — Standard installation (all slices S0..S4)\n");
    output.write("  2) advanced — Choose individual slices (S0 fixed, S1..S4 toggle)\n");
  }
  const answer = cleanPromptInput(await session.ask(`Enter flow (1=quick, 2=advanced) [${current}]: `));
  if (answer === null || ["q", "quit", "cancel", "n", "no"].includes(answer)) return null;
  if (answer === "..") return "..";
  if (answer === "y" || answer === "yes") return "quick_confirmed";
  if (answer === "2" || answer === "advanced") return "advanced";
  if (answer === "1" || answer === "quick" || answer === "") return "quick";
  return current || "quick";
}

export const SLICES_CATALOG = Object.freeze([
  { id: "S1", num: "1", label: "Quality gates & GATES docs" },
  { id: "S2", num: "2", label: "Agent personas & roles" },
  { id: "S3", num: "3", label: "Harness matrix & installer self" },
  { id: "S4", num: "4", label: "Integration prompt & guide" },
]);

function renderSlicesMenu(output, set) {
  output.write("\nArchitecture slices to install:\n");
  output.write("  [*] S0: Core contracts & lanes (fixed)\n");
  for (const s of SLICES_CATALOG) {
    output.write(`  [${set.has(s.id) ? "x" : " "}] ${s.num}) ${s.id}: ${s.label}\n`);
  }
}

function finalizeSlices(set) {
  return ["S0", ...SLICES_CATALOG.map((s) => s.id).filter((id) => set.has(id))];
}

function applySliceToggle(set, answer) {
  const matches = answer.match(/[1-4]/g) || [];
  for (const m of matches) {
    const id = `S${m}`;
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
}

export async function promptSlicesStep({ session, output = process.stdout, activeSet } = {}) {
  const set = activeSet || new Set(["S0", "S1", "S2", "S3", "S4"]);
  const canWrite = output && typeof output.write === "function";
  while (true) {
    if (canWrite) renderSlicesMenu(output, set);
    const answer = cleanPromptInput(await session.ask("Toggle slice numbers (1-4), 'all', or Enter to accept (.. for back): "));
    if (answer === null || ["q", "quit", "cancel"].includes(answer)) return null;
    if (answer === "..") return "..";
    if (answer === "") return finalizeSlices(set);
    if (answer === "all") return ["S0", "S1", "S2", "S3", "S4"];
    applySliceToggle(set, answer);
  }
}

export async function promptConfirmPlan(plan, { session, output = process.stdout, json = false } = {}) {
  const ownSession = !session;
  const activeSession = session || createPromptSession({ output });
  try {
    if (!json && output && typeof output.write === "function") {
      output.write(`\nInstallation Plan Preview:\n`);
      output.write(`  Harness:      ${plan.harness}\n`);
      if (plan.slices) output.write(`  Slices:       ${plan.slices.join(", ")}\n`);
      output.write(`  Target root:  ${plan.root}\n`);
      if (plan.projectRoot) output.write(`  Project root: ${plan.projectRoot}\n`);
      output.write(`  User home:    ${plan.userHome}\n`);
      output.write(`  Core files:   ${plan.filesToCopy.length}\n`);
      output.write(`  Adapters:     ${plan.adapters.length}\n`);
      for (const a of plan.adapters) output.write(`    - ${a}\n`);
      const removals = plan.replacedModules || [];
      output.write(`  Removals:     ${removals.length}\n`);
      for (const r of removals) output.write(`    - ${r}\n`);
    }
    const answer = await activeSession.ask("Proceed with installation? [y/N] (.. for back): ");
    if (typeof answer !== "string") return false;
    const norm = answer.trim().toLowerCase();
    if (norm === "..") return "..";
    return norm === "y" || norm === "yes";
  } finally {
    if (ownSession) activeSession.close();
  }
}

function summarizeDoctorReadiness(res) {
  const checks = Array.isArray(res?.checks) ? res.checks : [];
  if (checks.some((c) => c.divergence === "pending" || c.status === "pending" || c.pending)) return "pending";
  if (checks.some((c) => c.divergence === "recoverable" || c.status === "recoverable" || c.recoverable)) return "recoverable";
  if (!res?.ok || checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "setup")) return "setup";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ready";
}

function resolveUserHomePath(options, env = process.env) {
  const raw = options.userHome || env.NULLFORM_USER_HOME || env.USERPROFILE || env.HOME || homedir();
  validateSafePath(raw, "userHome");
  return resolve(raw);
}

function loadUserState(options, env) {
  const userHome = resolveUserHomePath(options, env);
  if (options.root) validateSafePath(options.root, "root");
  if (options.projectRoot) validateSafePath(options.projectRoot, "projectRoot");
  return { userHome, state: readInstallationState(userHome) };
}
function emitJsonOrText(output, errOut, isJson, payload, textMsg, toStderr = true) {
  const safeMsg = typeof textMsg === "string" ? sanitizeError(textMsg) : textMsg;
  const safePayload = payload && typeof payload === "object"
    ? Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [
          k,
          typeof v === "string" ? sanitizeError(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? sanitizeError(x) : x)) : v,
        ])
      )
    : payload;
  if (isJson) output.write(JSON.stringify(safePayload, null, 2) + "\n");
  else if (toStderr) errOut.write(safeMsg);
  else output.write(safeMsg);
}

const OPTIONAL_PLAN_FIELDS = ["projectRoot", "hostHome", "hostManifest", "profile", "activation", "slices", "flow"];

const compactInstallationPlan = (plan) => {
  if (!plan) return null;
  const out = { harness: plan.harness, root: plan.root, userHome: plan.userHome,
    dryRun: Boolean(plan.dryRun),
    filesCount: Array.isArray(plan.filesToCopy) ? plan.filesToCopy.length : 0,
    managedFilesCount: plan.managedFiles ? Object.keys(plan.managedFiles).length : 0,
    adapters: plan.adapters || [] };
  for (const f of OPTIONAL_PLAN_FIELDS) if (plan[f]) out[f] = plan[f];
  if (plan.warnings?.length) out.warnings = plan.warnings;
  if (plan.replacedModules?.length) out.replacedModules = plan.replacedModules;
  if (plan.preservedAssets?.count) out.preservedAssets = plan.preservedAssets;
  if (plan.baselineRecorded !== undefined) out.baselineRecorded = plan.baselineRecorded;
  return out;
};

function printInitSuccess(output, options, { ok, readiness, selectedHarness, savedState, statePath, plan, doctorResult }) {
  if (options.json) {
    const payload = {
      ok,
      stage: ok ? "complete" : "doctor",
      status: readiness,
      readiness,
      harness: selectedHarness,
      root: savedState.root,
      ...(savedState.projectRoot ? { projectRoot: savedState.projectRoot } : {}),
      userHome: savedState.userHome,
      ...(plan.hostHome ? { hostHome: plan.hostHome } : {}),
      ...(plan.hostManifest ? { hostManifest: plan.hostManifest } : {}),
      ...(plan.profile ? { profile: plan.profile } : {}),
      ...(plan.activation ? { activation: plan.activation } : {}),
      ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
      version: savedState.version,
      statePath,
      plan: compactInstallationPlan(plan),
      doctor: doctorResult,
    };
    output.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (ok) {
    output.write(`\n=== NULLFORM WORKFLOW Initialized ===\n  Harness:    ${selectedHarness}\n  Root:       ${savedState.root}\n`);
    if (savedState.projectRoot) output.write(`  Project:    ${savedState.projectRoot}\n`);
    output.write(`  State file: ${statePath}\n  Version:    v${savedState.version}\n`);
  } else {
    output.write(`\n=== NULLFORM WORKFLOW Initialization Failed (Doctor) ===\n  Harness:    ${selectedHarness}\n  Root:       ${savedState.root}\n`);
    if (savedState.projectRoot) output.write(`  Project:    ${savedState.projectRoot}\n`);
  }
  for (const c of doctorResult.checks || []) {
    if (c.status === "setup" || c.status === "warn" || c.status === "fail") {
      output.write(`  [${c.status.toUpperCase()}] ${c.id}: ${c.detail}\n`);
    }
  }
  const label = readiness === "setup" || readiness === "warn" ? `SETUP / host configuration needed (${readiness.toUpperCase()})` : readiness === "ready" ? "READY" : "FAIL";
  output.write(`  Readiness:  ${label}\n`);
}

function formatDryRunPreview(previewPlan) {
  return [
    `[dry-run] Plan for NULLFORM WORKFLOW (${previewPlan.harness}):`,
    `  Root:         ${previewPlan.root}`,
    ...(previewPlan.projectRoot ? [`  Project root: ${previewPlan.projectRoot}`] : []),
    `  User home:    ${previewPlan.userHome}`,
    `  Files:        ${previewPlan.filesToCopy.length}`,
    ...previewPlan.adapters.map((a) => `  Adapter:      ${a}`),
    `  Removals:     ${(previewPlan.replacedModules || []).length}`,
    ...(previewPlan.replacedModules || []).map((r) => `  Remove:       ${r}`),
    ...(previewPlan.slices ? [`  Slices:       ${previewPlan.slices.join(", ")}`] : []),
    ...(previewPlan.preservedAssets?.count ? [`  [WARN] preserved-assets: ${previewPlan.preservedAssets.count} preserved. ${previewPlan.preservedAssets.detail}`] : []),
  ].join("\n") + "\n";
}

function resolveInstallPaths({ options, existingState, userHome, selectedHarness }) {
  const isSameHarness = Boolean(existingState && existingState.harness === selectedHarness);
  const targetRoot = options.root ? resolve(options.root)
    : isSameHarness && existingState.root ? resolve(existingState.root)
    : getDefaultRoot(selectedHarness, userHome, {});
  const projectRoot = options.projectRoot ? resolve(options.projectRoot)
    : isSameHarness && existingState.projectRoot ? resolve(existingState.projectRoot)
    : selectedHarness === "cursor" ? resolve(process.cwd()) : null;
  return { isSameHarness, targetRoot, projectRoot };
}

async function repickFlow(wizardState, session, output) {
  const fRes = await promptFlowStep({ session, output, current: wizardState.flow });
  if (!fRes || fRes === "..") return 1;
  wizardState.flow = fRes;
  return 0;
}

async function repickSlices(wizardState, session, output) {
  const sRes = await promptSlicesStep({ session, output, activeSet: wizardState.activeSet });
  if (!sRes || sRes === "..") return 1;
  wizardState.slices = sRes;
  return 0;
}

async function stepBackFromConfirm(wizardState, session, output) {
  if (wizardState.flow === "advanced") {
    const sRes = await promptSlicesStep({ session, output, activeSet: wizardState.activeSet });
    if (!sRes) return 1;
    if (sRes === "..") { if (await repickFlow(wizardState, session, output)) return 1; }
    else wizardState.slices = sRes;
  } else if (await repickFlow(wizardState, session, output)) return 1;
  if (wizardState.flow === "advanced" && !wizardState.slices) {
    if (await repickSlices(wizardState, session, output)) return 1;
  } else if (wizardState.flow === "quick") wizardState.slices = ["S0", "S1", "S2", "S3", "S4"];
  return 0;
}

function buildPreviewPlan(ctx, wizardState, paths) {
  const { options, existingState, userHome, env, installFn } = ctx;
  const selectedHarness = wizardState.harness;
  const { isSameHarness, targetRoot, projectRoot } = resolveInstallPaths({ options, existingState, userHome, selectedHarness });
  paths.targetRoot = targetRoot;
  paths.projectRoot = projectRoot;
  paths.profileOptions = {
    hostHome: options.hostHome || (isSameHarness ? existingState.hostHome : undefined),
    hostManifest: options.hostManifest || (isSameHarness ? existingState.hostManifest : undefined),
    env,
  };
  paths.priorManaged = isSameHarness && existingState?.managedFiles ? existingState.managedFiles : undefined;
  const plan = installFn({ harness: selectedHarness, root: targetRoot, ...(projectRoot ? { projectRoot } : {}),
    userHome, dryRun: true, ...(paths.priorManaged ? { managedFiles: paths.priorManaged } : {}),
    recover: !options.dryRun, slices: wizardState.slices, flow: wizardState.flow, ...paths.profileOptions });
  plan.slices = wizardState.slices;
  plan.flow = wizardState.flow;
  if (!options.dryRun) {
    const restored = readInstallationState(userHome);
    paths.priorManaged = restored?.harness === selectedHarness && resolve(restored.root) === resolve(targetRoot) ? restored.managedFiles : undefined;
  }
  return plan;
}

async function runPreviewLoop({ options, existingState, userHome, env, session, output, errOut, installFn, wizardState, paths, isHeadless }) {
  const ctx = { options, existingState, userHome, env, installFn };
  while (true) {
    let plan;
    try {
      plan = buildPreviewPlan(ctx, wizardState, paths);
    } catch (err) {
      const safeMsg = sanitizeError(err.message);
      emitJsonOrText(output, errOut, options.json, { ok: false, stage: "preflight", error: "install_failed", detail: safeMsg }, `Error: ${safeMsg}\n`);
      return { error: 1 };
    }
    const exit = await settlePreview(plan, { options, session, output, errOut, wizardState, isHeadless });
    if (exit) return exit;
  }
}

async function settlePreview(plan, { options, session, output, errOut, wizardState, isHeadless }) {
  if (options.dryRun) {
    emitJsonOrText(output, errOut, options.json, { ok: true, ...compactInstallationPlan(plan) }, formatDryRunPreview(plan), false);
    return { plan, preview: true };
  }
  if (isHeadless) {
    // Headless+--yes proceeds to the final payload below: emitting the preview
    // here would print two JSON documents on --json stdout (smoke parses one).
    if (!options.yes) {
      emitJsonOrText(output, errOut, options.json, { ok: true, ...compactInstallationPlan(plan) }, formatDryRunPreview(plan), false);
      return { error: 1 };
    }
    return { plan, headless: true };
  }
  if (options.yes || wizardState.preConfirmed) return { plan };
  const confirmed = await promptConfirmPlan(plan, { session, output, json: options.json });
  if (confirmed === true) return { plan };
  if (confirmed !== "..") {
    emitJsonOrText(output, errOut, options.json, { ok: false, cancelled: true, error: "cancelled", detail: "Installation cancelled by operator." }, "Installation cancelled by operator.\n");
    return { error: 1 };
  }
  if (await stepBackFromConfirm(wizardState, session, output)) return { error: 1 };
  return null;
}

function resolveInitialHarness({ options, existingState, userHome, projectRoot, env, isHeadless, output, errOut }) {
  if (options.harness !== null && options.harness !== undefined) {
    if (!HARNESS_CHOICES.includes(options.harness)) {
      const msg = `Invalid --harness "${options.harness}". Choose one of: ${HARNESS_CHOICES.join(", ")}`;
      emitJsonOrText(output, errOut, options.json, { ok: false, error: "invalid_harness", detail: msg }, `Error: ${msg}\n`);
      return { error: 2 };
    }
    return { harness: options.harness, fixed: true };
  }
  if (existingState?.harness && HARNESS_CHOICES.includes(existingState.harness)) {
    return { harness: existingState.harness, fixed: false };
  }
  const candidates = discoverCandidates({ userHome, projectRoot, env });
  if (candidates.length === 1) {
    return { harness: candidates[0], fixed: false };
  }
  if (isHeadless) {
    if (candidates.length > 1) {
      const msg = `Multiple candidate harnesses detected (${candidates.join(", ")}). Specify --harness <name> to proceed. Choose one of: ${HARNESS_CHOICES.join(", ")}`;
      emitJsonOrText(output, errOut, options.json, { ok: false, error: "ambiguous_harness", candidates, detail: msg }, `Error: ${msg}\n`);
      return { error: 2 };
    }
    const msg = `No supported harness detected. Specify --harness <name> to proceed. Choose one of: ${HARNESS_CHOICES.join(", ")}`;
      emitJsonOrText(output, errOut, options.json, { ok: false, error: "missing_harness", detail: msg }, `Error: ${msg}\n`);
    return { error: 2 };
  }
  return { harness: null, fixed: false };
}

async function runHarnessStep(w, ctx) {
  const choice = await promptHarnessMenu({ session: ctx.session, output: ctx.output, json: ctx.json, current: w.harness });
  if (!choice || choice === "..") return { error: 1 };
  w.harness = choice;
  return { next: "FLOW" };
}

async function runFlowStep(w, ctx) {
  const flowRes = await promptFlowStep({ session: ctx.session, output: ctx.output, current: w.flow });
  if (flowRes === null) return { error: 1 };
  if (flowRes === "..") return { next: ctx.fixedHarness ? "FLOW" : "HARNESS" };
  if (flowRes === "quick_confirmed") { w.flow = "quick"; w.preConfirmed = true; return { next: "DONE" }; }
  w.flow = flowRes;
  return { next: w.flow === "advanced" ? "SLICES" : "DONE" };
}

async function runSlicesStep(w, ctx) {
  const slicesRes = await promptSlicesStep({ session: ctx.session, output: ctx.output, activeSet: w.activeSet });
  if (slicesRes === null) return { error: 1 };
  return { next: slicesRes === ".." ? "FLOW" : "DONE" };
}

const WIZARD_STEPS = { HARNESS: runHarnessStep, FLOW: runFlowStep, SLICES: runSlicesStep };

async function runInteractiveWizard({ initialHarness, fixedHarness, session, output, json }) {
  const w = { harness: initialHarness, flow: "quick", activeSet: new Set(["S0", "S1", "S2", "S3", "S4"]), preConfirmed: false };
  const ctx = { fixedHarness, session, output, json };
  let step = w.harness ? "FLOW" : "HARNESS";
  while (step !== "DONE") {
    const res = await WIZARD_STEPS[step](w, ctx);
    if (res.error) return res;
    step = res.next;
  }
  const slices = w.flow === "quick"
    ? ["S0", "S1", "S2", "S3", "S4"]
    : ["S0", ...SLICES_CATALOG.map((s) => s.id).filter((id) => w.activeSet.has(id))];
  return { harness: w.harness, flow: w.flow, slices, preConfirmed: w.preConfirmed, activeSet: w.activeSet };
}

export async function runInit(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const installFn = deps.installHarness || installHarness;
  const doctorFn = deps.runDoctor || runDoctor;

  let userHome, existingState = null;
  try {
    const loaded = loadUserState(options, env);
    userHome = loaded.userHome;
    existingState = loaded.state;
  } catch (err) {
    const safeMsg = sanitizeError(err.message);
    emitJsonOrText(output, errOut, options.json, { ok: false, error: "invalid_state", detail: safeMsg }, `Error: ${safeMsg}\n`);
    return 1;
  }

  const session = createPromptSession({ input: deps.stdin || process.stdin, output: options.json ? null : output, isTTY: deps.isTTY });
  try {
    const isHeadless = Boolean(options.interactive === false || !session?.isTTY);
    const initialRes = resolveInitialHarness({
      options, existingState, userHome, projectRoot: options.projectRoot, env, isHeadless, output, errOut,
    });
    if (initialRes.error) return initialRes.error;

    let wizardState;
    if (isHeadless) {
      wizardState = {
        harness: initialRes.harness,
        flow: "quick",
        slices: ["S0", "S1", "S2", "S3", "S4"],
        preConfirmed: false,
        isHeadless: true,
      };
    } else {
      wizardState = await runInteractiveWizard({
        initialHarness: initialRes.harness,
        fixedHarness: initialRes.fixed,
        session,
        output,
        json: options.json,
      });
      if (wizardState.error) {
        emitJsonOrText(output, errOut, options.json, { ok: false, cancelled: true, error: "cancelled", detail: "Interactive selection cancelled." }, "Installation cancelled by operator.\n");
        return wizardState.error;
      }
    }

    const paths = { targetRoot: null, projectRoot: null, profileOptions: null, priorManaged: undefined };
    const preview = await runPreviewLoop({ options, existingState, userHome, env, session, output, errOut, installFn, wizardState, paths, isHeadless });
    if (preview.error) return preview.error;
    if (preview.preview) return 0;
    let previewPlan = preview.plan;


    const selectedHarness = wizardState.harness;
    const { targetRoot, projectRoot, profileOptions, priorManaged } = paths;
    previewPlan.slices = wizardState.slices;
    let plan = null;
    let lock = null;
    let journal = null;
    try {
      lock = acquireDeploymentLock({ userHome, targetRoot, projectRoot, hostHome: previewPlan.hostHome, harness: selectedHarness });
      journal = new DeploymentJournal({
        userHome,
        targetRoot,
        projectRoot,
        harness: selectedHarness,
        targetVersion: readPackageVersion(PACKAGE_ROOT),
        hostHome: previewPlan.hostHome,
      });
      journal.start();

      plan = installFn({
        harness: selectedHarness, root: targetRoot, ...(projectRoot ? { projectRoot } : {}),
        userHome, dryRun: false, ...(priorManaged ? { managedFiles: priorManaged } : {}),
        ...profileOptions, hostHome: previewPlan.hostHome || profileOptions.hostHome,
        slices: wizardState.slices, flow: wizardState.flow,
        lock, journal, deferLock: true,
      });
    } catch (err) {
      if (journal) journal.rollback(err.message);
      if (lock) lock.release();
      const safeMsg = sanitizeError(err.message);
      emitJsonOrText(output, errOut, options.json, { ok: false, stage: "install", error: "install_failed", detail: safeMsg }, `Error: ${safeMsg}\n`);
      return 1;
    }

    try {
      const finalProjectRoot = plan.projectRoot || projectRoot;
      const doctorResult = doctorFn({
        harness: resolve(plan.root || targetRoot),
        targetHarness: selectedHarness,
        ...(finalProjectRoot ? { projectRoot: resolve(finalProjectRoot) } : {}),
        userHome,
        hostHome: plan.hostHome, hostManifest: plan.hostManifest, env,
        ...(selectedHarness === "omp" ? { agentDir: plan.hostHome || join(userHome, ".omp", "agent") } : {}),
        agentsHome: join(userHome, ".agents"),
        mode: "installed",
        releaseInfo: null,
        activePid: process.pid,
      });
      const ok = Boolean(doctorResult.ok);

      const targetState = {
        schemaVersion: 1,
        harness: selectedHarness,
        root: resolve(plan.root || targetRoot),
        ...(finalProjectRoot ? { projectRoot: resolve(finalProjectRoot) } : {}),
        userHome,
        ...(plan.hostHome ? { hostHome: plan.hostHome } : {}),
        ...(plan.hostManifest ? { hostManifest: plan.hostManifest } : {}),
        version: readPackageVersion(PACKAGE_ROOT),
        ...(plan.managedFiles || priorManaged ? { managedFiles: plan.managedFiles || priorManaged } : {}),
      };

      let statePath = null;
      let savedState = null;
      if (ok) {
        journal.commit(targetState);
        statePath = getStateFilePath(userHome);
        savedState = targetState;
        const alignCheck = checkVersionAlignment({
          harness: resolve(plan.root || targetRoot),
          userHome,
          packageRoot: PACKAGE_ROOT,
        });
        const idx = doctorResult.checks.findIndex((c) => c.id === "version-alignment");
        if (idx !== -1) doctorResult.checks[idx] = alignCheck;
        else doctorResult.checks.push(alignCheck);
      } else {
        journal.rollback("doctor_failed");
        savedState = existingState || targetState;
        statePath = existingState ? getStateFilePath(userHome) : null;
      }

      if (plan.preservedAssets?.count) doctorResult.checks.push({
        id: "preserved-assets", status: "warn",
        detail: `${plan.preservedAssets.count} assets preserved. ${plan.preservedAssets.detail}`,
      });
      const finalReadiness = summarizeDoctorReadiness(doctorResult);
      printInitSuccess(output, options, { ok, readiness: finalReadiness, selectedHarness, savedState, statePath, plan, doctorResult });
      return ok ? 0 : 1;
    } finally {
      if (lock) lock.release();
    }
  } finally {
    session.close();
  }
}

function buildDoctorReport(enriched, deps = {}) {
  const pkgVersion = deps.pkgVersion || readPackageVersion(deps.root || PACKAGE_ROOT);
  const matrix = (deps.loadHarnessMatrix ? deps.loadHarnessMatrix() : loadHarnessMatrix()) || [];
  const runner = deps.probeRunner || defaultRunner;
  const harnessProbes = matrix
    .filter((entry) => entry && entry.id && entry.detect?.cmd)
    .map((entry) => ({
      id: entry.id,
      ...probeHarness(entry, runner),
    }));
  const configCheck = enriched.checks?.find((c) => c.id === "configs" || c.id === "harness-integration");
  const configStatus = configCheck?.status || (enriched.ok ? "pass" : "warn");
  return {
    pkgVersion,
    system: {
      platform: deps.platform || process.platform,
      arch: deps.arch || process.arch,
      node: deps.nodeVersion || process.version,
    },
    harnessProbes,
    configStatus,
  };
}

export async function runDoctorCommand(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const doctorFn = deps.runDoctor || runDoctor;

  let userHome, savedState = null;
  try {
    const loaded = loadUserState(options, env);
    userHome = loaded.userHome;
    savedState = loaded.state;
  } catch (err) {
    const safeMsg = sanitizeError(err.message);
    if (options.json || options.report) output.write(JSON.stringify({ ok: false, error: "invalid_state", detail: safeMsg }, null, 2) + "\n");
    else errOut.write(`doctor error: ${safeMsg}\n`);
    return 1;
  }

  const checkHarness = options.harness !== null && options.harness !== undefined ? options.harness : options.targetHarness;
  if (checkHarness && !HARNESS_CHOICES.includes(checkHarness)) {
    const msg = `Invalid --harness "${checkHarness}". Choose one of: ${HARNESS_CHOICES.join(", ")}`;
    if (options.json || options.report) output.write(JSON.stringify({ ok: false, error: "invalid_harness", detail: msg }, null, 2) + "\n");
    else errOut.write(`doctor error: ${msg}\n`);
    return 2;
  }
  let targetHarness = checkHarness || null;
  let installedRoot = options.root ? resolve(options.root) : null;
  if (savedState) {
    targetHarness = targetHarness || savedState.harness;
    if (!installedRoot) installedRoot = targetHarness === savedState.harness ? savedState.root : getDefaultRoot(targetHarness, userHome);
  } else if (targetHarness && !installedRoot) {
    installedRoot = getDefaultRoot(targetHarness, userHome);
  }
  if (!installedRoot || !targetHarness) {
    const msg = `No saved installation found at ${getStateFilePath(userHome)}. Run 'nullform init' first or specify --harness and --root.`;
    if (options.json || options.report) output.write(JSON.stringify({ ok: false, error: "missing_state", detail: msg }, null, 2) + "\n");
    else errOut.write(`doctor error: ${msg}\n`);
    return 1;
  }

  const agentDir = options.agentDir ? resolve(options.agentDir) : targetHarness === "omp"
    ? resolveHostHome({ harness: "omp", userHome, hostHome: options.hostHome || (savedState?.harness === "omp" ? savedState.hostHome : undefined), env }).path
    : null;
  const agentsHome = options.agentsHome ? resolve(options.agentsHome) : join(userHome, ".agents");

  let releaseInfo = null;
  const releaseApiUrl = options.releaseUrl || options.apiUrl || env.NULLFORM_RELEASE_URL || null;
  const releaseRegistry = options.registry || env.NULLFORM_REGISTRY || null;
  if (!options.skipReleaseCheck && (releaseApiUrl || releaseRegistry) && existsSync(join(installedRoot, "VERSION"))) {
    try {
      releaseInfo = await checkRelease({ root: installedRoot, userHome, apiUrl: releaseApiUrl, registry: releaseRegistry, timeoutMs: options.timeoutMs || 3000, env });
    } catch (err) {
      releaseInfo = { offline: true, error: err.message };
    }
  }

  const isSameSavedHarness = Boolean(savedState && savedState.harness === targetHarness);
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : isSameSavedHarness && savedState.projectRoot
      ? resolve(savedState.projectRoot)
      : targetHarness === "cursor"
        ? resolve(process.cwd())
        : null;

  const result = doctorFn({
    harness: installedRoot,
    targetHarness,
    ...(projectRoot ? { projectRoot } : {}),
    userHome,
    hostHome: options.hostHome || (isSameSavedHarness ? savedState.hostHome : undefined),
    hostManifest: loadHostManifest(options.hostManifest || (isSameSavedHarness ? savedState.hostManifest : undefined), targetHarness),
    env,
    agentDir,
    agentsHome,
    mode: options.mode || "installed",
    requirePlugins: options.requirePlugins,
    skipPluginCheck: options.skipPluginCheck,
    pruneLogs: options.pruneLogs,
    probeResults: null,
    releaseInfo,
  });
  const readiness = summarizeDoctorReadiness(result);
  const enriched = { ...result, targetHarness, ...(projectRoot ? { projectRoot } : {}), userHome, readiness };
  return emitDoctorResult(enriched, readiness, options, deps, output);
}

function emitDoctorResult(enriched, readiness, options, deps, output) {
  if (options.report) {
    const report = buildDoctorReport(enriched, deps);
    output.write(JSON.stringify({ ...enriched, report }, null, 2) + "\n");
    return enriched.ok ? 0 : 1;
  }
  if (options.json) {
    output.write(JSON.stringify(enriched, null, 2) + "\n");
  } else {
    printHumanReport(enriched, options.quiet);
    if (!options.quiet && (readiness === "setup" || readiness === "warn")) {
      output.write(`Readiness: ${readiness.toUpperCase()} (host runtime or configuration setup required)\n`);
    }
  }
  return enriched.ok ? 0 : 1;
}

export async function runUpdateCommand(options = {}, deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const updateFn = deps.executeUpdate || executeUpdate;

  let res;
  try {
    res = await updateFn({
      userHome: options.userHome, root: options.root, projectRoot: options.projectRoot, harness: options.harness, prefix: options.prefix,
      registry: options.registry, apiUrl: options.apiUrl || options.releaseUrl, timeoutMs: options.timeoutMs,
      dryRun: options.dryRun, force: options.force, yes: options.yes, packageRoot: PACKAGE_ROOT,
      argv1: process.argv[1], env: deps.env || process.env, spawnFn: deps.spawnFn, fetchFn: deps.fetchFn,
    });
  } catch (err) {
    const safeMsg = sanitizeError(err.message);
    const errPayload = { ok: false, updated: false, error: "update_failed", detail: safeMsg };
    if (options.json) output.write(JSON.stringify(errPayload, null, 2) + "\n");
    else errOut.write(`nullform update error: [update_failed] ${safeMsg}\n`);
    return 1;
  }

  const safeRes = sanitizeResultObject(res);

  if (options.json) output.write(JSON.stringify(safeRes, null, 2) + "\n");
  else if (!res.ok) errOut.write(`nullform update error: [${safeRes.error}] ${safeRes.detail}\n`);
  else if (res.dryRun) {
    output.write(`[dry-run] Update plan for ${PACKAGE_NAME}@${safeRes.latest}:\n`);
    for (const step of safeRes.plan || []) output.write(`  - ${step}\n`);
  } else if (res.updated) {
    output.write(`Updated ${PACKAGE_NAME} from v${safeRes.from} to v${safeRes.to} (${safeRes.harness} at ${safeRes.root}).\n`);
  } else {
    output.write(`${safeRes.detail}\n`);
  }
  return res.ok ? 0 : 1;
}

export async function runWorkflowCommand(workflowArgs = [], deps = {}) {
  const workflowFn = deps.runWorkflowCli || runWorkflowCli;
  return workflowFn(workflowArgs, { cwd: deps.cwd || process.cwd() });
}

export { getCapabilitiesInfo };

export async function runCapabilitiesCommand(options = {}, deps = {}) {
  const output = deps.stdout || process.stdout;
  const env = deps.env || process.env;
  const userHome = resolveUserHomePath(options, env);
  const info = (deps.getCapabilitiesInfo || getCapabilitiesInfo)({
    userHome, env, harness: options.harness, hostHome: options.hostHome,
    hostManifest: loadHostManifest(options.hostManifest, options.harness),
    projectRoot: options.projectRoot,
  });

  if (options.json) {
    output.write(JSON.stringify(info, null, 2) + "\n");
  } else {
    output.write(`=== NULLFORM WORKFLOW Capabilities ===\n\n`);
    output.write(`Configuration Adapters (${info.configurationAdapters.length} supported):\n`);
    for (const a of info.adapters) {
      output.write(`  - ${a.id.padEnd(10)}: Configuration deployment supported (in PATH: ${a.present ? "yes" : "no"})\n`);
    }
    output.write(`\nCore Workflow Gates:\n`);
    output.write(`  - Runtime:  Node.js (zero OMP or Bun requirement)\n`);
    output.write(`  - Commands: ${info.coreWorkflowGates.commands.join(", ")}\n`);
    output.write(`\nAutomated Review Execution:\n`);
    output.write(`  - Supported: ONLY 'omp' with Bun\n`);
    output.write(`  - Other 7 adapters: Refuses before dispatch (configuration deployment only)\n`);
  }
  return 0;
}

/**
 * `nullform quality …` — one line of glue so the npm CLI and `node tools/quality.mjs`
 * share a single implementation. The gate's own argv is forwarded untouched.
 */
export async function runQualityCommand(qualityArgs = [], deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  try {
    if (qualityArgs[0] === "code-size") {
      let runCodeSizeCli;
      if (deps.runCodeSizeCli) runCodeSizeCli = deps.runCodeSizeCli;
      else {
        const mod = await import("../tools/code-size.mjs");
        runCodeSizeCli = mod.runCodeSizeCli || mod.main;
      }
      return runCodeSizeCli(qualityArgs.slice(1), { stdout: output, stderr: errOut });
    }
    let runQualityCli;
    if (deps.runQualityCli) runQualityCli = deps.runQualityCli;
    else {
      const mod = await import("../tools/quality.mjs");
      runQualityCli = mod.runQualityCli;
    }
    return runQualityCli(qualityArgs, { stdout: output, stderr: errOut });
  } catch (err) {
    errOut.write(`quality error: ${sanitizeError(err && err.message ? err.message : String(err))}\n`);
    return 2;
  }
}

export async function runEvidenceCommand(options = {}, deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const root = options.root ? resolve(options.root) : process.cwd();

  try {
    let readQualityEvidence, formatQualityEvidence;
    if (deps.readQualityEvidence) {
      readQualityEvidence = deps.readQualityEvidence;
      formatQualityEvidence = deps.formatQualityEvidence;
    } else {
      const mod = await import("../tools/quality-evidence.mjs");
      readQualityEvidence = mod.readQualityEvidence;
      formatQualityEvidence = mod.formatQualityEvidence;
    }

    const evidence = await readQualityEvidence({ root });
    if (!evidence || evidence.status === "error" || evidence.error) {
      const errObj = evidence || { ok: false, status: "error", error: "evidence_unavailable", detail: "Quality evidence unavailable or invalid" };
      if (options.json) {
        output.write(JSON.stringify(errObj, null, 2) + "\n");
      } else {
        errOut.write(`evidence error: ${errObj.detail || errObj.error || "Quality evidence unavailable"}\n`);
      }
      return 1;
    }

    if (options.json) {
      output.write(JSON.stringify(evidence, null, 2) + "\n");
    } else {
      const formatted = typeof formatQualityEvidence === "function" ? formatQualityEvidence(evidence) : JSON.stringify(evidence, null, 2);
      output.write(formatted.endsWith("\n") ? formatted : formatted + "\n");
    }
    return 0;
  } catch (err) {
    const safeMsg = sanitizeError(err.message);
    if (options.json) {
      output.write(JSON.stringify({ ok: false, status: "error", error: "evidence_unavailable", detail: safeMsg }, null, 2) + "\n");
    } else {
      errOut.write(`evidence error: ${safeMsg}\n`);
    }
    return 1;
  }
}

export async function runInspectCommand(options = {}, deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  try {
    const env = deps.env || process.env;
    const { userHome, state } = loadUserState(options, env);
    const harness = options.harness || state?.harness;
    if (!HARNESS_CHOICES.includes(harness)) throw new Error("Inspect requires --harness or a saved installation");
    const same = state?.harness === harness;
    const report = await inspectHarness({
      harness, userHome, env,
      hostHome: options.hostHome || (same ? state.hostHome : undefined),
      hostManifest: loadHostManifest(options.hostManifest || (same ? state.hostManifest : undefined), harness),
      projectRoot: options.projectRoot || (same ? state.projectRoot : undefined),
      probe: Boolean(options.probe),
    });
    output.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  } catch (err) {
    emitJsonOrText(output, errOut, options.json, { ok: false, error: "inspection_failed", detail: sanitizeError(err.message) }, `inspect error: ${sanitizeError(err.message)}\n`);
    return 1;
  }
}

export function printCliHelp(output = process.stdout) {
  let ver = "unknown";
  try { ver = readPackageVersion(PACKAGE_ROOT); } catch {}
  output.write(`
nullform — NULLFORM WORKFLOW CLI (v${ver})

Usage:
  nullform setup [--harness <name>] [--yes] [--dry-run] [--json]
  nullform init [options]
  nullform inspect --harness <name> [--host-home <dir>] [--host-manifest <file>] [--probe]
  nullform heal [--dry-run] [--json]
  nullform doctor [options]
  nullform update [options]
  nullform workflow <command> [args...]
  nullform quality <command> [args...]
  nullform capabilities [options]
  nullform evidence [options]
  nullform --version
  nullform --help

Commands:
  setup         Detect harnesses with reasons, print plan, confirm, install (agent-friendly; --yes/--dry-run)
  init          Select harness (interactive menu or --harness), preview plan, install adapter & save state
  inspect       Read-only profile facts and evidence-aware decisions; optional bounded native probe
  heal          Diagnose with doctor, apply allow-listed repairs, re-verify (self-healing; --dry-run)
  doctor        Verify installed workflow assets and selected native harness integration
  update        Check npm registry, update global package and re-apply saved installation
  workflow      Execute core workflow gates (start, suggest, artifact, check, status, close, check-ci, stage-b, metrics)
  capabilities  Inspect supported configuration adapters, core workflow runtime, and execution boundaries
  quality       Stack-aware static analysis: detect, plan, install, check, baseline (cognitive-complexity ratchet)
  evidence      Report verifiable development quality evidence and historical limitations

Init Options:
  --harness <name>   Target harness: ${HARNESS_CHOICES.join(", ")}
  --root <dir>       Workflow installation root override
  --project-root <d> Project root override (e.g. Cursor project rules)
  --user-home <dir>  User home directory override
  --host-home <dir>  Explicit native host/profile home (saved for doctor/update)
  --host-manifest <f> Validated declarative JSON contract; custom also requires --project-root
  --probe            Inspect only; bounded native probe, never a model turn or readiness guarantee
  --yes, -y          Confirm installation without interactive prompt
  --dry-run          Preview installation plan without modifying target or state
  --json             Output structured JSON result

Doctor Options:
  --user-home <dir>  User home directory containing .nullform/installation.json
  --harness <name>   Target harness: ${HARNESS_CHOICES.join(", ")}
  --root <dir>       Override installed workflow root
  --project-root <d> Override project root directory
  --release-url <u>  Check release drift against npm metadata endpoint
  --report           Print shareable machine report with harness probes and system info
  --json             Output structured JSON report
  --quiet, -q        Summary line only

Update Options:
  --user-home <dir>  User home directory containing .nullform/installation.json
  --registry <url>   npm registry URL override
  --api-url <url>    npm metadata endpoint override
  --prefix <dir>     Global npm prefix override
  --project-root <d> Override project root directory
  --dry-run          Preview update plan without modifying installation
  --force            Reinstall even if already on latest version
  --yes, -y          Non-interactive confirmation
  --json             Output structured JSON result

Workflow Usage:
  nullform workflow start --tier <T0|T1|T2|T3> --task "..."
  nullform workflow check
  nullform workflow close
  nullform workflow artifact --kind <manifest|openspec|interfaces|oracle> --path <path>
  nullform workflow check-ci --tier T2 --change <name>
  nullform workflow status
  nullform workflow metrics
  nullform quality detect
  nullform quality install --dry-run
  nullform quality check --changed

Capabilities Options:
  --json             Output structured JSON capabilities report

Evidence Options:
  --root <dir>       Project root or installed harness directory (default: current directory)
  --json             Output structured JSON evidence report
`.trim() + "\n");
}

/** One table instead of a chain of ifs: adding a command is one row, and the
 * unknown-command path stays a single place. */
const COMMANDS = {
  workflow: (o, d) => runWorkflowCommand(o.workflowArgs, d),
  quality: (o, d) => runQualityCommand(o.qualityArgs, d),
  init: runInit,
  setup: runSetup,
  heal: runHeal,
  inspect: runInspectCommand,
  doctor: runDoctorCommand,
  update: runUpdateCommand,
  capabilities: runCapabilitiesCommand,
  evidence: runEvidenceCommand,
};

export async function main(argv = process.argv.slice(2), deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;

  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    errOut.write(`Error: ${sanitizeError(err.message)}\n`);
    return 2;
  }

  if (options.version && !options.command) {
    try {
      const ver = readPackageVersion(PACKAGE_ROOT);
      if (options.json) output.write(JSON.stringify({ name: PACKAGE_NAME, version: ver }) + "\n");
      else output.write(`${ver}\n`);
      return 0;
    } catch (err) {
      errOut.write(`Error: ${sanitizeError(err.message)}\n`);
      return 1;
    }
  }
  if (options.help || !options.command) {
    printCliHelp(output);
    return options.help ? 0 : 2;
  }

  const handler = COMMANDS[options.command];
  if (!handler) {
    errOut.write(`Error: Unknown command "${options.command}"\n`);
    return 2;
  }
  return handler(options, deps);
}

if (
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })()
) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`nullform: unhandled error: ${sanitizeError(err.message)}\n`);
    process.exitCode = 2;
  });
}
