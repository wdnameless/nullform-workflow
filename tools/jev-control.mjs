#!/usr/bin/env node
/**
 * tools/jev-control.mjs
 * Local control and policy management CLI for JEV automatic assistance (R06).
 *
 * Commands:
 *   status   — Inspects active policy, report proof SHA-256, and catalog fingerprint match.
 *   enable   — Validates empirical evaluation report, recomputes hurdles, and persists policy v1.
 *   disable  — Sets policy to disabled state without deleting proof.
 *
 * Invariants:
 *   - No network traffic or API key required.
 *   - Validates exact Report v1 schema, SHA-256 hash, and raw denominator hurdles via evaluateReport().
 *   - Fails if proof report is stale, incomplete, corrupted, or failed quality/cost hurdles.
 *   - Permits only measured, actually passed capabilities and archetypes.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./jev-evaluate.mjs";
import {
  loadSkillCatalog,
  policyFingerprint,
  evaluateReport,
  readPolicy,
} from "./jev-assist.mjs";

const POLICY_FILENAME = "jev-policy.json";
const REPORT_FILENAME = "jev-evaluation.json";
const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Parses CLI arguments for jev-control.
 * @param {string[]} argv
 * @returns {{
 *   command: "status" | "enable" | "disable",
 *   home: string,
 *   root: string,
 *   reportPath: string | null,
 *   catalogFingerprint?: string,
 * }}
 */
export function parseControlArgs(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  let home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  let root = process.cwd();
  let reportPath = null;
  let catalogFingerprint = undefined;
  let catalog = null;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home" && argv[i + 1]) home = resolve(argv[++i]);
    else if (a === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else if (a === "--report" && argv[i + 1]) reportPath = resolve(argv[++i]);
    else if (a === "--catalog-fingerprint" && argv[i + 1]) catalogFingerprint = argv[++i];
    else if (a === "--catalog" && argv[i + 1]) catalog = resolve(argv[++i]);
  }

  return {
    command: ["status", "enable", "disable"].includes(command) ? command : "status",
    home,
    root,
    reportPath,
    catalogFingerprint,
    catalog,
  };
}


/**
 * Executes a control command (status, enable, disable).
 * @param {{
 *   command: string,
 *   home: string,
 *   root?: string,
 *   reportPath?: string | null,
 *   catalogFingerprint?: string,
 * }} options
 * @returns {Promise<{ success: boolean, message: string, policy?: any, status?: any }>}
 */
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
    const rawPolicyExists = existsSync(policyFile);
    if (!rawPolicyExists) {
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

  if (command === "disable") {
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

  if (command === "enable") {
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
      return {
        success: false,
        message: "Failed to read or parse evaluation report JSON.",
      };
    }

    // Hurdle validation using shared pure evaluator
    const hurdles = evaluateReport(report);
    if (!hurdles.skillPassed && !hurdles.routingPassed) {
      return {
        success: false,
        message:
          "Activation rejected: evaluation report hurdles failed (no passing capabilities meeting quality and cost requirements).",
        hurdles,
      };
    }

    // Catalog fingerprint verification:
    // When a catalog snapshot, effectiveSkills, or explicit catalogFingerprint is supplied,
    // fail closed on nonexistent/malformed snapshots and ensure exact match against report.catalogFingerprint.
    // Only when none is supplied may activation use the verified report.catalogFingerprint.
    let activeCatalogFp = catalogFingerprint;
    if (catalog) {
      if (!existsSync(catalog)) {
        return {
          success: false,
          message: `Activation rejected: catalog snapshot file not found at ${catalog}.`,
        };
      }
      let skillsList;
      try {
        const catRaw = JSON.parse(readFileSync(catalog, "utf8"));
        skillsList = Array.isArray(catRaw) ? catRaw : catRaw?.skills;
      } catch (err) {
        return {
          success: false,
          message: `Activation rejected: failed to parse catalog snapshot JSON at ${catalog}: ${err.message}`,
        };
      }
      if (!Array.isArray(skillsList)) {
        return {
          success: false,
          message: `Activation rejected: catalog snapshot at ${catalog} must contain an array of skills or { skills: [...] }.`,
        };
      }
      activeCatalogFp = loadSkillCatalog({ cwd: root, home, effectiveSkills: skillsList }).fingerprint;
    } else if (effectiveSkills !== null && effectiveSkills !== undefined) {
      if (!Array.isArray(effectiveSkills)) {
        return {
          success: false,
          message: "Activation rejected: effectiveSkills must be an array.",
        };
      }
      activeCatalogFp = loadSkillCatalog({ cwd: root, home, effectiveSkills }).fingerprint;
    }

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

    // Copy report to standard location if reading from custom source
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

  return {
    success: false,
    message: `Unknown command '${command}'. Use status, enable, or disable.`,
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseControlArgs();
  executeControl(args)
    .then((res) => {
      console.log(res.message);
      if (res.policy) {
        console.log(JSON.stringify(res.policy, null, 2));
      }
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
