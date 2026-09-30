#!/usr/bin/env node
/**
 * tools/jev-control.mjs
 * Local control and policy management CLI for JEV automatic assistance (R06).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./jev-evaluate.mjs";
import { loadSkillCatalog, readPolicy } from "./jev-assist.mjs";
import { policyFingerprint, evaluateReport } from "./jev-evidence.mjs";

const POLICY_FILENAME = "jev-policy.json";
const REPORT_FILENAME = "jev-evaluation.json";
const DEFAULT_EXPIRY_DAYS = 30;

export function parseControlArgs(argv = process.argv.slice(2)) {
  const args = {
    command: null,
    home: process.env.HOME || process.env.USERPROFILE || process.cwd(),
    root: process.cwd(),
    report: null,
    catalog: null,
    effectiveSkills: null,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home" && argv[i + 1]) args.home = resolve(argv[++i]);
    else if (a === "--root" && argv[i + 1]) args.root = resolve(argv[++i]);
    else if (a === "--report" && argv[i + 1]) args.report = resolve(argv[++i]);
    else if (a === "--catalog" && argv[i + 1]) args.catalog = resolve(argv[++i]);
    else if (!a.startsWith("--")) positional.push(a);
  }

  args.command = positional[0] || null;
  return args;
}

function handleStatus({ home, root, policyFile, targetReportFile }) {
  if (!existsSync(policyFile)) {
    return {
      success: true,
      message: "JEV assistance is unconfigured (no jev-policy.json found).",
      status: { state: "unconfigured", enabled: false },
    };
  }

  let rawPolicy;
  try {
    rawPolicy = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch {
    return {
      success: false,
      message: "Corrupted jev-policy.json file.",
      status: { state: "corrupted", enabled: false },
    };
  }

  const verifiedPolicy = readPolicy({ home, cwd: root });
  const reportExists = existsSync(targetReportFile);

  return {
    success: true,
    message: verifiedPolicy
      ? `JEV assistance is active and verified (${verifiedPolicy.skillPassed ? "skills" : ""}${verifiedPolicy.routingPassed ? " routing" : ""}).`
      : "JEV policy exists but is inactive, expired, or invalid against local report proof.",
    policy: rawPolicy,
    status: {
      state: verifiedPolicy ? "active" : rawPolicy.enabled ? "invalid" : "disabled",
      enabled: Boolean(rawPolicy.enabled),
      verified: Boolean(verifiedPolicy),
      skillPassed: Boolean(rawPolicy.skillPassed),
      routingPassed: Boolean(rawPolicy.routingPassed),
      archetypes: rawPolicy.archetypes || [],
      expiresAt: rawPolicy.expiresAt,
      reportPresent: reportExists,
    },
  };
}

function handleDisable({ policyFile }) {
  if (!existsSync(policyFile)) {
    return {
      success: true,
      message: "No policy exists; JEV assistance is already disabled.",
    };
  }

  try {
    const rawPolicy = JSON.parse(readFileSync(policyFile, "utf8"));
    rawPolicy.enabled = false;
    writeFileSync(policyFile, JSON.stringify(rawPolicy, null, 2), "utf8");
    return {
      success: true,
      message: "JEV automatic assistance disabled successfully.",
      policy: rawPolicy,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to disable policy: ${err.message}`,
    };
  }
}

function resolveActiveCatalogFingerprint({ root, home, catalog, effectiveSkills }) {
  if (catalog) {
    if (!existsSync(catalog)) {
      return { error: `Activation rejected: catalog snapshot file not found at ${catalog}.` };
    }
    let skillsList;
    try {
      const catRaw = JSON.parse(readFileSync(catalog, "utf8"));
      skillsList = Array.isArray(catRaw) ? catRaw : catRaw?.skills;
    } catch (err) {
      return { error: `Activation rejected: failed to parse catalog snapshot JSON at ${catalog}: ${err.message}` };
    }
    if (!Array.isArray(skillsList)) {
      return { error: `Activation rejected: catalog snapshot at ${catalog} must contain an array of skills or { skills: [...] }.` };
    }
    return { fingerprint: loadSkillCatalog({ cwd: root, home, effectiveSkills: skillsList }).fingerprint };
  }
  if (effectiveSkills !== null && effectiveSkills !== undefined) {
    if (!Array.isArray(effectiveSkills)) {
      return { error: "Activation rejected: effectiveSkills must be an array." };
    }
    return { fingerprint: loadSkillCatalog({ cwd: root, home, effectiveSkills }).fingerprint };
  }
  return { fingerprint: undefined };
}

function handleEnable({
  home,
  root,
  reportPath,
  catalogFingerprint,
  catalog,
  effectiveSkills,
  policyDir,
  policyFile,
  targetReportFile,
}) {
  const effectiveReportPath = reportPath || targetReportFile;
  if (!existsSync(effectiveReportPath)) {
    return {
      success: false,
      message: `Evaluation report not found at ${effectiveReportPath}. Run tools/jev-evaluate.mjs first.`,
    };
  }

  let reportRaw;
  let report;
  try {
    reportRaw = readFileSync(effectiveReportPath, "utf8");
    report = JSON.parse(reportRaw);
  } catch {
    return { success: false, message: "Failed to read or parse evaluation report JSON." };
  }

  const hurdles = evaluateReport(report);
  if (!hurdles.skillPassed && !hurdles.routingPassed) {
    return {
      success: false,
      message: "Activation rejected: evaluation report hurdles failed (no passing capabilities meeting quality and cost requirements).",
      hurdles,
    };
  }

  const resolved = resolveActiveCatalogFingerprint({ root, home, catalog, effectiveSkills });
  if (resolved.error) {
    return { success: false, message: resolved.error };
  }
  const activeCatalogFp = catalogFingerprint ?? resolved.fingerprint;

  if (activeCatalogFp && report.catalogFingerprint && activeCatalogFp !== report.catalogFingerprint) {
    return {
      success: false,
      message: `Activation rejected: report catalog fingerprint (${report.catalogFingerprint}) does not match active skill catalog (${activeCatalogFp}). Re-run evaluation.`,
    };
  }

  const targetCatalogFp = report.catalogFingerprint || activeCatalogFp || loadSkillCatalog({ cwd: root, home }).fingerprint;
  const reportSha = sha256(reportRaw);
  const fp = policyFingerprint({
    catalogFingerprint: targetCatalogFp,
    candidateModel: report.candidateModel,
    baselineModel: report.baselineModel,
    decisionModel: report.decisionModel || "typesafe/jev-1.13",
  });

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const policyV1 = {
    version: 1,
    enabled: true,
    expiresAt,
    catalogFingerprint: targetCatalogFp,
    candidateModel: report.candidateModel,
    baselineModel: report.baselineModel,
    decisionModel: report.decisionModel || "typesafe/jev-1.13",
    fingerprint: fp,
    skillPassed: hurdles.skillPassed,
    routingPassed: hurdles.routingPassed,
    reportSha256: reportSha,
    archetypes: hurdles.archetypes,
    decisionSnapshots: Array.isArray(report.decisionSnapshots) ? report.decisionSnapshots : [],
    modelPrices: report.modelPrices || undefined,
  };

  mkdirSync(policyDir, { recursive: true });
  if (resolve(effectiveReportPath) !== resolve(targetReportFile)) {
    writeFileSync(targetReportFile, reportRaw, "utf8");
  }
  writeFileSync(policyFile, JSON.stringify(policyV1, null, 2), "utf8");

  return {
    success: true,
    message: `JEV automatic assistance enabled successfully (skills: ${hurdles.skillPassed ? "YES" : "NO"}, routing: ${hurdles.routingPassed ? "YES" : "NO"}).`,
    policy: policyV1,
    hurdles,
  };
}

export async function executeControl({
  command,
  home,
  root = process.cwd(),
  reportPath = null,
  catalogFingerprint = undefined,
  catalog = null,
  effectiveSkills = null,
}) {
  const policyDir = join(home, ".omp", "agent");
  const policyFile = join(policyDir, POLICY_FILENAME);
  const targetReportFile = join(policyDir, REPORT_FILENAME);

  if (command === "status") {
    return handleStatus({ home, root, policyFile, targetReportFile });
  }
  if (command === "disable") {
    return handleDisable({ policyFile });
  }
  if (command === "enable") {
    return handleEnable({
      home,
      root,
      reportPath,
      catalogFingerprint,
      catalog,
      effectiveSkills,
      policyDir,
      policyFile,
      targetReportFile,
    });
  }

  return {
    success: false,
    message: `Unknown command '${command}'. Use status, enable, or disable.`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseControlArgs();
  if (!parsed.command) {
    console.error("Usage: jev-control.mjs <status|enable|disable> [--home <dir>] [--root <dir>] [--report <path>] [--catalog <path>]");
    process.exit(1);
  }
  executeControl({
    command: parsed.command,
    home: parsed.home,
    root: parsed.root,
    reportPath: parsed.report,
    catalog: parsed.catalog,
  })
    .then((res) => {
      console.log(res.message);
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
