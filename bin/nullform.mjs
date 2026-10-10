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

import { installHarness, getDefaultRoot, SUPPORTED_HARNESSES } from "../tools/install-harness.mjs";
import { runDoctor, probeProviders, printHumanReport } from "../tools/doctor.mjs";
import {
  PACKAGE_NAME,
  HARNESS_CHOICES,
  readLocalVersion,
  validateSafePath,
  getStateFilePath,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  parseSemVer,
  checkRelease,
  executeUpdate,
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
};

export const HARNESS_MENU_ITEMS = [
  { index: 1, id: "claude", label: "Claude Code", description: "~/.claude/CLAUDE.md" },
  { index: 2, id: "codex", label: "OpenAI Codex", description: "~/.codex/AGENTS.md" },
  { index: 3, id: "opencode", label: "OpenCode", description: "~/.config/opencode/opencode.json, AGENTS.md & skills" },
  { index: 4, id: "cursor", label: "Cursor", description: "<project>/.cursor/rules/00-workflow.mdc (project-scoped)" },
  { index: 5, id: "omp", label: "Oh My Pi (OMP)", description: "~/.omp/agent & ~/.agents/skills" },
  { index: 6, id: "openclaw", label: "OpenClaw", description: "~/.openclaw/openclaw.json, SOUL.md & skills" },
  { index: 7, id: "hermes", label: "Hermes Agent", description: "~/.hermes/config.yaml, AGENTS.md & skills" },
  { index: 8, id: "openhuman", label: "OpenHuman", description: "~/.openhuman/AGENTS.md & skills" },
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

export function parseCliArgs(argv = []) {
  const options = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    yes: { type: "boolean", short: "y" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    probe: { type: "boolean" },
    "require-plugins": { type: "boolean" },
    "skip-plugin-check": { type: "boolean" },
    "skip-release-check": { type: "boolean" },
    "prune-logs": { type: "boolean" },
    harness: { type: "string" },
    "target-harness": { type: "string" },
    root: { type: "string" },
    "project-root": { type: "string" },
    "user-home": { type: "string" },
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
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const match = err.message.match(/'([^']+)'/);
      throw new Error(`Unknown option "${match ? match[1] : ""}"`);
    }
    if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const match = err.message.match(/Option '([^'\s]+)/);
      throw new Error(`Missing value for ${match ? match[1] : "option"}`);
    }
    throw err;
  }

  let command = null;
  for (const pos of parsed.positionals) {
    if (pos === "init" || pos === "doctor" || pos === "update") {
      if (command && command !== pos) throw new Error(`Unexpected command "${pos}" after "${command}"`);
      command = pos;
    } else {
      throw new Error(`Unknown option or command "${pos}"`);
    }
  }

  let timeoutMs = null;
  if (parsed.values.timeout) {
    const val = parseInt(parsed.values.timeout, 10);
    if (!Number.isFinite(val) || val <= 0) throw new Error("Invalid --timeout value");
    timeoutMs = val * 1000;
  }

  return {
    command,
    harness: parsed.values.harness || null,
    targetHarness: parsed.values["target-harness"] || null,
    root: parsed.values.root || null,
    projectRoot: parsed.values["project-root"] || null,
    userHome: parsed.values["user-home"] || null,
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
    requirePlugins: Boolean(parsed.values["require-plugins"]),
    skipPluginCheck: Boolean(parsed.values["skip-plugin-check"]),
    skipReleaseCheck: Boolean(parsed.values["skip-release-check"]),
    pruneLogs: Boolean(parsed.values["prune-logs"]),
    help: Boolean(parsed.values.help),
    version: Boolean(parsed.values.version),
  };
}

export function resolveMenuSelection(rawInput) {
  if (typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed || trimmed === "q" || trimmed === "quit" || trimmed === "exit" || trimmed === "cancel") {
    return null;
  }
  if (/^[1-8]$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10);
    return HARNESS_CHOICES[idx - 1] || null;
  }
  if (HARNESS_CHOICES.includes(trimmed)) {
    return trimmed;
  }
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

export async function promptHarnessMenu({ session, output = process.stdout, json = false } = {}) {
  const ownSession = !session;
  const activeSession = session || createPromptSession({ output });
  try {
    if (!json && output && typeof output.write === "function") {
      output.write("\nSelect target harness for NULLFORM WORKFLOW:\n");
      for (const item of HARNESS_MENU_ITEMS) {
        output.write(`  ${item.index}) ${item.id.padEnd(10)} — ${item.label} (${item.description})\n`);
      }
    }
    const answer = await activeSession.ask("Enter harness number (1-8) or name: ");
    return resolveMenuSelection(answer);
  } finally {
    if (ownSession) activeSession.close();
  }
}

export async function promptConfirmPlan(plan, { session, output = process.stdout, json = false } = {}) {
  const ownSession = !session;
  const activeSession = session || createPromptSession({ output });
  try {
    if (!json && output && typeof output.write === "function") {
      output.write(`\nInstallation Plan Preview:\n`);
      output.write(`  Harness:      ${plan.harness}\n`);
      output.write(`  Target root:  ${plan.root}\n`);
      if (plan.projectRoot) output.write(`  Project root: ${plan.projectRoot}\n`);
      output.write(`  User home:    ${plan.userHome}\n`);
      output.write(`  Core files:   ${plan.filesToCopy.length}\n`);
      output.write(`  Adapters:     ${plan.adapters.length}\n`);
      for (const a of plan.adapters) output.write(`    - ${a}\n`);
    }
    const answer = await activeSession.ask("Proceed with installation? [y/N]: ");
    if (typeof answer !== "string") return false;
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    if (ownSession) activeSession.close();
  }
}

function summarizeDoctorReadiness(res) {
  const checks = Array.isArray(res?.checks) ? res.checks : [];
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
  if (isJson) output.write(JSON.stringify(payload, null, 2) + "\n");
  else if (toStderr) errOut.write(textMsg);
  else output.write(textMsg);
}

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
      version: savedState.version,
      statePath,
      plan,
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

async function resolveInitHarness(options, existingState, session, output, errOut) {
  if (options.harness !== null && options.harness !== undefined && !HARNESS_CHOICES.includes(options.harness)) {
    const msg = `Invalid --harness "${options.harness}". Choose one of: ${HARNESS_CHOICES.join(", ")}`;
    emitJsonOrText(output, errOut, options.json, { ok: false, error: "invalid_harness", detail: msg }, `Error: ${msg}\n`);
    return { error: 2 };
  }
  let selected = options.harness || ((options.yes || options.dryRun) && existingState?.harness ? existingState.harness : null);
  if (!selected) {
    if (options.yes) {
      const msg = "Missing --harness in headless (--yes) mode with no saved installation.";
      emitJsonOrText(output, errOut, options.json, { ok: false, error: "missing_harness", detail: msg }, `Error: ${msg}\n`);
      return { error: 2 };
    }
    selected = await promptHarnessMenu({ session, output, json: options.json });
    if (!selected) {
      const msg = "Interactive harness selection cancelled or absent in non-interactive mode.";
      emitJsonOrText(output, errOut, options.json, { ok: false, cancelled: true, error: "cancelled", detail: msg }, `Error: ${msg}\n`);
      return { error: 1 };
    }
  }
  return { harness: selected };
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
    emitJsonOrText(output, errOut, options.json, { ok: false, error: "invalid_state", detail: err.message }, `Error: ${err.message}\n`);
    return 1;
  }

  const session = createPromptSession({ input: deps.stdin || process.stdin, output: options.json ? null : output, isTTY: deps.isTTY });
  try {
    const harnessRes = await resolveInitHarness(options, existingState, session, output, errOut);
    if (harnessRes.error) return harnessRes.error;
    const selectedHarness = harnessRes.harness;

    const targetRoot = options.root
      ? resolve(options.root)
      : existingState && existingState.harness === selectedHarness && existingState.root
        ? resolve(existingState.root)
        : getDefaultRoot(selectedHarness, userHome);
    const projectRoot = options.projectRoot
      ? resolve(options.projectRoot)
      : existingState?.projectRoot
        ? resolve(existingState.projectRoot)
        : selectedHarness === "cursor"
          ? resolve(process.cwd())
          : null;

    let previewPlan;
    try {
      previewPlan = installFn({
        harness: selectedHarness,
        root: targetRoot,
        ...(projectRoot ? { projectRoot } : {}),
        userHome,
        dryRun: true,
        managedFiles: existingState?.managedFiles,
      });
    } catch (err) {
      emitJsonOrText(output, errOut, options.json, { ok: false, stage: "preflight", error: "install_failed", detail: err.message }, `Error: ${err.message}\n`);
      return 1;
    }

    if (options.dryRun) {
      const lines = [
        `[dry-run] Plan for NULLFORM WORKFLOW (${previewPlan.harness}):`,
        `  Root:         ${previewPlan.root}`,
        ...(previewPlan.projectRoot ? [`  Project root: ${previewPlan.projectRoot}`] : []),
        `  User home:    ${previewPlan.userHome}`,
        `  Files:        ${previewPlan.filesToCopy.length}`,
        ...previewPlan.adapters.map((a) => `  Adapter:      ${a}`),
      ].join("\n") + "\n";
      emitJsonOrText(output, errOut, options.json, { ok: true, dryRun: true, ...previewPlan }, lines, false);
      return 0;
    }

    if (!options.yes) {
      const confirmed = await promptConfirmPlan(previewPlan, { session, output, json: options.json });
      if (!confirmed) {
        emitJsonOrText(output, errOut, options.json, { ok: false, cancelled: true, error: "cancelled", detail: "Installation cancelled by operator." }, "Installation cancelled by operator.\n");
        return 1;
      }
    }

    let plan;
    try {
      plan = installFn({
        harness: selectedHarness,
        root: targetRoot,
        ...(projectRoot ? { projectRoot } : {}),
        userHome,
        dryRun: false,
        managedFiles: existingState?.managedFiles,
      });
    } catch (err) {
      emitJsonOrText(output, errOut, options.json, { ok: false, stage: "install", error: "install_failed", detail: err.message }, `Error: ${err.message}\n`);
      return 1;
    }

    const finalProjectRoot = plan.projectRoot || projectRoot;
    const doctorResult = doctorFn({
      harness: resolve(plan.root || targetRoot),
      targetHarness: selectedHarness,
      ...(finalProjectRoot ? { projectRoot: resolve(finalProjectRoot) } : {}),
      userHome,
      agentDir: join(userHome, ".omp", "agent"),
      agentsHome: join(userHome, ".agents"),
      mode: "installed",
      releaseInfo: null,
    });
    const readiness = summarizeDoctorReadiness(doctorResult);
    const ok = Boolean(doctorResult.ok);

    const targetState = {
      schemaVersion: 1,
      harness: selectedHarness,
      root: resolve(plan.root || targetRoot),
      ...(finalProjectRoot ? { projectRoot: resolve(finalProjectRoot) } : {}),
      userHome,
      version: readPackageVersion(PACKAGE_ROOT),
      ...(plan.managedFiles || existingState?.managedFiles ? { managedFiles: plan.managedFiles || existingState?.managedFiles } : {}),
    };

    let statePath = null;
    let savedState = null;
    if (ok) {
      const writeRes = writeInstallationState(userHome, targetState);
      statePath = writeRes.statePath;
      savedState = writeRes.state;
    } else {
      savedState = existingState || targetState;
      statePath = existingState ? getStateFilePath(userHome) : null;
    }

    printInitSuccess(output, options, { ok, readiness, selectedHarness, savedState, statePath, plan, doctorResult });
    return ok ? 0 : 1;
  } finally {
    session.close();
  }
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
    if (options.json) output.write(JSON.stringify({ ok: false, error: "invalid_state", detail: err.message }, null, 2) + "\n");
    else errOut.write(`doctor error: ${err.message}\n`);
    return 1;
  }

  let targetHarness = options.targetHarness || null;
  let installedRoot = options.root ? resolve(options.root) : null;
  if (options.harness) {
    if (HARNESS_CHOICES.includes(options.harness)) targetHarness = targetHarness || options.harness;
    else installedRoot = installedRoot || resolve(options.harness);
  }
  if (savedState) {
    targetHarness = targetHarness || savedState.harness;
    if (!installedRoot) installedRoot = targetHarness === savedState.harness ? savedState.root : getDefaultRoot(targetHarness, userHome);
  } else if (targetHarness && !installedRoot) {
    installedRoot = getDefaultRoot(targetHarness, userHome);
  }

  if (targetHarness && !HARNESS_CHOICES.includes(targetHarness)) {
    const msg = `Invalid target harness "${targetHarness}". Expected one of: ${HARNESS_CHOICES.join(", ")}`;
    if (options.json) output.write(JSON.stringify({ ok: false, error: "invalid_harness", detail: msg }, null, 2) + "\n");
    else errOut.write(`doctor error: ${msg}\n`);
    return 2;
  }
  if (!installedRoot || !targetHarness) {
    const msg = `No saved installation found at ${getStateFilePath(userHome)}. Run 'nullform init' first or specify --harness and --root.`;
    if (options.json) output.write(JSON.stringify({ ok: false, error: "missing_state", detail: msg }, null, 2) + "\n");
    else errOut.write(`doctor error: ${msg}\n`);
    return 1;
  }

  const agentDir = options.agentDir ? resolve(options.agentDir) : join(userHome, ".omp", "agent");
  const agentsHome = options.agentsHome ? resolve(options.agentsHome) : join(userHome, ".agents");
  const probeResults = options.probe ? await probeProviders(join(agentDir, "models.yml")) : null;

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

  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : savedState?.projectRoot
      ? resolve(savedState.projectRoot)
      : targetHarness === "cursor"
        ? resolve(process.cwd())
        : null;

  const result = doctorFn({
    harness: installedRoot,
    targetHarness,
    ...(projectRoot ? { projectRoot } : {}),
    userHome,
    agentDir,
    agentsHome,
    mode: options.mode || "installed",
    requirePlugins: options.requirePlugins,
    skipPluginCheck: options.skipPluginCheck,
    pruneLogs: options.pruneLogs,
    probeResults,
    releaseInfo,
  });
  const readiness = summarizeDoctorReadiness(result);
  const enriched = { ...result, targetHarness, ...(projectRoot ? { projectRoot } : {}), userHome, readiness };
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

  const res = await updateFn({
    userHome: options.userHome, root: options.root, projectRoot: options.projectRoot, harness: options.harness, prefix: options.prefix,
    registry: options.registry, apiUrl: options.apiUrl || options.releaseUrl, timeoutMs: options.timeoutMs,
    dryRun: options.dryRun, force: options.force, yes: options.yes, packageRoot: PACKAGE_ROOT,
    argv1: process.argv[1], env: deps.env || process.env, spawnFn: deps.spawnFn, fetchFn: deps.fetchFn,
  });

  if (options.json) output.write(JSON.stringify(res, null, 2) + "\n");
  else if (!res.ok) errOut.write(`nullform update error: [${res.error}] ${res.detail}\n`);
  else if (res.dryRun) {
    output.write(`[dry-run] Update plan for ${PACKAGE_NAME}@${res.latest}:\n`);
    for (const step of res.plan || []) output.write(`  - ${step}\n`);
  } else if (res.updated) {
    output.write(`Updated ${PACKAGE_NAME} from v${res.from} to v${res.to} (${res.harness} at ${res.root}).\n`);
  } else {
    output.write(`${res.detail}\n`);
  }
  return res.ok ? 0 : 1;
}

export function printCliHelp(output = process.stdout) {
  let ver = "unknown";
  try { ver = readPackageVersion(PACKAGE_ROOT); } catch {}
  output.write(`
nullform — NULLFORM WORKFLOW CLI (v${ver})

Usage:
  nullform init [options]
  nullform doctor [options]
  nullform update [options]
  nullform --version
  nullform --help

Commands:
  init      Select harness (interactive menu or --harness), preview plan, install adapter & save state
  doctor    Verify installed workflow assets and selected native harness integration
  update    Check npm registry, update global package and re-apply saved installation

Init Options:
  --harness <name>   Target harness: ${HARNESS_CHOICES.join(", ")}
  --root <dir>       Workflow installation root override
  --project-root <d> Project root override (e.g. Cursor project rules)
  --user-home <dir>  User home directory override
  --yes, -y          Confirm installation without interactive prompt
  --dry-run          Preview installation plan without modifying target or state
  --json             Output structured JSON result

Doctor Options:
  --user-home <dir>  User home directory containing .nullform/installation.json
  --harness <name>   Override harness or root path
  --root <dir>       Override installed workflow root
  --project-root <d> Override project root directory
  --release-url <u>  Check release drift against npm metadata endpoint
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
`.trim() + "\n");
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const output = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;

  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    errOut.write(`Error: ${err.message}\n`);
    return 2;
  }

  if (options.version && !options.command) {
    try {
      const ver = readPackageVersion(PACKAGE_ROOT);
      if (options.json) output.write(JSON.stringify({ name: PACKAGE_NAME, version: ver }) + "\n");
      else output.write(`${ver}\n`);
      return 0;
    } catch (err) {
      errOut.write(`Error: ${err.message}\n`);
      return 1;
    }
  }

  if (options.help || !options.command) {
    printCliHelp(output);
    return options.help ? 0 : 2;
  }

  if (options.command === "init") return runInit(options, deps);
  if (options.command === "doctor") return runDoctorCommand(options, deps);
  if (options.command === "update") return runUpdateCommand(options, deps);

  errOut.write(`Error: Unknown command "${options.command}"\n`);
  return 2;
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
    process.stderr.write(`nullform: unhandled error: ${err.message}\n`);
    process.exitCode = 2;
  });
}
