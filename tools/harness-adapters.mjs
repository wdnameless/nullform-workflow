/**
 * tools/harness-adapters.mjs — Adapter configuration mutators and home assets installer
 * for the 8 supported target harnesses.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyManagedSection,
  applyCursorMdc,
  updateOpencodeJson,
  updateOpenclawJson,
  getMarkdownAdapter,
  loadYaml,
  hashContent,
  preflightJsoncConfig,
  preflightJson5Config,
  preflightYamlConfig,
  resolveOpencodeConfigPaths,
} from "./harness-config.mjs";
import { updateHermesConfigYaml } from "./hermes-policy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "..");

// Identity surfaces are never written; these signatures exist only to disclose a legacy
// Nullform-looking identity block that the installer preserves and therefore leaves active.
const LEGACY_IDENTITY_SIGNATURES = [
  ["SOUL.md", "# OpenClaw SOUL: NULLFORM WORKFLOW"],
  ["USER.md", "# OpenClaw USER: Context & Operating Preferences"],
];

export function installOmpHomeAssets({
  targetRoot,
  slashRoot,
  userHome,
  hostHome,
  plan,
  writeAdapter,
  readExisting,
  options,
}) {
  const homeAgentDir = hostHome;
  const lawSource = join(REPO_ROOT, "agent", "AGENTS.md");
  const rawLaw = existsSync(lawSource)
    ? readFileSync(lawSource, "utf8").split("<HARNESS>").join(slashRoot)
    : getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law");
  const homeAgentsFile = join(homeAgentDir, "AGENTS.md");
  writeAdapter(homeAgentsFile, applyManagedSection(readExisting(homeAgentsFile), rawLaw));

  // .harness-root pointer: follow existing ownership/manual-conflict pattern
  const harnessRootFile = join(homeAgentDir, ".harness-root");
  const expectedContent = `${targetRoot}\n`;
  const managedFiles = options?.managedFiles || {};
  const priorHash = managedFiles[harnessRootFile];

  if (existsSync(harnessRootFile)) {
    const current = readFileSync(harnessRootFile, "utf8");
    const currentHash = hashContent(current);
    if (current === expectedContent) {
      writeAdapter(harnessRootFile, expectedContent);
    } else if (priorHash && currentHash === priorHash) {
      writeAdapter(harnessRootFile, expectedContent);
    } else {
      plan.preservedAssets.count++;
      plan.preservedAssets[priorHash ? "modifiedOwned" : "unowned"]++;
      if (plan.preservedAssets.examples.length < 3) {
        plan.preservedAssets.examples.push({ path: harnessRootFile, reason: priorHash ? "modifiedOwned" : "unowned" });
      }
      plan.warnings.push(`Existing .harness-root in ${homeAgentDir} is human-owned or modified; preserved without overwrite.`);
    }
  } else {
    writeAdapter(harnessRootFile, expectedContent);
  }

  // Preserve pre-existing legacy assets in hostHome / agentsHome and warn that extras may remain active
  const agentsHome = join(userHome, ".agents");
  const legacyExtras = [];
  if (existsSync(join(homeAgentDir, "mcp.json"))) legacyExtras.push("mcp.json");
  if (existsSync(join(homeAgentDir, "agents"))) legacyExtras.push("agents");
  if (existsSync(join(homeAgentDir, "rules"))) legacyExtras.push("rules");
  if (existsSync(join(agentsHome, "rules"))) legacyExtras.push("~/.agents/rules");
  if (existsSync(join(agentsHome, "skills"))) legacyExtras.push("~/.agents/skills");
  if (existsSync(join(homeAgentDir, "extensions"))) legacyExtras.push("extensions");

  if (legacyExtras.length > 0) {
    plan.warnings.push(
      `Pre-existing legacy OMP assets detected (${legacyExtras.join(", ")}); preserved without modification and extras may remain active. Portable workflow assets remain in ${targetRoot}.`
    );
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
    if (h === "codex") {
      const overrideTarget = join(targetRoot, "AGENTS.override.md");
      const overrideHome = join(hostHome, "AGENTS.override.md");
      if (existsSync(overrideTarget) || (shouldWriteHome && existsSync(overrideHome))) {
        ctx.plan.warnings.push(
          "Codex AGENTS.override.md is present and takes precedence over AGENTS.md; human override is preserved and may shadow generated workflow instructions."
        );
      }
    } else if (h === "openhuman") {
      ctx.plan.warnings.push(
        "OpenHuman runtime AGENTS.md loader is unverified in source; native session behavior remains manual/documented-unknown until a verified consumer is configured."
      );
    }
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
        // Identity surfaces (SOUL.md/USER.md) are NEVER created, augmented, replaced, deleted or
        // adopted here; AGENTS.md and openclaw.json carry all workflow policy. A legacy
        // Nullform-looking identity block is preserved byte-identical and disclosed as possibly
        // active, and an identity symlink is never followed outside its declared root.
        for (const dir of new Set([targetRoot, ...(shouldWriteHome ? [hostHome] : [])])) {
          for (const [name, signature] of LEGACY_IDENTITY_SIGNATURES) {
            let entry = null;
            try { entry = lstatSync(join(dir, name)); } catch { continue; }
            if (entry.isSymbolicLink()) {
              ctx.plan.warnings.push(`${name} in ${dir} is an identity symlink; preserved unread, so any legacy policy it resolves to may remain active.`);
            } else if (entry.isFile() && readExisting(join(dir, name)).includes(signature)) {
              ctx.plan.warnings.push(`${name} in ${dir} still contains a legacy NULLFORM identity block; identity bytes are preserved unchanged and that legacy policy may remain active.`);
            }
          }
          const path = join(dir, "openclaw.json");
          writeAdapter(path, updateOpenclawJson(path, preflightJson5Config(path), slashRoot));
        }
      }
    }
  }
}
