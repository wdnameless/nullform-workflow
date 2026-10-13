/**
 * tools/harness-adapters.mjs — Adapter configuration mutators and home assets installer
 * for the 8 supported target harnesses.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  applyManagedSection,
  applyCursorMdc,
  updateOpencodeJson,
  updateOpenclawJson,
  updateHermesConfigYaml,
  getMarkdownAdapter,
  getOpenclawSoul,
  getOpenclawUser,
  preflightJsoncConfig,
  preflightJson5Config,
  preflightYamlConfig,
  resolveOpencodeConfigPaths,
} from "./harness-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "..");

export function installOmpHomeAssets({
  targetRoot,
  slashRoot,
  userHome,
  plan,
  writeAdapter,
  readExisting,
  assetContext,
  copyAsset,
  copyDirRecursive,
  installSkills,
  installRoleRoster,
  translateStdioEntry,
}) {
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
    ...installRoleRoster(join(targetRoot, "agent", "agents"), join(homeAgentDir, "agents"), slashRoot, assetContext)
  );
  for (const dst of [join(homeAgentDir, "rules"), join(agentsHome, "rules")]) {
    plan.filesToCopy.push(...copyDirRecursive(join(REPO_ROOT, "rules"), dst, slashRoot, assetContext));
  }
  plan.filesToCopy.push(
    ...installSkills(join(REPO_ROOT, "skills"), join(agentsHome, "skills"), slashRoot, agentsHome, assetContext)
  );
  for (const extFile of ["nullform-jev.ts", "nullform-delete-guard.ts"]) {
    const extSource = join(REPO_ROOT, "agent", "extensions", extFile);
    const extDest = join(homeAgentDir, "extensions", extFile);
    if (existsSync(extSource) && copyAsset(extSource, extDest)) plan.filesToCopy.push(extDest);
  }
}

export function applyOpencodeAdapter({
  targetRoot,
  slashRoot,
  userHome,
  shouldWriteHome,
  writeAdapter,
  readExisting,
  copyHomeSkills,
}) {
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

export function applyHarnessAdapter(h, ctx) {
  const {
    targetRoot,
    projectRoot,
    slashRoot,
    userHome,
    options,
    shouldWriteHome,
    writeAdapter,
    readExisting,
    copyHomeSkills,
    copyDirRecursive,
    installSkills,
    installRoleRoster,
    translateStdioEntry,
  } = ctx;

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
      if (shouldWriteHome) {
        installOmpHomeAssets({
          ...ctx,
          copyDirRecursive,
          installSkills,
          installRoleRoster,
          translateStdioEntry,
        });
      }
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
        const isDefaultHome = resolve(userHome) === resolve(homedir());
        const hermesHome = (isDefaultHome && process.env.HERMES_HOME) || join(userHome, ".hermes");
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
