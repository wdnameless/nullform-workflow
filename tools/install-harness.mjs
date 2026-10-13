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
 *   - openclaw  (OpenClaw -> openclaw.json + AGENTS.md + SOUL.md + USER.md + skills)
 *   - hermes    (Hermes -> config.yaml + AGENTS.md + skills)
 *   - openhuman (OpenHuman -> AGENTS.md + copied skills)
 *   - all       (All adapters)
 *   - auto      (Auto-detect harness; fallback: omp)
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

import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, realpathSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MANAGED_START, MANAGED_END, RUNTIME_PARSER_DEPS, resolveRuntimePackageDir, preflightAllConfigs, hashContent, isCommandInPath } from "./harness-config.mjs";
import { applyHarnessAdapter } from "./harness-adapters.mjs";
import { validateRootPath } from './worktree-snapshot.mjs';
import { CONCRETE_HARNESSES, CORE_FILES, getCoreDirs, getDefaultRoot, preflightFilesystemConfinement } from './installation-state.mjs';
import { acquireDeploymentLock, DeploymentJournal, safeAtomicWrite } from './deployment-journal.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SUPPORTED_HARNESSES = [...CONCRETE_HARNESSES, 'all', 'auto'];

function isStrictlyInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function detectHarness({ userHome = homedir(), env = process.env } = {}) {
  const isDefaultHome = resolve(userHome) === resolve(homedir());
  if (existsSync(join(userHome, ".claude"))) return "claude";
  if (existsSync(join(userHome, ".codex"))) return "codex";
  if (existsSync(join(userHome, ".config", "opencode")) || existsSync(join(userHome, ".opencode"))) return "opencode";
  if (existsSync(join(userHome, ".cursor"))) return "cursor";
  if (existsSync(join(userHome, ".openclaw", "openclaw.json")) || (isDefaultHome && isCommandInPath("openclaw"))) return "openclaw";
  const hasHermesHome = env.HERMES_HOME && (isDefaultHome || isStrictlyInside(userHome, env.HERMES_HOME) || resolve(env.HERMES_HOME) === resolve(userHome));
  if (existsSync(join(userHome, ".hermes", "config.yaml")) || hasHermesHome || (isDefaultHome && isCommandInPath("hermes"))) return "hermes";
  if (existsSync(join(userHome, ".openhuman")) || (isDefaultHome && isCommandInPath("openhuman-core")) || (isDefaultHome && isCommandInPath("openhuman"))) return "openhuman";
  if (isDefaultHome && isCommandInPath("omp")) return "omp";
  return "omp";
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
/**
 * Links the roster or updates unchanged managed role files; preserves human definitions and custom links.
 */
function installRoleRoster(linkTarget, destDir, slashRoot, assetContext) {
  const { dryRun, journal, plan } = assetContext;
  // Dry run mutates nothing: return before any unlink/symlink/mkdir.
  if (dryRun) return [destDir];
  try {
    let stat = null;
    try {
      stat = lstatSync(destDir);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isSymbolicLink()) {
        // Physical roster: copy only missing mandatory roles; never adopt user roster files.
        const copied = [];
        for (const entry of readdirSync(linkTarget, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const dstFile = join(destDir, entry.name);
          if (!existsSync(dstFile)) {
            if (copyAndSubstitute(join(linkTarget, entry.name), dstFile, slashRoot, assetContext)) copied.push(dstFile);
          }
        }
        return copied;
      }
      let currentTarget = null;
      try {
        currentTarget = resolve(dirname(destDir), readlinkSync(destDir));
      } catch {
        currentTarget = null;
      }
      // Known-expected link: already ours, nothing to do.
      if (currentTarget === resolve(linkTarget)) return [];
      // Unknown/dangling human or custom role link: preserve it and report; never silently
      // unlink a human's link target, and never claim its bytes as owned.
      preserveAsset(destDir, null, plan);
      return [];
    }
    mkdirSync(dirname(destDir), { recursive: true });
    if (journal) journal.recordBeforeSymlink(destDir, linkTarget);
    symlinkSync(linkTarget, destDir, process.platform === "win32" ? "junction" : "dir");
    if (journal) journal.recordSymlinked(destDir);
    return [destDir];
  } catch {
    return copyDirRecursive(linkTarget, destDir, slashRoot, assetContext);
  }
}

/**
 * Skills registry installer. Preserves human files by verifying against prior managed hashes.
 */
function installSkills(srcDir, destDir, slashRoot, agentsHome, assetContext, extra = {}) {
  if (!existsSync(srcDir)) return [];
  
  const skip = new Set();
  const searchRoots = [
    agentsHome,
    agentsHome && join(agentsHome, ".agents"),
    extra.targetRoot,
    extra.targetRoot && join(extra.targetRoot, ".agents"),
    extra.projectRoot,
    extra.projectRoot && join(extra.projectRoot, ".agents"),
  ].filter(Boolean);

  for (const root of searchRoots) {
    const lockPath = join(root, ".skill-lock.json");
    try {
      if (existsSync(lockPath)) {
        const locked = JSON.parse(readFileSync(lockPath, "utf8").replace(/^\uFEFF/, "").trim());
        for (const name of Object.keys(locked.skills || {})) {
          if (existsSync(join(destDir, name, "SKILL.md")) || existsSync(join(srcDir, name, "SKILL.md"))) {
            skip.add(name);
          }
        }
      }
    } catch {}

    const disabledPath = join(root, ".skills-disabled.json");
    try {
      if (existsSync(disabledPath)) {
        const disabled = JSON.parse(readFileSync(disabledPath, "utf8").replace(/^\uFEFF/, "").trim());
        for (const name of disabled.disabled || []) {
          if (typeof name === "string") skip.add(name);
        }
      }
    } catch {}
  }

  const out = [];

  function walkSkill(currentSrc, currentDest) {
    const entries = readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".tmp") continue;
      const sPath = join(currentSrc, entry.name);
      const dPath = join(currentDest, entry.name);

      if (entry.isDirectory()) {
        if (!assetContext.dryRun) mkdirSync(dPath, { recursive: true });
        walkSkill(sPath, dPath);
      } else if (entry.isFile()) {
        if (copyAndSubstitute(sPath, dPath, slashRoot, assetContext)) out.push(dPath);
      }
    }
  }

  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    walkSkill(join(srcDir, entry.name), join(destDir, entry.name));
  }
  return out;
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
  return options;
}


function installHarness(options = {}) {
  const userHome = options.userHome
    ? resolve(options.userHome)
    : process.env.USERPROFILE || process.env.HOME || homedir();

  const rawHarness = options.harness || "auto";
  if (!SUPPORTED_HARNESSES.includes(rawHarness)) {
    throw new Error(
      `Unknown harness "${rawHarness}". Supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}.`
    );
  }

  const selectedHarness = rawHarness === "auto" ? detectHarness({ userHome }) : rawHarness;
  const rawTargetRoot = options.root
    ? resolve(options.root)
    : getDefaultRoot(selectedHarness, userHome);
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

  const shouldWriteHome = Boolean(options.userHome || !options.root);

  preflightFilesystemConfinement({
    harnesses: targetHarnesses,
    targetRoot,
    projectRoot,
    userHome,
    agentsHome,
    shouldWriteHome,
    options,
  });

  preflightAllConfigs({ harnesses: targetHarnesses, targetRoot, projectRoot, userHome });

  let lock = null;
  let journal = null;
  const shouldManageLock = !options.dryRun && !options.lock;
  const isOwnJournal = !options.dryRun && !options.journal;

  if (!options.dryRun) {
    lock = options.lock || acquireDeploymentLock({ userHome, targetRoot, harness: selectedHarness, dryRun: options.dryRun });
    journal = options.journal || new DeploymentJournal({
      userHome,
      targetRoot,
      projectRoot,
      harness: selectedHarness,
      targetVersion: options.targetVersion,
      dryRun: options.dryRun,
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
      dryRun: Boolean(options.dryRun),
      filesToCopy: [],
      adapters: [],
      managedFiles: {},
      preservedAssets: {
        count: 0, modifiedOwned: 0, unowned: 0, examples: [],
        detail: "Preserved assets may differ from packaged behavior and security policy; review local changes.",
      },
    };
    const assetContext = { dryRun: Boolean(options.dryRun), priorManaged, plan, journal };
    const copyAsset = (src, dest) => copyAndSubstitute(src, dest, slashRoot, assetContext);

    const isCursorActive = targetHarnesses.includes("cursor");
    const coreDirs = getCoreDirs(isCursorActive);

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

    if (isCursorActive) {
      const srcSkills = join(REPO_ROOT, "skills");
      const destSkills = join(targetRoot, "skills");
      plan.filesToCopy.push(
        ...installSkills(srcSkills, destSkills, slashRoot, agentsHome, assetContext, {
          targetRoot,
          projectRoot,
        })
      );
    }

    plan.filesToCopy.push(...copyRuntimeDeps(REPO_ROOT, targetRoot, slashRoot, assetContext));

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
    const copyHomeSkills = (destDir) => {
      const src = join(REPO_ROOT, "skills");
      plan.filesToCopy.push(...installSkills(src, destDir, slashRoot, userHome, assetContext, {
        targetRoot,
        projectRoot,
      }));
    };

    for (const h of targetHarnesses) {
      applyHarnessAdapter(h, {
        targetRoot, projectRoot, slashRoot, userHome, options, shouldWriteHome,
        writeAdapter, readExisting, copyHomeSkills, plan, assetContext, copyAsset,
        copyDirRecursive, installSkills, installRoleRoster, translateStdioEntry,
      });
    }

    const promptLint = join(targetRoot, "tools", "prompt-lint.mjs");
    if (!options.dryRun && existsSync(promptLint)) {
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

Options:
  --harness <name>      Harness to configure: claude, codex, opencode, cursor, omp, openclaw, hermes, openhuman, all, auto (default: auto)
  --root <dir>          Installation root directory (default: harness default directory)
  --project-root <dir>  Project root directory for project-scoped rules (e.g. Cursor)
  --user-home <dir>     User home directory override
  --dry-run             Preview installation plan without writing any files
  --json                Output result as JSON
  --help, -h            Show this help message
`.trim());
}

function main() {
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

export { installHarness, detectHarness, SUPPORTED_HARNESSES, MANAGED_START, MANAGED_END, isCommandInPath };
