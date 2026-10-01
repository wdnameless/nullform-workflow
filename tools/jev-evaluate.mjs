#!/usr/bin/env node
/**
 * tools/jev-evaluate.mjs
 * Paired empirical evaluation CLI for JEV automatic assistance (R05, R06).
 * Skills-only: pinned baseline chat vs JEV typed classifier.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { readCredential, loadSkillCatalog } from "./jev-assist.mjs";
import { policyFingerprint, evaluateReport } from "./jev-evidence.mjs";
import {
  OPENROUTER_FALLBACK_RATES,
  executeSkillCase,
} from "./jev-evaluation-cases.mjs";

const DEFAULT_BASELINE = "google/gemini-3.8-flash";
const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";
const DEFAULT_MAX_COST_USD = 1.0;

export function parseEvalArgs(argv = process.argv.slice(2)) {
  const args = {
    root: process.cwd(),
    home: process.env.HOME || process.env.USERPROFILE || process.cwd(),
    baseline: DEFAULT_BASELINE,
    decisionModel: DEFAULT_DECISION_MODEL,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    output: null,
    catalog: null,
    effectiveSkills: null,
    fixtureOnly: false,
    dryRun: false,
    interleave: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) args.root = resolve(argv[++i]);
    else if (a === "--home" && argv[i + 1]) args.home = resolve(argv[++i]);
    else if (a === "--baseline" && argv[i + 1]) args.baseline = argv[++i];
    else if (a === "--decision-model" && argv[i + 1]) args.decisionModel = argv[++i];
    else if (a === "--max-cost-usd" && argv[i + 1]) {
      const val = argv[++i];
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --max-cost-usd: must be finite non-negative number, got '${val}'`);
      }
      args.maxCostUsd = parsed;
    } else if (a === "--output" && argv[i + 1]) args.output = resolve(argv[++i]);
    else if (a === "--catalog" && argv[i + 1]) args.catalog = resolve(argv[++i]);
    else if (a === "--fixture-only") args.fixtureOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-interleave") args.interleave = false;
  }

  if (!args.output) {
    args.output = join(args.home, ".omp", "agent", "jev-evaluation.json");
  }
  return args;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isCalibCase(c) {
  return Boolean(
    c?.isCalibration === true ||
    c?.split === "calibration" ||
    (typeof c?.id === "string" && c.id.startsWith("calib"))
  );
}

function resolveExpectedSet(c) {
  const arr = Array.isArray(c.expectedSkills)
    ? c.expectedSkills
    : c.expectedSkill && c.expectedSkill !== "none"
      ? [c.expectedSkill]
      : [];
  return new Set(arr.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean));
}

function aggregateSkillStats(skillCases) {
  const stats = {
    baselineCost: 0,
    candidateCost: 0,
    baselineAttempted: 0,
    baselineCorrect: 0,
    baselineFP: 0,
    candidateAttempted: 0,
    candidateCorrect: 0,
    candidateFP: 0,
    criticalMisses: 0,
    safetyTotal: 0,
    safetyMisses: 0,
    eligible: 0,
    rawSpend: 0,
  };

  for (const c of skillCases) {
    stats.rawSpend += (c.baselineCostUsd || 0) + (c.candidateCostUsd || 0);
    const isCalib = isCalibCase(c);
    const isSafety = Boolean(c.isSafety || c.isSafetyCanary || c.kind === "safety");

    if (isSafety) {
      if (!isCalib) stats.safetyTotal++;
      if (c.safetyMiss || c.candidateAttempted || (c.candidateSkill && c.candidateSkill !== "none")) {
        if (!isCalib) stats.safetyMisses++;
      }
    } else if (!isCalib) {
      stats.eligible++;
    }

    if (c.criticalMiss && !isCalib) stats.criticalMisses++;

    const expectedSet = resolveExpectedSet(c);
    const isExpectedNone = expectedSet.size === 0;

    const bAttempted = Boolean(c.baselineAttempted ?? (c.baselineSkill && c.baselineSkill !== "none"));
    if (bAttempted && !isCalib) {
      stats.baselineAttempted++;
      const bSkill = c.baselineSkill && c.baselineSkill !== "none" ? c.baselineSkill : null;
      const bCorrect = isExpectedNone ? bSkill === null : (bSkill !== null && expectedSet.has(bSkill));
      if (bCorrect) stats.baselineCorrect++;
      else if (isExpectedNone) stats.baselineFP++;
    }

    const cAttempted = Boolean(
      typeof c.confidence === "number"
        ? (c.candidateAttempted && c.confidence >= 0.8)
        : c.candidateAttempted
    );
    if (cAttempted && !isCalib) {
      stats.candidateAttempted++;
      const cSkill = c.candidateSkill && c.candidateSkill !== "none" ? c.candidateSkill : null;
      const cCorrect = isExpectedNone ? cSkill === null : (cSkill !== null && expectedSet.has(cSkill));
      if (cCorrect) stats.candidateCorrect++;
      else if (isExpectedNone) stats.candidateFP++;
    }

    if (!isCalib) {
      stats.baselineCost += c.baselineCostUsd || 0;
      stats.candidateCost += c.candidateCostUsd || 0;
    }
  }
  return stats;
}

function countTotalRequests(skillCases) {
  return skillCases.reduce(
    (acc, c) =>
      acc +
      (Boolean(c.baselineRequested ?? c.baselineAttempted) ? 1 : 0) +
      (Boolean(c.candidateRequested ?? c.candidateAttempted) ? 1 : 0),
    0
  );
}

export function buildReportV2({
  catalogFingerprint,
  catalogSource = "filesystem",
  baselineModel,
  decisionModel,
  datasetHashes,
  decisionSnapshots,
  calibrationCount = 0,
  heldoutCount = 0,
  skillCases,
  maxCostUsd,
  totalSpend = 0,
  unknownSpend = 0,
  errors = 0,
}) {
  const skill = aggregateSkillStats(skillCases);
  const totalRequests = countTotalRequests(skillCases);

  const fp = policyFingerprint({ catalogFingerprint, baselineModel, decisionModel });
  const allRawSpend = skill.rawSpend;
  const effectiveTotalSpend = totalSpend > 0 ? totalSpend : allRawSpend;
  const effectiveUnknownSpend = Number((unknownSpend || 0).toFixed(6));

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    catalogFingerprint,
    catalogSource,
    baselineModel,
    decisionModel,
    fingerprint: fp,
    datasetHashes,
    decisionSnapshots: Array.from(new Set(decisionSnapshots)),
    calibration: { total: calibrationCount, hash: datasetHashes.calibration },
    heldout: { total: heldoutCount, hash: datasetHashes.heldout },
    skills: {
      total: skillCases.length,
      eligible: skill.eligible,
      safetyTotal: skill.safetyTotal,
      safetyMisses: skill.safetyMisses,
      baseline: {
        attempted: skill.baselineAttempted,
        correct: skill.baselineCorrect,
        falsePositives: skill.baselineFP,
        costUsd: Number(skill.baselineCost.toFixed(6)),
      },
      candidate: {
        attempted: skill.candidateAttempted,
        correct: skill.candidateCorrect,
        falsePositives: skill.candidateFP,
        criticalMisses: skill.criticalMisses,
        costUsd: Number(skill.candidateCost.toFixed(6)),
      },
      cases: skillCases,
    },
    requests: totalRequests,
    errors,
    spendUsd: Number((effectiveTotalSpend + effectiveUnknownSpend).toFixed(6)),
    unknownSpendUsd: effectiveUnknownSpend,
    maxCostUsd,
    completed: errors === 0 && effectiveUnknownSpend === 0,
  };
}

function loadFixturesAndCatalog(options) {
  const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "tests", "fixtures", "jev");
  const calibPath = join(fixturesDir, "calibration.json");
  const heldoutPath = join(fixturesDir, "heldout.json");

  if (!existsSync(calibPath) || !existsSync(heldoutPath)) {
    throw new Error(`Evaluation fixtures missing in ${fixturesDir}`);
  }

  const calibRaw = readFileSync(calibPath, "utf8");
  const heldoutRaw = readFileSync(heldoutPath, "utf8");

  const datasetHashes = {
    calibration: sha256(calibRaw),
    heldout: sha256(heldoutRaw),
  };

  let calibCases;
  let heldoutCases;
  try {
    calibCases = JSON.parse(calibRaw);
    heldoutCases = JSON.parse(heldoutRaw);
  } catch (err) {
    throw new Error(`Failed to parse evaluation fixtures: ${err.message}`);
  }

  let effectiveSkills = options.effectiveSkills || null;
  let catalogSource = "filesystem";
  if (!effectiveSkills && options.catalog) {
    if (!existsSync(options.catalog)) {
      throw new Error(`Catalog snapshot file not found at ${options.catalog}`);
    }
    try {
      const parsedCat = JSON.parse(readFileSync(options.catalog, "utf8"));
      effectiveSkills = Array.isArray(parsedCat) ? parsedCat : parsedCat?.skills;
      if (!Array.isArray(effectiveSkills)) {
        throw new Error(`Catalog snapshot at ${options.catalog} must be a JSON array or { skills: [...] }`);
      }
      catalogSource = `snapshot (${options.catalog})`;
    } catch (err) {
      throw new Error(`Failed to load catalog snapshot from ${options.catalog}: ${err.message}`);
    }
  }

  const catalog = loadSkillCatalog({ cwd: options.root, home: options.home, effectiveSkills });
  return { calibCases, heldoutCases, datasetHashes, catalog, catalogSource };
}

function createCheckpointWriter(options, meta) {
  const { catalog, catalogSource, datasetHashes, calibCases, heldoutCases, skillResultCases, decisionSnapshots } = meta;
  return (completed = false, failureReason = null, spendData = {}) => {
    if (!options.output) return null;
    try {
      const interimReport = buildReportV2({
        catalogFingerprint: catalog.fingerprint,
        catalogSource,
        baselineModel: options.baseline,
        decisionModel: options.decisionModel,
        datasetHashes,
        decisionSnapshots,
        calibrationCount: calibCases.length,
        heldoutCount: heldoutCases.length,
        skillCases: skillResultCases,
        maxCostUsd: options.maxCostUsd,
        totalSpend: spendData.measuredSpend ?? 0,
        unknownSpend: spendData.unknownSpend ?? 0,
        errors: completed ? (spendData.totalErrors ?? 0) : Math.max(1, spendData.totalErrors ?? 0),
      });
      if (!completed) {
        interimReport.completed = false;
        if (failureReason) interimReport.interrupted = failureReason;
      }
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, JSON.stringify(interimReport, null, 2), "utf8");
      return interimReport;
    } catch {
      return null;
    }
  };
}

export async function runEvaluation(optionsInput = parseEvalArgs()) {
  const defaults = parseEvalArgs([]);
  const options = Array.isArray(optionsInput) ? parseEvalArgs(optionsInput) : { ...defaults, ...(optionsInput || {}) };
  const maxCost = Number(options.maxCostUsd);
  if (!Number.isFinite(maxCost) || maxCost < 0) {
    throw new Error(`Evaluation aborted: invalid maxCostUsd '${options.maxCostUsd}' (must be finite non-negative number)`);
  }

  const { calibCases, heldoutCases, datasetHashes, catalog, catalogSource } = loadFixturesAndCatalog(options);

  if (options.fixtureOnly || options.dryRun) {
    console.log(`JEV Evaluation: ${options.dryRun ? "Dry run (plan only, zero API)" : "Fixtures verified successfully."}`);
    console.log(`- Calibration: ${calibCases.length}, Heldout: ${heldoutCases.length}`);
    console.log(`- Catalog source: ${catalogSource}`);
    console.log(`- Catalog: ${catalog.skills.length} skills (fingerprint: ${catalog.fingerprint})`);
    return {
      success: true,
      dryRun: Boolean(options.dryRun),
      fixtureOnly: Boolean(options.fixtureOnly),
      datasetHashes,
      catalogFingerprint: catalog.fingerprint,
      catalogSource,
      plan: {
        baselineModel: options.baseline,
        decisionModel: options.decisionModel,
        maxCostUsd: options.maxCostUsd,
        plannedCases: calibCases.length + heldoutCases.length,
      },
    };
  }

  const apiKey = options.apiKey || (await readCredential());
  if (!apiKey && !options.dryRun) {
    throw new Error("Missing OpenRouter credential in environment (OPENROUTER_API_KEY) or native vault.");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const ratesTable = OPENROUTER_FALLBACK_RATES;

  const state = {
    measuredSpend: 0,
    unknownSpend: 0,
    totalErrors: 0,
    decisionSnapshots: [],
    skillResultCases: [],
  };

  const writeCheckpoint = createCheckpointWriter(options, {
    catalog,
    catalogSource,
    datasetHashes,
    calibCases,
    heldoutCases,
    skillResultCases: state.skillResultCases,
    decisionSnapshots: state.decisionSnapshots,
  });

  const catalogSkillsList = catalog.skills.map((s) => `- ${s.name}: ${s.description || "General utility"}`).join("\n");
  const allSkillCases = [...calibCases, ...heldoutCases];

  try {
    for (let idx = 0; idx < allSkillCases.length; idx++) {
      const res = await executeSkillCase({
        c: allSkillCases[idx],
        idx,
        options,
        apiKey,
        catalog,
        ratesTable,
        fetchImpl,
        catalogSkillsList,
        measuredSpend: state.measuredSpend,
        unknownSpend: state.unknownSpend,
      });
      state.measuredSpend += res.measuredDelta;
      state.unknownSpend += res.unknownDelta;
      state.totalErrors += res.errorsDelta;
      if (res.decisionModel) state.decisionSnapshots.push(res.decisionModel);
      state.skillResultCases.push(res.caseRecord);
      writeCheckpoint(false, null, state);
    }
  } catch (err) {
    state.totalErrors++;
    writeCheckpoint(false, "execution-interrupted", state);
    throw err;
  }

  const report = writeCheckpoint(true, null, state);
  const hurdleEval = evaluateReport(report, {
    datasetContext: {
      hashes: datasetHashes,
      calibration: calibCases,
      heldout: heldoutCases,
    },
  });

  console.log("=== JEV Paired Evaluation Report ===");
  console.log(`Report written to: ${options.output}`);
  console.log(`Fingerprint: ${report.fingerprint}`);
  console.log(`Total Spend: $${report.spendUsd.toFixed(6)} / $${report.maxCostUsd}`);
  console.log(`Skill Hurdles: ${hurdleEval.skillPassed ? "PASSED" : "FAILED"}`);

  return { success: true, report, hurdles: hurdleEval };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runEvaluation().catch((err) => {
    console.error(`Evaluation failed: ${err.message}`);
    process.exit(1);
  });
}
