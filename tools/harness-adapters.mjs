/**
 * tools/harness-adapters.mjs — Adapter configuration mutators and home assets installer
 * for the 8 supported target harnesses.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyManagedSection,
  applyCursorMdc,
  updateOpencodeJson,
  updateOpenclawJson,
  getMarkdownAdapter,
  getOpenclawSoul,
  getOpenclawUser,
  loadYaml,
  preflightJsoncConfig,
  preflightJson5Config,
  preflightYamlConfig,
  resolveOpencodeConfigPaths,
} from "./harness-config.mjs";
import { updateHermesConfigYaml } from "./hermes-policy.mjs";

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

/** Prepare native prompt activation before core copying or journaling starts. */
export function prepareHermesActivation({ hostHome, slashRoot, report, managedFiles = {}, env = process.env }) {
  const configPath = join(hostHome, "config.yaml");
  preflightYamlConfig(configPath);
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const settings = loadYaml().parse(original || "{}") || {};
  const warnings = [];
  if (Object.hasOwn(settings, "skills") || existsSync(join(hostHome, "skills"))) {
    warnings.push("Legacy Hermes skills/skills.auto_load preserved without adoption or deletion. This client does not consume auto_load; review legacy loading manually.");
  }
  if (settings.mcp_servers && Object.keys(settings.mcp_servers).length) {
    warnings.push("Existing MCP registrations preserved; legacy servers may still run.");
  }
  if (managedFiles[join(hostHome, "SOUL.md")]) {
    warnings.push("Legacy SOUL policy preserved; resolve its ownership and behavior manually.");
  }
  const override = Object.hasOwn(env, "HERMES_EPHEMERAL_SYSTEM_PROMPT");
  const ignored = /^(1|true|yes|on)$/i.test(String(env.HERMES_IGNORE_RULES || "").trim());
  if (override || ignored) {
    const detail = override
      ? "HERMES_EPHEMERAL_SYSTEM_PROMPT is present; use explicit project instructions manually or resolve that override yourself."
      : "HERMES_IGNORE_RULES is selected; use explicit project instructions manually. No policy was re-enabled.";
    return {
      writes: [], warnings: [...warnings, detail, "Existing native/legacy policy is preserved; this is not a deactivation claim."],
      activation: { status: "manual", path: configPath, field: "agent.system_prompt", detail },
    };
  }
  const policy = getMarkdownAdapter(slashRoot, "Hermes Agent NULLFORM WORKFLOW Adapter", report);
  // Old deployments owned a skill as well as config.yaml. An unchanged owned config plus
  // that proven legacy registration is the only accepted proof for the first native migration;
  // a bare legacy skill presence is not ownership and never adopts the block.
  const legacySkill = join(hostHome, "skills", "nullform-workflow", "SKILL.md");
  const config = updateHermesConfigYaml(configPath, original, policy, {
    ownedConfigHash: managedFiles[configPath] || null,
    legacyRegistration: Boolean(managedFiles[legacySkill]),
  });
  return {
    writes: [[configPath, config]], warnings,
    activation: {
      status: "configured", path: configPath, field: "agent.system_prompt",
      detail: "Native agent.system_prompt configured; active-session/model execution and delegated-child inheritance remain unverified.",
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
      // A manual apply must not forget prior ownership and later restore a
      // policy the operator removed while a session override was active.
      const configPath = join(hostHome, "config.yaml");
      const priorHash = ctx.options?.managedFiles?.[configPath];
      if (ctx.hermesActivation.activation.status === "manual" && priorHash) {
        ctx.plan.managedFiles[configPath] = priorHash;
      }
      for (const [path, content] of ctx.hermesActivation.writes) writeAdapter(path, content);
      ctx.plan.activation = ctx.hermesActivation.activation;
      ctx.plan.warnings.push(...ctx.hermesActivation.warnings);
    } else {
      if (shouldWriteHome) writeMd(join(hostHome, filename));
      if (h === "openclaw") {
        // OpenClaw natively reads SOUL.md/USER.md: replace managed policy ONLY in existing files.
        // Never create identity surfaces fresh (identity-clean install); never leave stale blocks.
        for (const [name, gen] of [["SOUL.md", getOpenclawSoul], ["USER.md", getOpenclawUser]]) {
          const path = join(targetRoot, name);
          if (existsSync(path)) writeAdapter(path, applyManagedSection(readExisting(path), gen(slashRoot)));
        }
        for (const dir of new Set([targetRoot, ...(shouldWriteHome ? [hostHome] : [])])) {
          const path = join(dir, "openclaw.json");
          writeAdapter(path, updateOpenclawJson(path, preflightJson5Config(path), slashRoot));
        }
      }
    }
  }
}
