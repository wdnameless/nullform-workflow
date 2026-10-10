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

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, realpathSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MANAGED_START,
  MANAGED_END,
  RUNTIME_PARSER_DEPS,
  resolveRuntimePackageDir,
  preflightAllConfigs,
  preflightJsoncConfig,
  preflightJson5Config,
  preflightYamlConfig,
  resolveOpencodeConfigPaths,
  applyManagedSection,
  applyCursorMdc,
  updateOpencodeJson,
  updateOpenclawJson,
  updateHermesConfigYaml,
  getMarkdownAdapter,
  getOpenclawSoul,
  getOpenclawUser,
  hashContent,
  isCommandInPath,
} from "./harness-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SUPPORTED_HARNESSES = ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman", "all", "auto"];

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

function getDefaultRoot(harness, userHome) {
  switch (harness) {
    case "claude": return join(userHome, ".claude", "workflow");
    case "codex": return join(userHome, ".codex", "workflow");
    case "opencode":
      return existsSync(join(userHome, ".opencode"))
        ? join(userHome, ".opencode", "workflow")
        : join(userHome, ".config", "opencode", "workflow");
    case "cursor": return join(userHome, ".cursor", "workflow");
    case "openclaw": return join(userHome, ".openclaw", "workflow");
    case "hermes": {
      const isDefaultHome = resolve(userHome) === resolve(homedir());
      const hermesBase = (isDefaultHome && process.env.HERMES_HOME) || join(userHome, ".hermes");
      return join(hermesBase, "workflow");
    }
    case "openhuman": return join(userHome, ".openhuman", "workflow");
    default: return join(userHome, "omp-workflow");
  }
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

function copyAndSubstitute(srcPath, destPath, slashRoot) {
  if (resolve(srcPath) === resolve(destPath)) return;

  const isText = /\.(md|mjs|js|cjs|json|ya?ml|ps1|sh|txt|env|example)$/i.test(srcPath);
  if (isText) {
    writeFileSync(destPath, renderSubstitutedText(srcPath, slashRoot), "utf8");
  } else {
    copyFileSync(srcPath, destPath);
  }
}

function copyDirRecursive(srcDir, destDir, slashRoot, planOnly = false) {
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
        if (!planOnly) {
          mkdirSync(destPath, { recursive: true });
        }
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        copied.push(destPath);
        if (!planOnly) {
          mkdirSync(dirname(destPath), { recursive: true });
          copyAndSubstitute(srcPath, destPath, slashRoot);
        }
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
function copyRuntimeDeps(repoRoot, targetRoot, slashRoot, planOnly = false) {
  const copied = [];
  const destToolsNm = join(targetRoot, "tools", "node_modules");
  for (const pkg of RUNTIME_PARSER_DEPS) {
    const srcPkg = resolveRuntimePackageDir(pkg, repoRoot);
    if (srcPkg && existsSync(srcPkg)) {
      const destPkg = join(destToolsNm, pkg);
      copied.push(...copyDirRecursive(srcPkg, destPkg, slashRoot, planOnly));
    }
  }
  return copied;
}
/**
 * Link role roster into destination. If destination is a real physical directory,
 * missing mandatory role files are copied into place while leaving user definitions intact.
 */
function installRoleRoster(linkTarget, destDir, slashRoot, planOnly = false) {
  if (planOnly) return [destDir];
  try {
    let stat = null;
    try {
      stat = lstatSync(destDir);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isSymbolicLink()) {
        const copied = [];
        if (existsSync(linkTarget)) {
          for (const entry of readdirSync(linkTarget, { withFileTypes: true })) {
            if (entry.isFile()) {
              const srcFile = join(linkTarget, entry.name);
              const dstFile = join(destDir, entry.name);
              if (!existsSync(dstFile)) {
                if (!planOnly) {
                  mkdirSync(dirname(dstFile), { recursive: true });
                  copyAndSubstitute(srcFile, dstFile, slashRoot);
                }
                copied.push(dstFile);
              }
            }
          }
        }
        return copied;
      }
      if (existsSync(destDir) &&
          resolve(dirname(destDir), readlinkSync(destDir)) === resolve(linkTarget)) {
        return [];
      }
      unlinkSync(destDir);
    }
    mkdirSync(dirname(destDir), { recursive: true });
    symlinkSync(linkTarget, destDir, process.platform === "win32" ? "junction" : "dir");
    return [destDir];
  } catch {
    return copyDirRecursive(linkTarget, destDir, slashRoot, false);
  }
}

/**
 * Skills registry installer. Preserves human files by verifying against prior managed hashes.
 */
function installSkills(srcDir, destDir, slashRoot, agentsHome, planOnly = false, priorManaged = {}, outManaged = {}) {
  if (!existsSync(srcDir)) return [];
  const skip = new Set();
  try {
    const locked = JSON.parse(readFileSync(join(agentsHome, ".skill-lock.json"), "utf8"));
    for (const name of Object.keys(locked.skills || {})) {
      if (existsSync(join(destDir, name, "SKILL.md"))) skip.add(name);
    }
  } catch {}
  try {
    const disabled = JSON.parse(readFileSync(join(agentsHome, ".skills-disabled.json"), "utf8"));
    for (const name of disabled.disabled || []) {
      if (typeof name === "string") skip.add(name);
    }
  } catch {}

  const out = [];

  function walkSkill(currentSrc, currentDest) {
    const entries = readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".tmp") continue;
      const sPath = join(currentSrc, entry.name);
      const dPath = join(currentDest, entry.name);

      if (entry.isDirectory()) {
        if (!planOnly) mkdirSync(dPath, { recursive: true });
        walkSkill(sPath, dPath);
      } else if (entry.isFile()) {
        const isText = /\.(md|mjs|js|cjs|json|ya?ml|ps1|sh|txt|env|example)$/i.test(sPath);
        const expectedText = isText ? renderSubstitutedText(sPath, slashRoot) : null;
        if (existsSync(dPath)) {
          const priorHash = priorManaged[dPath];
          if (priorHash) {
            const currentHash = hashContent(readFileSync(dPath, "utf8"));
            if (currentHash !== priorHash) {
              outManaged[dPath] = priorHash;
              continue;
            }
          } else if (expectedText !== null) {
            if (readFileSync(dPath, "utf8") !== expectedText) {
              continue;
            }
          } else {
            continue;
          }
        }
        out.push(dPath);
        if (expectedText !== null) {
          outManaged[dPath] = hashContent(expectedText);
        }
        if (!planOnly) {
          mkdirSync(dirname(dPath), { recursive: true });
          copyAndSubstitute(sPath, dPath, slashRoot);
        }
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

function installOmpHomeAssets({ targetRoot, slashRoot, userHome, options, priorManaged, plan, writeAdapter, readExisting }) {
  const homeAgentDir = join(userHome, ".omp", "agent");
  const agentsHome = join(userHome, ".agents");
  const lawSource = join(REPO_ROOT, "agent", "AGENTS.md");
  const rawLaw = existsSync(lawSource)
    ? readFileSync(lawSource, "utf8").split("<HARNESS>").join(slashRoot)
    : getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law");
  const homeAgentsFile = join(homeAgentDir, "AGENTS.md");
  writeAdapter(homeAgentsFile, applyManagedSection(readExisting(homeAgentsFile), rawLaw));
  writeAdapter(join(homeAgentDir, ".harness-root"), `${targetRoot}\n`);

  const mcpTarget = join(homeAgentDir, "mcp.json");
  if (!existsSync(mcpTarget)) {
    try {
      const cfg = JSON.parse(readFileSync(join(REPO_ROOT, "agent", "mcp.json.example"), "utf8"));
      for (const [name, entry] of Object.entries(cfg.mcpServers || {})) {
        if (JSON.stringify(entry).includes("__")) {
          delete cfg.mcpServers[name];
        } else {
          cfg.mcpServers[name] = translateStdioEntry(entry);
        }
      }
      writeAdapter(mcpTarget, JSON.stringify(cfg, null, 2) + "\n");
    } catch {}
  }

  plan.filesToCopy.push(
    ...installRoleRoster(join(targetRoot, "agent", "agents"), join(homeAgentDir, "agents"), slashRoot, options.dryRun)
  );
  for (const dst of [join(homeAgentDir, "rules"), join(agentsHome, "rules")]) {
    plan.filesToCopy.push(...copyDirRecursive(join(targetRoot, "rules"), dst, slashRoot, options.dryRun));
  }
  plan.filesToCopy.push(
    ...installSkills(join(targetRoot, "skills"), join(agentsHome, "skills"), slashRoot, agentsHome, options.dryRun, priorManaged, plan.managedFiles)
  );
  for (const extFile of ["nullform-jev.ts", "nullform-delete-guard.ts"]) {
    const extSource = join(REPO_ROOT, "agent", "extensions", extFile);
    const extDest = join(homeAgentDir, "extensions", extFile);
    if (existsSync(extSource)) {
      if (!options.dryRun) {
        mkdirSync(dirname(extDest), { recursive: true });
        copyFileSync(extSource, extDest);
      }
      plan.filesToCopy.push(extDest);
    }
  }
}

function applyOpencodeAdapter({ targetRoot, slashRoot, userHome, shouldWriteHome, writeAdapter, readExisting, copyHomeSkills }) {
  const rootAgents = join(targetRoot, "AGENTS.md");
  const rawAgents = getMarkdownAdapter(slashRoot, "OpenCode NULLFORM WORKFLOW Adapter");
  writeAdapter(rootAgents, applyManagedSection(readExisting(rootAgents), rawAgents));
  for (const rootJson of resolveOpencodeConfigPaths(targetRoot)) {
    writeAdapter(rootJson, updateOpencodeJson(rootJson, preflightJsoncConfig(rootJson)));
  }
  if (shouldWriteHome) {
    const configDir = join(userHome, ".config", "opencode");
    const homeAgents = join(configDir, "AGENTS.md");
    writeAdapter(homeAgents, applyManagedSection(readExisting(homeAgents), rawAgents));
    for (const homeJson of resolveOpencodeConfigPaths(configDir)) {
      writeAdapter(homeJson, updateOpencodeJson(homeJson, preflightJsoncConfig(homeJson)));
    }
    const legacyOpencodeDir = join(userHome, ".opencode");
    if (existsSync(legacyOpencodeDir)) {
      for (const legacyCfg of resolveOpencodeConfigPaths(legacyOpencodeDir)) {
        if (existsSync(legacyCfg)) {
          writeAdapter(legacyCfg, updateOpencodeJson(legacyCfg, preflightJsoncConfig(legacyCfg)));
        }
      }
    }
    copyHomeSkills(join(configDir, "skills"));
  }
}

function applyHarnessAdapter(h, ctx) {
  const { targetRoot, projectRoot, slashRoot, userHome, options, shouldWriteHome, writeAdapter, readExisting, copyHomeSkills, priorManaged, plan } = ctx;
  switch (h) {
    case "claude": {
      const rawAdapter = getMarkdownAdapter(slashRoot, "Claude Code NULLFORM WORKFLOW Adapter");
      writeAdapter(join(targetRoot, "CLAUDE.md"), applyManagedSection(readExisting(join(targetRoot, "CLAUDE.md")), rawAdapter));
      if (shouldWriteHome) {
        const homePath = join(userHome, ".claude", "CLAUDE.md");
        writeAdapter(homePath, applyManagedSection(readExisting(homePath), rawAdapter));
        copyHomeSkills(join(userHome, ".claude", "skills"));
      }
      break;
    }
    case "codex": {
      const rawAdapter = getMarkdownAdapter(slashRoot, "Codex NULLFORM WORKFLOW Adapter");
      writeAdapter(join(targetRoot, "AGENTS.md"), applyManagedSection(readExisting(join(targetRoot, "AGENTS.md")), rawAdapter));
      if (shouldWriteHome) {
        const homePath = join(userHome, ".codex", "AGENTS.md");
        writeAdapter(homePath, applyManagedSection(readExisting(homePath), rawAdapter));
        copyHomeSkills(join(userHome, ".codex", "skills"));
      }
      break;
    }
    case "opencode":
      applyOpencodeAdapter(ctx);
      break;
    case "cursor": {
      const rootMdc = join(projectRoot || targetRoot, ".cursor", "rules", "00-workflow.mdc");
      writeAdapter(rootMdc, applyCursorMdc(readExisting(rootMdc), getMarkdownAdapter(slashRoot, "Cursor NULLFORM WORKFLOW Adapter")));
      break;
    }
    case "omp": {
      const lawSource = join(REPO_ROOT, "agent", "AGENTS.md");
      const lawPath = join(targetRoot, "agent", "AGENTS.md");
      const rawLaw = existsSync(lawSource)
        ? readFileSync(lawSource, "utf8").split("<HARNESS>").join(slashRoot)
        : getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law");
      if (resolve(lawPath) !== resolve(lawSource)) writeAdapter(lawPath, rawLaw);
      if (shouldWriteHome) installOmpHomeAssets({ targetRoot, slashRoot, userHome, options, priorManaged, plan, writeAdapter, readExisting });
      break;
    }
    case "openclaw": {
      const rootJson = join(targetRoot, "openclaw.json");
      writeAdapter(join(targetRoot, "AGENTS.md"), applyManagedSection(readExisting(join(targetRoot, "AGENTS.md")), getMarkdownAdapter(slashRoot, "OpenClaw NULLFORM WORKFLOW Adapter")));
      writeAdapter(join(targetRoot, "SOUL.md"), applyManagedSection(readExisting(join(targetRoot, "SOUL.md")), getOpenclawSoul(slashRoot)));
      writeAdapter(join(targetRoot, "USER.md"), applyManagedSection(readExisting(join(targetRoot, "USER.md")), getOpenclawUser(slashRoot)));
      writeAdapter(rootJson, updateOpenclawJson(rootJson, preflightJson5Config(rootJson), slashRoot));
      if (shouldWriteHome || options.dryRun) {
        const homeJson = join(userHome, ".openclaw", "openclaw.json");
        writeAdapter(homeJson, updateOpenclawJson(homeJson, preflightJson5Config(homeJson), slashRoot));
        copyHomeSkills(join(userHome, ".openclaw", "skills"));
      }
      break;
    }
    case "hermes": {
      const rootConfig = join(targetRoot, "config.yaml");
      const mcpEx = join(REPO_ROOT, "agent", "mcp.json.example");
      const rawHermes = getMarkdownAdapter(slashRoot, "Hermes Agent NULLFORM WORKFLOW Adapter");
      writeAdapter(join(targetRoot, "AGENTS.md"), applyManagedSection(readExisting(join(targetRoot, "AGENTS.md")), rawHermes));
      writeAdapter(rootConfig, updateHermesConfigYaml(rootConfig, preflightYamlConfig(rootConfig), slashRoot, mcpEx, translateStdioEntry));
      if (shouldWriteHome || options.dryRun) {
        const hermesHome = (resolve(userHome) === resolve(homedir()) && process.env.HERMES_HOME) || join(userHome, ".hermes");
        const homeConfig = join(hermesHome, "config.yaml");
        writeAdapter(homeConfig, updateHermesConfigYaml(homeConfig, preflightYamlConfig(homeConfig), slashRoot, mcpEx, translateStdioEntry));
        writeAdapter(join(hermesHome, "SOUL.md"), applyManagedSection(readExisting(join(hermesHome, "SOUL.md")), rawHermes));
        writeAdapter(join(hermesHome, "AGENTS.md"), applyManagedSection(readExisting(join(hermesHome, "AGENTS.md")), rawHermes));
        copyHomeSkills(join(hermesHome, "skills"));
      }
      break;
    }
    case "openhuman": {
      const agentDir = join(targetRoot, "agents", "workflow");
      writeAdapter(join(targetRoot, "AGENTS.md"), applyManagedSection(readExisting(join(targetRoot, "AGENTS.md")), getMarkdownAdapter(slashRoot, "OpenHuman NULLFORM WORKFLOW Adapter")));
      writeAdapter(join(agentDir, "AGENTS.md"), applyManagedSection(readExisting(join(agentDir, "AGENTS.md")), getMarkdownAdapter(slashRoot, "OpenHuman Workflow Agent")));
      copyHomeSkills(join(agentDir, "skills"));
      if (shouldWriteHome || options.dryRun) {
        const homeOh = join(userHome, ".openhuman");
        writeAdapter(join(homeOh, "AGENTS.md"), applyManagedSection(readExisting(join(homeOh, "AGENTS.md")), getMarkdownAdapter(slashRoot, "OpenHuman NULLFORM WORKFLOW Adapter")));
        copyHomeSkills(join(homeOh, "skills"));
      }
      break;
    }
  }
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
  const targetRoot = options.root
    ? resolve(options.root)
    : getDefaultRoot(selectedHarness, userHome);
  const slashRoot = targetRoot.replace(/\\/g, "/");
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;

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

  preflightAllConfigs({ harnesses: targetHarnesses, targetRoot, projectRoot, userHome });

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
  };

  const coreDirs = ["agent", "rules", "tools", "core", "templates", "skills", "paseo", "bin"];
  const coreFiles = ["VERSION", ".code-size.baseline.json", "CONTEXT.md", "README.md", "secrets.example.env", "verify.ps1", "verify.sh", "package.json"];

  for (const dir of coreDirs) {
    const srcDir = join(REPO_ROOT, dir);
    if (existsSync(srcDir)) {
      plan.filesToCopy.push(...copyDirRecursive(srcDir, join(targetRoot, dir), slashRoot, options.dryRun));
    }
  }
  for (const file of coreFiles) {
    const srcFile = join(REPO_ROOT, file);
    const destFile = join(targetRoot, file);
    if (existsSync(srcFile)) {
      plan.filesToCopy.push(destFile);
      if (!options.dryRun) {
        mkdirSync(dirname(destFile), { recursive: true });
        copyAndSubstitute(srcFile, destFile, slashRoot);
      }
    }
  }

  plan.filesToCopy.push(...copyRuntimeDeps(REPO_ROOT, targetRoot, slashRoot, options.dryRun));

  const writeAdapter = (filePath, content) => {
    plan.adapters.push(filePath);
    plan.managedFiles[filePath] = hashContent(content);
    if (!options.dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    }
  };
  const shouldWriteHome = Boolean(options.userHome || !options.root);
  const readExisting = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const copyHomeSkills = (destDir) => {
    const src = existsSync(join(targetRoot, "skills")) ? join(targetRoot, "skills") : join(REPO_ROOT, "skills");
    plan.filesToCopy.push(...installSkills(src, destDir, slashRoot, userHome, options.dryRun, priorManaged, plan.managedFiles));
  };

  for (const h of targetHarnesses) {
    applyHarnessAdapter(h, {
      targetRoot, projectRoot, slashRoot, userHome, options, shouldWriteHome,
      writeAdapter, readExisting, copyHomeSkills, priorManaged, plan,
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
  return plan;
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

export { installHarness, detectHarness, getDefaultRoot, SUPPORTED_HARNESSES, MANAGED_START, MANAGED_END, isCommandInPath };
