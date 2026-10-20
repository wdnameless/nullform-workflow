#!/usr/bin/env node
/**
 * tools/install-harness.mjs — Cross-platform orchestrator installer for any harness.
 *
 * Supported harnesses:
 *   - claude    (Claude Code -> CLAUDE.md)
 *   - codex     (Codex -> AGENTS.md)
 *   - opencode  (OpenCode -> AGENTS.md + opencode.json)
 *   - cursor    (Cursor -> .cursor/rules/00-workflow.mdc)
 *   - omp       (Oh My Pi -> ~/.omp/agent/AGENTS.md)
 *   - openclaw  (OpenClaw -> openclaw.json + AGENTS.md + skills; SOUL.md/USER.md are identity and never written)
 *   - hermes    (Hermes -> config.yaml + AGENTS.md)
 *   - openhuman (OpenHuman -> AGENTS.md + copied skills)
 *   - all       (All adapters)
 *   - auto      (Auto-detect candidate harness; refuses if ambiguous or none)
 *
 * Options:
 *   --harness <name>      Target harness (default: auto)
 *   --root <dir>          Installation root directory (default: harness default directory)
 *   --project-root <dir>  Target project directory for project-scoped rules (e.g. Cursor)
 *   --user-home <dir>     User home directory override
 *   --dry-run             Preview actions without writing to disk
 *   --json                Machine-readable JSON output
 *   --help, -h            Show help
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MANAGED_START, MANAGED_END, RUNTIME_PARSER_DEPS, resolveRuntimePackageDir, preflightAllConfigs, hashContent, isCommandInPath } from "./installation/config.mjs";
import { applyHarnessAdapter, prepareHermesActivation } from "./installation/adapters.mjs";
import { validateRootPath, validatePathWithinScope } from './worktree-snapshot.mjs';
import { CONCRETE_HARNESSES, CORE_FILES, getCoreDirs, getDefaultRoot, preflightFilesystemConfinement, readInstallationState } from './installation/state.mjs';
import { acquireDeploymentLock, DeploymentJournal, safeAtomicWrite, getDeploymentJournalPath } from './installation/journal.mjs';
import { resolveHostHome, validateHostManifest, inspectHarness } from "./installation/profiles.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SUPPORTED_HARNESSES = [...CONCRETE_HARNESSES, 'custom', 'all', 'auto'];

function isStrictlyInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function discoverCandidates({ userHome = homedir(), projectRoot, env = process.env, platform = process.platform } = {}) {
  const isDefaultHome = resolve(userHome) === resolve(homedir());
  const candidates = [];
  for (const h of CONCRETE_HARNESSES) {
    let hasPresence = false;
    if (h === "cursor") {
      const cursorDir = projectRoot ? join(resolve(projectRoot), ".cursor") : join(process.cwd(), ".cursor");
      if (existsSync(cursorDir)) hasPresence = true;
      else {
        const homePath = resolveHostHome({ harness: "cursor", userHome, env, platform }).path;
        if (existsSync(homePath)) hasPresence = true;
      }
    } else if (h === "omp") {
      const ompDir = join(userHome, ".omp");
      const agentDir = resolveHostHome({ harness: "omp", userHome, env, platform }).path;
      if (existsSync(ompDir) || existsSync(agentDir)) hasPresence = true;
    } else if (h === "openclaw") {
      const homePath = resolveHostHome({ harness: "openclaw", userHome, env, platform }).path;
      if (existsSync(join(homePath, "openclaw.json")) || existsSync(homePath)) hasPresence = true;
    } else if (h === "hermes") {
      const homePath = resolveHostHome({ harness: "hermes", userHome, env, platform }).path;
      if (existsSync(join(homePath, "config.yaml")) || existsSync(homePath)) hasPresence = true;
    } else {
      const homePath = resolveHostHome({ harness: h, userHome, env, platform }).path;
      if (existsSync(homePath)) hasPresence = true;
    }

    if (!hasPresence) {
      const hasCmd = h === "openhuman"
        ? (isCommandInPath("openhuman", env, platform) || isCommandInPath("openhuman-core", env, platform))
        : isCommandInPath(h, env, platform);
      if (hasCmd && (isDefaultHome || (env && (env.PATH || env.Path)))) {
        hasPresence = true;
      }
    }
    if (hasPresence) candidates.push(h);
  }
  return candidates;
}

function detectHarness(options = {}) {
  const candidates = discoverCandidates(options);
  return candidates.length === 1 ? candidates[0] : null;
}

function isPromptSurface(srcPath) {
  const rel = relative(REPO_ROOT, srcPath);
  return /^(agent|rules|skills)[\\/]/.test(rel) || /(?:^|[\\/])(agent|rules|skills)[\\/]/.test(srcPath);
}

function renderSubstitutedText(srcPath, slashRoot) {
  let content = readFileSync(srcPath, "utf8");
  if (content.includes("<HARNESS>") && isPromptSurface(srcPath)) {
    content = content.split("<HARNESS>").join(slashRoot);
  }
  return content;
}

function preserveAsset(destPath, priorHash, plan) {
  if (priorHash) plan.managedFiles[destPath] = priorHash;
  const preserved = plan.preservedAssets;
  const reason = priorHash ? "modifiedOwned" : "unowned";
  preserved.count++;
  preserved[reason]++;
  if (preserved.examples.length < 3) preserved.examples.push({ path: destPath, reason });
}

function copyAndSubstitute(srcPath, destPath, slashRoot, { dryRun, priorManaged, plan, journal }) {
  const destExists = existsSync(destPath);
  const sameFile = resolve(srcPath) === resolve(destPath) ||
    (destExists && realpathSync(srcPath) === realpathSync(destPath));
  const priorHash = plan.managedFiles[destPath] || priorManaged[destPath];
  // In-place install (destination IS the source): never rewrite the live tree and never
  // adopt its bytes as newly owned; keep any ownership already recorded, never invent one.
  if (sameFile) {
    if (priorHash) plan.managedFiles[destPath] = priorHash;
    return true;
  }
  const isText = /\.(md|mjs|js|cjs|json|ya?ml|ps1|sh|txt|env|example)$/i.test(srcPath);
  const content = isText ? renderSubstitutedText(srcPath, slashRoot) : readFileSync(srcPath);
  const incomingHash = hashContent(content);
  if (destExists) {
    const currentHash = hashContent(readFileSync(destPath));
    if (priorHash ? currentHash !== priorHash : currentHash !== incomingHash) {
      preserveAsset(destPath, priorHash, plan);
      return false;
    }
    if (currentHash === incomingHash) {
      plan.managedFiles[destPath] = incomingHash;
      return true;
    }
  }
  plan.managedFiles[destPath] = incomingHash;
  if (!dryRun) {
    if (journal) journal.recordBeforeWrite(destPath, content);
    mkdirSync(dirname(destPath), { recursive: true });
    safeAtomicWrite(destPath, content, isText ? "utf8" : undefined);
    if (journal) journal.recordWritten(destPath, incomingHash);
  }
  return true;
}

function copyDirRecursive(srcDir, destDir, slashRoot, assetContext) {
  const copied = [];
  if (!existsSync(srcDir)) return copied;

  function walk(currentSrc, currentDest) {
    const entries = readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__tmp__" ||
          entry.name === "__pycache__" || entry.name === ".tmp") {
        continue;
      }
      const srcPath = join(currentSrc, entry.name);
      const destPath = join(currentDest, entry.name);

      if (entry.isDirectory()) {
        if (!assetContext.dryRun) {
          mkdirSync(destPath, { recursive: true });
        }
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        if (copyAndSubstitute(srcPath, destPath, slashRoot, assetContext)) copied.push(destPath);
      }
    }
  }

  walk(srcDir, destDir);
  return copied;
}

/**
 * Old root module paths whose implementation moved into tools/<group>/. Removing an old copy
 * requires three independent proofs: canonical confinement inside the selected root, recorded
 * prior ownership, and byte equality with that owned hash. Anything else is human/unknown and
 * is preserved with a bounded warning. Dry-run previews without mutating; the deployment
 * journal restores a removed module when the installation fails.
 */
const REPLACED_MODULE_PATHS = Object.freeze([
  "review-evidence.mjs", "review-native-tools.mjs", "review-budget.mjs",
  "review-http-runtime.mjs", "review-http-child.mjs", "review-http-evidence.mjs",
  "installation-state.mjs", "harness-profiles.mjs", "harness-adapters.mjs",
  "harness-config.mjs", "harness-capabilities.mjs", "hermes-policy.mjs",
  "deployment-journal.mjs", "deployment-restore.mjs",
  "task-claim.mjs", "workflow-workspaces.mjs",
]);

function pruneReplacedModules({ targetRoot, priorManaged, plan, journal, dryRun }) {
  for (const name of REPLACED_MODULE_PATHS) {
    const dest = join(targetRoot, "tools", name);
    let entry = null;
    try { entry = lstatSync(dest); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    // A symlink or non-regular entry is never read through and never certified as ours.
    if (!entry.isFile()) {
      plan.warnings.push(`Legacy module tools/${name} is not a regular file; preserved unread (never followed) and may remain active.`);
      preserveAsset(dest, priorManaged[dest], plan);
      continue;
    }
    if (!validatePathWithinScope(dest, targetRoot)) {
      plan.warnings.push(`Legacy module tools/${name} cannot be proven confined to the installation root; preserved unmodified and may remain active.`);
      preserveAsset(dest, priorManaged[dest], plan);
      continue;
    }
    const priorHash = priorManaged[dest];
    if (!priorHash || hashContent(readFileSync(dest)) !== priorHash) {
      plan.warnings.push(`Legacy module tools/${name} is not provably owned by this installation; preserved unmodified and may remain active.`);
      preserveAsset(dest, priorHash, plan);
      continue;
    }
    plan.replacedModules.push(dest);
    if (dryRun) continue;
    if (journal) journal.recordBeforeUnlink(dest);
    unlinkSync(dest);
    if (journal) journal.recordUnlinked(dest);
  }
}

/**
 * Copies runtime parser dependencies (yaml, json5, jsonc-parser) selectively
 * into targetRoot/tools/node_modules without copying the developer node_modules tree.
 */
function copyRuntimeDeps(repoRoot, targetRoot, slashRoot, assetContext) {
  const copied = [];
  const destToolsNm = join(targetRoot, "tools", "node_modules");
  for (const pkg of RUNTIME_PARSER_DEPS) {
    const srcPkg = resolveRuntimePackageDir(pkg, repoRoot);
    if (srcPkg && existsSync(srcPkg)) {
      const destPkg = join(destToolsNm, pkg);
      copied.push(...copyDirRecursive(srcPkg, destPkg, slashRoot, assetContext));
    }
  }
  return copied;
}
export function translateStdioEntry(entry, platform = process.platform) {
  if (!entry || typeof entry !== "object") return entry;
  const isWin = platform === "win32";
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? [...entry.args] : [];

  if (isWin) {
    if (typeof cmd === "string" && cmd.toLowerCase() === "cmd.exe") {
      return { ...entry, command: cmd, args };
    }
    if (cmd) {
      return { ...entry, command: "cmd.exe", args: ["/c", cmd, ...args] };
    }
    return { ...entry, args };
  }
  if (typeof cmd === "string" && (cmd.toLowerCase() === "cmd.exe" || cmd.toLowerCase() === "cmd")) {
    if (args[0] && args[0].toLowerCase() === "/c") {
      return { ...entry, command: args[1] || "", args: args.slice(2) };
    }
  }
  return { ...entry, command: cmd, args };
}

export const translateMcpEntry = translateStdioEntry;

function parseCliArgs(argv) {
  const options = { harness: "auto", root: "", projectRoot: "", userHome: "", dryRun: false, json: false, help: false };
  const takeVal = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) throw new Error(`Missing value for ${flag}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "inspect") options.command = "inspect";
    else if (arg === "--probe") options.probe = true;
    else if (arg === "--host-home") options.hostHome = takeVal(i++, "--host-home");
    else if (arg.startsWith("--host-home=")) options.hostHome = arg.slice("--host-home=".length);
    else if (arg === "--host-manifest") options.hostManifest = takeVal(i++, "--host-manifest");
    else if (arg.startsWith("--host-manifest=")) options.hostManifest = arg.slice("--host-manifest=".length);
    else if (arg === "--harness") options.harness = takeVal(i++, "--harness");
    else if (arg.startsWith("--harness=")) options.harness = arg.slice("--harness=".length);
    else if (arg === "--root") options.root = takeVal(i++, "--root");
    else if (arg.startsWith("--root=")) options.root = arg.slice("--root=".length);
    else if (arg === "--project-root") options.projectRoot = takeVal(i++, "--project-root");
    else if (arg.startsWith("--project-root=")) options.projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--user-home") options.userHome = takeVal(i++, "--user-home");
    else if (arg.startsWith("--user-home=")) options.userHome = arg.slice("--user-home=".length);
    else throw new Error(`Unknown option "${arg}"`);
  }
  if (options.probe && options.command !== "inspect") throw new Error("--probe is inspect-only");
  return options;
}

export function loadHostManifest(value, harness) {
  if (value === null || value === undefined || value === "") {
    if (harness === "custom") throw new Error("Custom host requires --host-manifest and --project-root");
    return undefined;
  }
  let parsed = value;
  if (typeof value === "string") {
    if (statSync(value).size > 32768) throw new Error("Host manifest exceeds 32 KiB");
    try { parsed = JSON.parse(readFileSync(value, "utf8")); }
    catch { throw new Error("Host manifest must be valid JSON"); }
  }
  return validateHostManifest(parsed, { custom: harness === "custom" });
}

function installHarness(options = {}) {
  const env = options.env || process.env;
  if (options.probe) throw new Error("--probe is inspect-only");
  const userHome = resolve(options.userHome || env.NULLFORM_USER_HOME || env.USERPROFILE || env.HOME || homedir());

  const rawHarness = options.harness || "auto";
  if (!SUPPORTED_HARNESSES.includes(rawHarness)) {
    throw new Error(
      `Unknown harness "${rawHarness}". Supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}.`
    );
  }

  const selectedHarness = rawHarness === "auto" ? detectHarness({ userHome, projectRoot: options.projectRoot, env }) : rawHarness;
  if (!selectedHarness && rawHarness === "auto") {
    const candidates = discoverCandidates({ userHome, projectRoot: options.projectRoot, env });
    if (candidates.length > 1) {
      throw new Error(`Multiple candidate harnesses detected: ${candidates.join(", ")}. Specify --harness <name> explicitly.`);
    }
    throw new Error(`No supported harness detected. Specify --harness <name> explicitly. Choose one of: ${CONCRETE_HARNESSES.join(", ")}`);
  }
  const hostManifest = loadHostManifest(options.hostManifest, selectedHarness);
  if (selectedHarness === "custom" && !options.projectRoot) throw new Error("Custom host requires --project-root");
  const rawTargetRoot = options.root
    ? resolve(options.root)
    : getDefaultRoot(selectedHarness, userHome, { hostHome: options.hostHome, env });
  const targetRoot = validateRootPath(rawTargetRoot);
  const slashRoot = targetRoot.replace(/\\/g, "/");
  const projectRoot = options.projectRoot ? validateRootPath(resolve(options.projectRoot)) : null;
  const agentsHome = join(userHome, ".agents");

  if (isStrictlyInside(REPO_ROOT, targetRoot)) {
    throw new Error(
      `Cannot install harness into a subdirectory of the repository root ("${targetRoot}"). ` +
      `Use in-place install with "--root ." or specify a destination outside "${REPO_ROOT}".`
    );
  }

  const targetHarnesses =
    selectedHarness === "all"
      ? ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman"]
      : [selectedHarness];

  const shouldWriteHome = Boolean(options.hostHome || options.userHome || !options.root);
  const hostHomes = Object.fromEntries(targetHarnesses.map(h => [h, resolveHostHome({ harness: h, userHome, hostHome: options.hostHome, env }).path]));
  const hostHome = hostHomes[selectedHarness];
  for (const h of targetHarnesses) {
    if (h !== "omp" && resolve(targetRoot) === resolve(hostHomes[h])) {
      throw new Error("Use a separate workflow installation root, not the native host home; bulk package assets must not become a native home skill catalogue.");
    }
  }

  preflightFilesystemConfinement({
    harnesses: targetHarnesses,
    targetRoot,
    projectRoot,
    userHome,
    agentsHome,
    shouldWriteHome,
    hostHomes, hostManifest,
  });

  // An explicitly requested apply may first recover a dead transaction. A public dry-run never does.
  // Recover before collision checks: an interrupted first apply has no published skill ownership yet.
  if ((!options.dryRun || options.recover) && !options.lock && existsSync(getDeploymentJournalPath(userHome))) {
    const recoveryLock = acquireDeploymentLock({
      userHome, targetRoot, projectRoot, hostHome: hostHome || hostHomes.hermes, hostHomes, harness: selectedHarness,
    });
    recoveryLock.release();
    const restored = readInstallationState(userHome);
    options = {
      ...options,
      managedFiles: restored?.harness === selectedHarness && resolve(restored.root) === resolve(targetRoot) ? restored.managedFiles : undefined,
    };
  }
  const reports = Object.fromEntries(targetHarnesses.map(h => [h, inspectHarness({ harness: h, userHome, hostHome: hostHomes[h], hostManifest, projectRoot, env })]));
  const report = reports[selectedHarness];
  preflightAllConfigs({ harnesses: targetHarnesses, targetRoot, projectRoot, userHome, hostHomes, hostManifest });
  const hermesActivation = targetHarnesses.includes("hermes") ? prepareHermesActivation({
    hostHome: hostHomes.hermes, slashRoot, report: reports.hermes, managedFiles: options.managedFiles, env,
  }) : null;

  let lock = null;
  let journal = null;
  const shouldManageLock = !options.dryRun && !options.lock;
  const isOwnJournal = !options.dryRun && !options.journal;

  if (!options.dryRun) {
    lock = options.lock || acquireDeploymentLock({ userHome, targetRoot, projectRoot, hostHome: hostHome || hostHomes.hermes, hostHomes, harness: selectedHarness, dryRun: options.dryRun });
    journal = options.journal || new DeploymentJournal({
      userHome,
      targetRoot,
      projectRoot,
      harness: selectedHarness,
      targetVersion: options.targetVersion,
      dryRun: options.dryRun,
      hostHome: hostHome || hostHomes.hermes,
      hostHomes,
    });
    journal.start();
  }

  try {
    const priorManaged = options.managedFiles && typeof options.managedFiles === "object" ? options.managedFiles : {};
    const plan = {
      harness: selectedHarness,
      root: targetRoot,
      ...(projectRoot ? { projectRoot } : {}),
      userHome,
      ...(hostHome ? { hostHome } : {}),
      ...(hostManifest ? { hostManifest } : {}),
      ...(report ? { profile: report } : { profiles: reports }),
      warnings: [],
      dryRun: Boolean(options.dryRun),
      filesToCopy: [],
      adapters: [],
      replacedModules: [],
      managedFiles: {},
      preservedAssets: {
        count: 0, modifiedOwned: 0, unowned: 0, examples: [],
        detail: "Preserved assets may differ from packaged behavior and security policy; review local changes.",
      },
    };
    const assetContext = { dryRun: Boolean(options.dryRun), priorManaged, plan, journal };
    const copyAsset = (src, dest) => copyAndSubstitute(src, dest, slashRoot, assetContext);

    const coreDirs = getCoreDirs();

    for (const dir of coreDirs) {
      const srcDir = join(REPO_ROOT, dir);
      if (existsSync(srcDir)) {
        plan.filesToCopy.push(...copyDirRecursive(srcDir, join(targetRoot, dir), slashRoot, assetContext));
      }
    }

    for (const file of CORE_FILES) {
      const srcFile = join(REPO_ROOT, file);
      const destFile = join(targetRoot, file);
      if (existsSync(srcFile) && copyAsset(srcFile, destFile)) plan.filesToCopy.push(destFile);
    }

    plan.filesToCopy.push(...copyRuntimeDeps(REPO_ROOT, targetRoot, slashRoot, assetContext));
    pruneReplacedModules({ targetRoot, priorManaged, plan, journal, dryRun: Boolean(options.dryRun) });
    const writeAdapter = (filePath, content) => {
      plan.adapters.push(filePath);
      const hash = hashContent(content);
      plan.managedFiles[filePath] = hash;
      if (!options.dryRun) {
        if (journal) journal.recordBeforeWrite(filePath, content);
        mkdirSync(dirname(filePath), { recursive: true });
        safeAtomicWrite(filePath, content, "utf8");
        if (journal) journal.recordWritten(filePath, hash);
      }
    };
    const readExisting = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

    for (const h of targetHarnesses) {
      applyHarnessAdapter(h, {
        targetRoot, projectRoot, slashRoot, userHome, options, shouldWriteHome,
        hostHome: hostHomes[h], report: reports[h], hostManifest, hermesActivation,
        writeAdapter, readExisting, plan, assetContext, copyAsset,
        copyDirRecursive, translateStdioEntry,
      });
    }

    const promptLint = join(targetRoot, "tools", "prompt-lint.mjs");
    if (selectedHarness === "omp" && !options.dryRun && existsSync(promptLint)) {
      try {
        runPromptLintBaseline(promptLint, targetRoot, userHome);
        plan.baselineRecorded = true;
      } catch {
        plan.baselineRecorded = false;
      }
    }
    if (isOwnJournal && journal) {
      journal.finalize();
    }
    return plan;
  } catch (err) {
    if (isOwnJournal && journal) {
      journal.rollback(err.message);
    }
    if (shouldManageLock && lock) {
      lock.release();
    }
    throw err;
  } finally {
    if (shouldManageLock && !options.deferLock && lock) {
      lock.release();
    }
  }
}

function runPromptLintBaseline(promptLint, harnessRoot, userHome) {
  spawnSync(process.execPath, [promptLint, "baseline", "--root", harnessRoot], {
    encoding: "utf8",
    windowsHide: process.platform === "win32",
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
  });
}

function printHelp() {
  console.log(`
NULLFORM WORKFLOW Harness Portable Installer

Usage:
  node tools/install-harness.mjs [options]
  node tools/install-harness.mjs inspect --harness <name> [--host-home <dir>] [--host-manifest <json>] [--probe]

Options:
  --harness <name>      Harness: claude, codex, opencode, cursor, omp, openclaw, hermes, openhuman, custom, all, auto
  --root <dir>          Installation root directory (default: harness default directory)
  --project-root <dir>  Project root directory for project-scoped rules (e.g. Cursor)
  --user-home <dir>     User home directory override
  --host-home <dir>     Select a native host/profile home explicitly
  --host-manifest <f>   Declarative JSON host contract (custom also requires project-root)
  --probe               Inspect-only bounded native probe; never used during install
  --dry-run             Preview installation plan without writing any files
  --json                Output result as JSON
  --help, -h            Show this help message
`.trim());
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  try {
    if (options.command === "inspect") {
      const env = process.env;
      const userHome = resolve(options.userHome || env.NULLFORM_USER_HOME || env.USERPROFILE || env.HOME || homedir());
      const harness = options.harness === "auto" ? detectHarness({ userHome, env }) : options.harness;
      if (harness === "all") throw new Error("Inspect requires one selected harness");
      const report = await inspectHarness({ harness, userHome, hostHome: options.hostHome, hostManifest: loadHostManifest(options.hostManifest, harness), projectRoot: options.projectRoot, env, probe: Boolean(options.probe) });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const plan = installHarness(options);

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      process.exitCode = 0;
      return;
    }

    if (options.dryRun) {
      console.log(`[dry-run] Plan for NULLFORM WORKFLOW harness installation:`);
      console.log(`  Harness:      ${plan.harness}`);
      console.log(`  Install root: ${plan.root}`);
      console.log(`  Files count:  ${plan.filesToCopy.length}`);
      console.log(`  Adapters:`);
      for (const adapter of plan.adapters) {
        console.log(`    - ${adapter}`);
      }
      console.log(`  Removals:     ${plan.replacedModules.length}`);
      for (const removed of plan.replacedModules) {
        console.log(`    - ${removed}`);
      }
      process.exitCode = 0;
      return;
    }

    console.log(`\n=== NULLFORM WORKFLOW Installer ===`);
    console.log(`  Harness:      ${plan.harness}`);
    console.log(`  Install root: ${plan.root}`);
    console.log(`  Files copied: ${plan.filesToCopy.length}`);
    console.log(`  Adapters:`);
    for (const adapter of plan.adapters) {
      console.log(`    [ok] ${adapter}`);
    }
    console.log(`Installation complete.\n`);
    process.exitCode = 0;
    return;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main();
}

export { installHarness, detectHarness, discoverCandidates, SUPPORTED_HARNESSES, MANAGED_START, MANAGED_END, isCommandInPath };
