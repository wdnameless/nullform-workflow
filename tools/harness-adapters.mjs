/**
 * tools/harness-adapters.mjs — Adapter configuration mutators and home assets installer
 * for the 8 supported target harnesses.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  applyManagedSection,
  applyCursorMdc,
  updateOpencodeJson,
  updateOpenclawJson,
  updateHermesConfigYaml,
  getMarkdownAdapter,
  getOpenclawSoul,
  getOpenclawUser,
  hashContent,
  loadYaml,
  MANAGED_START,
  MANAGED_END,
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
  hostHome,
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
  const homeAgentDir = hostHome;
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

/** Prepare the complete native activation before core copying or journaling starts. */
export function prepareHermesActivation({ hostHome, slashRoot, report, managedFiles = {}, env = process.env, translateStdioEntry }) {
  const configPath = join(hostHome, "config.yaml");
  const skillPath = join(hostHome, "skills", "nullform-workflow", "SKILL.md");
  const original = preflightYamlConfig(configPath);
  let config = updateHermesConfigYaml(configPath, original);
  const settings = loadYaml().parse(original || "{}") || {};
  const auto = settings.skills?.auto_load || [];
  const ownedHash = managedFiles[skillPath];
  if (existsSync(join(hostHome, "skills", "nullform-workflow")) &&
      (!existsSync(skillPath) || !ownedHash || hashContent(readFileSync(skillPath)) !== ownedHash)) {
    throw new Error("Hermes quality skill collision: preserve the unowned/modified nullform-workflow skill; choose a separate host home or resolve manually.");
  }
  if (auto.includes("nullform-workflow") && !ownedHash) {
    throw new Error("Hermes quality skill name is already registered without proven ownership; preserve the human registration and resolve the collision manually.");
  }
  if (ownedHash && !auto.includes("nullform-workflow")) {
    throw new Error("Hermes quality skill was removed from auto_load by the operator; refusing to re-enable it. Restore it explicitly or use project instructions manually.");
  }
  const skills = report.capabilities?.skills;
  if (skills?.status === "unavailable" ||
      /^(1|true|yes|on)$/i.test(env.HERMES_IGNORE_RULES || "") ||
      settings.skills?.enabled === false || settings.skills?.disabled?.includes?.("nullform-workflow")) {
    return {
      writes: [],
      warnings: [
        "Native skill loading is disabled/unavailable. Use the generated installation-root AGENTS.md as explicit project instructions manually; no auto-load changes were made.",
        "Any existing legacy assets/registrations are preserved and may remain active; this is not a deactivation claim.",
      ],
      activation: { status: "manual", detail: "No native activation; skills tools/HERMES_IGNORE_RULES or declared support prevent loading." },
    };
  }
  const policy = getMarkdownAdapter(slashRoot, "Hermes Agent NULLFORM WORKFLOW Adapter", report);
  const content = `---\nname: nullform-workflow\ndescription: Native-first task quality and truthful result verification.\n---\n\n${policy}`;
  const writes = [[skillPath, content], [configPath, config]];
  const warnings = [];
  // Exact generated managed bytes prove block ownership without adopting surrounding human text.
  const soulPath = join(hostHome, "SOUL.md");
  if (existsSync(soulPath)) {
    const text = readFileSync(soulPath, "utf8");
    const legacy = `${MANAGED_START}\n${getMarkdownAdapter(slashRoot, "Hermes Agent NULLFORM WORKFLOW Adapter").trim()}\n${MANAGED_END}`;
    if (text.includes(legacy) && text.indexOf(MANAGED_START) === text.lastIndexOf(MANAGED_START) &&
        text.indexOf(MANAGED_END) === text.lastIndexOf(MANAGED_END)) writes.push([soulPath, text.replace(legacy, "")]);
    else if (text.includes(MANAGED_START) || managedFiles[soulPath]) {
      warnings.push("Modified/unknown legacy SOUL policy preserved; its legacy behavior may remain active.");
    }
  }
  if (original && managedFiles[configPath] === hashContent(original)) {
    const example = JSON.parse(readFileSync(join(REPO_ROOT, "agent", "mcp.json.example"), "utf8"));
    const doc = loadYaml().parseDocument(config, { keepSourceTokens: true });
    for (const [name, entry] of Object.entries(example.mcpServers || {})) {
      if (JSON.stringify(entry).includes("__")) continue;
      const translated = translateStdioEntry ? translateStdioEntry(entry) : entry;
      const expected = {
        ...(translated.command ? { command: translated.command } : {}),
        ...(translated.args?.length ? { args: translated.args } : {}),
        ...(translated.env && Object.keys(translated.env).length ? { env: translated.env } : {}),
      };
      if (isDeepStrictEqual(settings.mcp_servers?.[name], expected)) {
        doc.deleteIn(["mcp_servers", name]);
        delete settings.mcp_servers[name];
      }
    }
    config = doc.toString();
    writes[1][1] = config;
  }
  if (settings.mcp_servers && Object.keys(settings.mcp_servers).length) {
    warnings.push("Existing MCP registrations preserved: per-entry ownership is not proven; legacy servers may still run.");
  }
  const skillPrefix = `${join(hostHome, "skills").replace(/\\/g, "/")}/`;
  if (Object.keys(managedFiles).some(path => path.replace(/\\/g, "/").startsWith(skillPrefix) && path !== skillPath)) {
    warnings.push("Legacy managed home-skill catalogue preserved; old skill entries may remain discoverable.");
  }
  return {
    writes, warnings,
    activation: {
      status: "configured", skill: "nullform-workflow", path: skillPath,
      detail: "Native skills.auto_load registration only; runtime loading is unverified and requires skills tools and HERMES_IGNORE_RULES unset. Delegated children may skip skills.",
    },
  };
}

export function applyOpencodeAdapter(ctx) {
  const { targetRoot, hostHome, slashRoot, report, shouldWriteHome, writeAdapter, readExisting } = ctx;
  const raw = getMarkdownAdapter(slashRoot, "OpenCode NULLFORM WORKFLOW Adapter", report);
  for (const dir of new Set([targetRoot, ...(shouldWriteHome ? [hostHome] : [])])) {
    const path = join(dir, "AGENTS.md");
    writeAdapter(path, applyManagedSection(readExisting(path), raw));
    for (const config of resolveOpencodeConfigPaths(dir)) {
      writeAdapter(config, updateOpencodeJson(config, preflightJsoncConfig(config)));
    }
  }
}

export function applyHarnessAdapter(h, ctx) {
  const { targetRoot, projectRoot, hostHome, slashRoot, report, shouldWriteHome, writeAdapter, readExisting, hostManifest } = ctx;
  if (h === "omp") {
    if (shouldWriteHome) installOmpHomeAssets(ctx);
    return;
  }
  const raw = getMarkdownAdapter(slashRoot, `${h} NULLFORM WORKFLOW Adapter`, report);
  const writeMd = path => writeAdapter(path, applyManagedSection(readExisting(path), raw));
  if (h === "custom") {
    writeMd(join(projectRoot, hostManifest.instructionsFile));
  } else if (h === "cursor") {
    const path = join(projectRoot || targetRoot, ".cursor", "rules", "00-workflow.mdc");
    writeAdapter(path, applyCursorMdc(readExisting(path), raw));
  } else if (h === "opencode") {
    applyOpencodeAdapter(ctx);
  } else {
    const filename = h === "claude" ? "CLAUDE.md" : "AGENTS.md";
    writeMd(join(targetRoot, filename));
    if (h === "hermes") {
      for (const [path, content] of ctx.hermesActivation.writes) writeAdapter(path, content);
      ctx.plan.activation = ctx.hermesActivation.activation;
      ctx.plan.warnings.push(...ctx.hermesActivation.warnings);
    } else {
      if (shouldWriteHome) writeMd(join(hostHome, filename));
      if (h === "openclaw") {
        // OpenClaw natively reads SOUL.md/USER.md: write managed policy via standard replace
        // (any old block is replaced, human text preserved). This is native format, not bloat.
        writeAdapter(join(targetRoot, "SOUL.md"), applyManagedSection(readExisting(join(targetRoot, "SOUL.md")), getOpenclawSoul(slashRoot)));
        writeAdapter(join(targetRoot, "USER.md"), applyManagedSection(readExisting(join(targetRoot, "USER.md")), getOpenclawUser(slashRoot)));
        for (const dir of new Set([targetRoot, ...(shouldWriteHome ? [hostHome] : [])])) {
          const path = join(dir, "openclaw.json");
          writeAdapter(path, updateOpenclawJson(path, preflightJson5Config(path), slashRoot));
        }
      }
    }
  }
}
