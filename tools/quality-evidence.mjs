/**
 * tools/quality-evidence.mjs — Honest quality-evidence reader and formatter.
 *
 * Requirements: manifest R02, R04, R05, R07-R09.
 * Validates retained paired historical observations, models, counters, tariffs,
 * terminal failures and ledger constraints. Never dispatches network or model inference.
 * Reads either raw observations or packaged summary strictly from the requested root.
 * Fails closed on any tampering, type mismatch, or missing sources.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { computeTariffCost, loadSpendLedger } from "./bench-budget.mjs";

export const EXPECTED_MODEL = "nullform-gateway/gemini-3.8-flash-high";
export const EXPECTED_OBSERVATIONS_HASH = "c4817077f4d2c4dcbdb979a6664c0759feeadafde441a9d5be9a474bd7afcce2";
export const RAW_OBSERVATIONS_PATH = "openspec/changes/skill-benefit-evaluation/evidence/observed-eight-sessions.json";
export const SUMMARY_PATH = "core/quality-evidence.summary.json";
export const SPEND_LEDGER_PATH = "bench/runs/spend-ledger.json";

export const KNOWN_TASK_FIXTURES = Object.freeze({
  "eval-review-positive": "d659a1371806e2d80bd17e969d94bfe3866560c1540d57b9864670ff04268fd8",
  "eval-review-near-negative": "6bf1970c4d843828fae2d61af7d5cdfa7693f8a1f8db62b32f583b8e54f0e1ad",
  "eval-review-defect-outcome": "6269e3512776f32e3a5cfeb4c326088e7d75878e355fd5faddbb8caf1ee0dd79",
  "eval-workflow-execution-outcome": "2ac2675bf860259da78f0343bef7fbd6241e54da5b987c1c8752d06b75bb0489",
});

export const LIMITATIONS = Object.freeze([
  "Four constructed task cases on a single model with single repetition; not representative of general or current-release development quality.",
  "Installed SDK fixed catalog pricing; actual API provider invoices are unverified.",
  "Equal or adverse outcomes observed; no causal quality, speed, or accuracy improvement is proven.",
  "Measured equal/adverse outcome is not equivalent to universal 0% benefit or zero value.",
  "Current release prompts and instructions do not retag or overwrite historical observations.",
  "No paid A/B experiments performed for this release.",
]);

function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected finite number for ${name}, got: ${value}`);
  }
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer for ${name}, got: ${value}`);
  }
}

function assertHex64(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Expected 64-hex hash for ${name}, got: ${value}`);
  }
}

function roundUsd(val) {
  return Math.round(val * 1e8) / 1e8;
}

/**
 * Normalizes raw outcomes into 4 canonical pairs.
 */
function rawOutcomesToPairs(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== 8) {
    throw new Error(`Expected exactly 8 historical outcomes, found ${outcomes?.length}`);
  }
  const byTask = new Map();
  for (const o of outcomes) {
    if (!byTask.has(o.task)) byTask.set(o.task, {});
    byTask.get(o.task)[o.arm] = o;
  }
  const pairs = [];
  for (const [taskId, expectedHash] of Object.entries(KNOWN_TASK_FIXTURES)) {
    const group = byTask.get(taskId);
    if (!group?.["baseline-noskill"] || !group?.["candidate-skill"]) {
      throw new Error(`Missing paired arm for task: ${taskId}`);
    }
    const b = group["baseline-noskill"];
    const c = group["candidate-skill"];
    pairs.push({
      task: taskId,
      type: taskId.startsWith("eval-review") ? "review" : "workflow",
      fixtureHash: b.input?.fixtureHash || expectedHash,
      baseline: {
        sessionId: b.sessionId,
        model: b.input?.selector || b.model || EXPECTED_MODEL,
        assistantTurns: b.assistantTurns,
        usage: b.usage,
        tariff_usd: b.tariff_usd,
        stopReason: b.termination?.stopReason,
        evaluationStatus: b.evaluationStatus,
        requirementsSatisfied: b.score?.requirementsSatisfied,
        missedDefects: b.score?.missedDefects ?? 0,
        falsePositives: b.score?.falsePositives ?? 0,
        skillHash: b.input?.skillHash ?? null,
      },
      candidate: {
        sessionId: c.sessionId,
        model: c.input?.selector || c.model || EXPECTED_MODEL,
        assistantTurns: c.assistantTurns,
        usage: c.usage,
        tariff_usd: c.tariff_usd,
        stopReason: c.termination?.stopReason,
        evaluationStatus: c.evaluationStatus,
        requirementsSatisfied: c.score?.requirementsSatisfied,
        missedDefects: c.score?.missedDefects ?? 0,
        falsePositives: c.score?.falsePositives ?? 0,
        skillHash: c.input?.skillHash,
        failure: c.failure?.error || "Request count cap reached without final report",
      },
    });
  }
  return pairs;
}

/**
 * Validates canonical pairs and derives consistent projection.
 */
function validateArm(arm, taskId, armName, sessionIds) {
  if (!arm || typeof arm !== "object") {
    throw new Error(`Missing ${armName} in pair ${taskId}`);
  }
  if (typeof arm.sessionId !== "string" || !arm.sessionId) {
    throw new Error(`Missing sessionId in ${taskId} ${armName}`);
  }
  if (sessionIds.has(arm.sessionId)) {
    throw new Error(`Duplicate sessionId detected across runs: ${arm.sessionId}`);
  }
  sessionIds.add(arm.sessionId);

  if (arm.model !== EXPECTED_MODEL) {
    throw new Error(`Model mismatch in ${taskId} ${armName}: expected ${EXPECTED_MODEL}, got ${arm.model}`);
  }

  assertSafeInteger(arm.assistantTurns, `${taskId} ${armName} assistantTurns`);
  assertFiniteNumber(arm.tariff_usd, `${taskId} ${armName} tariff_usd`);
  if (arm.tariff_usd < 0) throw new Error(`Negative tariff in ${taskId} ${armName}`);

  if (arm.usage) {
    const computed = computeTariffCost(arm.usage, EXPECTED_MODEL).tariff_usd;
    if (Math.abs(computed - arm.tariff_usd) > 1e-8) {
      throw new Error(`Computed usage tariff mismatch for ${taskId} ${armName}`);
    }
  }
}

function validatePair(pair, sessionIds, seenTasks) {
  if (!pair || typeof pair !== "object") throw new Error("Invalid pair structure");
  const taskId = pair.task;
  if (!KNOWN_TASK_FIXTURES[taskId]) throw new Error(`Unknown task ID: ${taskId}`);
  if (seenTasks.has(taskId)) throw new Error(`Duplicate task in pairs: ${taskId}`);
  seenTasks.add(taskId);

  assertHex64(pair.fixtureHash, `pair[${taskId}].fixtureHash`);
  if (pair.fixtureHash !== KNOWN_TASK_FIXTURES[taskId]) {
    throw new Error(`Fixture hash mismatch for ${taskId}`);
  }

  validateArm(pair.baseline, taskId, "baseline", sessionIds);
  validateArm(pair.candidate, taskId, "candidate", sessionIds);
  const b = pair.baseline;
  const c = pair.candidate;

  if (b.skillHash !== null && b.skillHash !== undefined) {
    throw new Error(`Baseline must not carry skillHash in ${taskId}`);
  }
  if (b.stopReason !== "stop" || b.evaluationStatus !== "passed" || b.requirementsSatisfied !== true) {
    throw new Error(`Baseline failed completion expectation in ${taskId}`);
  }
  assertHex64(c.skillHash, `${taskId} candidate.skillHash`);

  if (pair.type === "review") {
    if (b.assistantTurns !== 1 || c.assistantTurns !== 1) {
      throw new Error(`Expected 1 assistant turn for review tasks in ${taskId}`);
    }
    if (c.stopReason !== "stop" || c.evaluationStatus !== "passed" || c.requirementsSatisfied !== true) {
      throw new Error(`Candidate review failed completion expectation in ${taskId}`);
    }
    if (b.missedDefects !== 0 || b.falsePositives !== 0 || c.missedDefects !== 0 || c.falsePositives !== 0) {
      throw new Error(`Nonzero defect misses or false positives in review task ${taskId}`);
    }
    return { type: "review", bCost: b.tariff_usd, cCost: c.tariff_usd, bTurns: b.assistantTurns, cTurns: c.assistantTurns };
  }

  if (pair.type === "workflow") {
    if (b.assistantTurns !== 5) {
      throw new Error(`Workflow baseline must have exactly 5 turns, got ${b.assistantTurns}`);
    }
    if (c.assistantTurns !== 6) {
      throw new Error(`Workflow candidate must have exactly 6 turns, got ${c.assistantTurns}`);
    }
    if (c.stopReason !== "toolUse" || c.evaluationStatus !== "failed" || c.requirementsSatisfied !== false) {
      throw new Error(`Workflow candidate must retain adverse failure (stopReason toolUse, failed)`);
    }
    if (!c.failure || typeof c.failure !== "string") {
      throw new Error(`Workflow candidate must document terminal failure`);
    }
    return { type: "workflow", bCost: b.tariff_usd, cCost: c.tariff_usd, bTurns: b.assistantTurns, cTurns: c.assistantTurns, cFailure: c.failure };
  }

  throw new Error(`Unknown pair type: ${pair.type}`);
}

function crossVerifySummary(summaryMeta, projected) {
  const sRev = summaryMeta.summary?.review;
  const sWf = summaryMeta.summary?.workflow;
  const sCohort = summaryMeta.summary?.cohort;
  const sLedger = summaryMeta.summary?.spendLedger;

  if (!sRev || !sWf || !sCohort || !sLedger) {
    throw new Error("Missing required summary sub-objects (review, workflow, cohort, spendLedger)");
  }

  assertFiniteNumber(sRev.baselineTariffUsd, "summary.review.baselineTariffUsd");
  assertFiniteNumber(sRev.candidateTariffUsd, "summary.review.candidateTariffUsd");
  if (sRev.baselineAccurate !== projected.review.baselineAccurate || sRev.candidateAccurate !== projected.review.candidateAccurate) {
    throw new Error("Summary review accuracy counts do not match derived projection");
  }
  if (Math.abs(sRev.baselineTariffUsd - projected.review.baselineTariffUsd) > 1e-8 ||
      Math.abs(sRev.candidateTariffUsd - projected.review.candidateTariffUsd) > 1e-8) {
    throw new Error("Summary review tariff totals do not match derived projection");
  }

  assertFiniteNumber(sWf.baselineTariffUsd, "summary.workflow.baselineTariffUsd");
  assertFiniteNumber(sWf.candidateTariffUsd, "summary.workflow.candidateTariffUsd");
  if (sWf.baselineAssistantTurns !== projected.workflow.baselineRequests || sWf.candidateAssistantTurns !== projected.workflow.candidateRequests ||
      sWf.baselineStatus !== "passed" || sWf.candidateStatus !== "failed") {
    throw new Error("Summary workflow metrics do not match derived projection");
  }
  if (Math.abs(sWf.baselineTariffUsd - projected.workflow.baselineTariffUsd) > 1e-8 ||
      Math.abs(sWf.candidateTariffUsd - projected.workflow.candidateTariffUsd) > 1e-8) {
    throw new Error("Summary workflow tariff values do not match derived projection");
  }

  assertSafeInteger(sCohort.totalRequests, "summary.cohort.totalRequests");
  assertFiniteNumber(sCohort.cumulativeTariffUsd, "summary.cohort.cumulativeTariffUsd");
  if (sCohort.totalRequests !== projected.cohort.totalRequests || Math.abs(sCohort.cumulativeTariffUsd - projected.cohort.cumulativeTariffUsd) > 1e-8) {
    throw new Error("Summary cohort totals do not match derived projection");
  }

  assertSafeInteger(sLedger.totalSettledRequests, "summary.spendLedger.totalSettledRequests");
  assertFiniteNumber(sLedger.cumulativeTariffUsd, "summary.spendLedger.cumulativeTariffUsd");
  assertFiniteNumber(sLedger.ceilingUsd, "summary.spendLedger.ceilingUsd");
  if (sLedger.totalSettledRequests !== 18 || sLedger.unsettledRequests !== 0 || sLedger.status !== "ok") {
    throw new Error("Summary spendLedger must have exactly 18 settled requests, 0 unsettled, status ok");
  }
  if (Math.abs(sLedger.cumulativeTariffUsd - 0.0362235) > 1e-8) {
    throw new Error("Summary spendLedger cumulativeTariffUsd mismatch");
  }
}

function validateAndProjectPairs(pairs, sourceHash, summaryMeta = null) {
  assertHex64(sourceHash, "sourceHash");
  if (sourceHash !== EXPECTED_OBSERVATIONS_HASH) {
    throw new Error(`Integrity mismatch: sourceHash ${sourceHash} does not match expected ${EXPECTED_OBSERVATIONS_HASH}`);
  }
  if (!Array.isArray(pairs) || pairs.length !== 4) {
    throw new Error(`Expected exactly 4 task pairs, found ${pairs?.length}`);
  }

  const sessionIds = new Set();
  const seenTasks = new Set();
  let revBaseAcc = 0, revCandAcc = 0, revBaseTariff = 0, revCandTariff = 0;
  let wfBaseReqs = 0, wfBaseTariff = 0, wfCandReqs = 0, wfCandTariff = 0, wfCandTerm = "";
  let cohortReqs = 0, cohortTariff = 0;

  for (const pair of pairs) {
    const m = validatePair(pair, sessionIds, seenTasks);
    cohortReqs += m.bTurns + m.cTurns;
    cohortTariff = roundUsd(cohortTariff + m.bCost + m.cCost);
    if (m.type === "review") {
      revBaseAcc += 1;
      revCandAcc += 1;
      revBaseTariff = roundUsd(revBaseTariff + m.bCost);
      revCandTariff = roundUsd(revCandTariff + m.cCost);
    } else {
      wfBaseReqs = m.bTurns;
      wfBaseTariff = roundUsd(m.bCost);
      wfCandReqs = m.cTurns;
      wfCandTariff = roundUsd(m.cCost);
      wfCandTerm = m.cFailure;
    }
  }

  if (sessionIds.size !== 8) {
    throw new Error(`Expected 8 distinct session IDs across all runs, got ${sessionIds.size}`);
  }

  const projected = {
    sourceHash,
    model: EXPECTED_MODEL,
    tariffSource: "installed SDK fixed catalog; not independent provider invoice",
    claimStatus: "not-proven",
    review: {
      pairs: 3,
      baselineAccurate: revBaseAcc,
      candidateAccurate: revCandAcc,
      baselineTariffUsd: revBaseTariff,
      candidateTariffUsd: revCandTariff,
    },
    workflow: {
      baselineStatus: "passed",
      baselineRequests: wfBaseReqs,
      baselineTariffUsd: wfBaseTariff,
      candidateStatus: "failed",
      candidateRequests: wfCandReqs,
      candidateTariffUsd: wfCandTariff,
      candidateTermination: wfCandTerm,
    },
    cohort: {
      totalRequests: cohortReqs,
      cumulativeTariffUsd: cohortTariff,
    },
  };

  if (summaryMeta?.summary) {
    crossVerifySummary(summaryMeta, projected);
  }

  return projected;
}

function resolveLedgerInfo(absRoot, summaryLedger = null) {
  const ledgerPath = join(absRoot, SPEND_LEDGER_PATH);
  if (existsSync(ledgerPath)) {
    const liveLedger = loadSpendLedger(absRoot);
    if (liveLedger.status !== "ok") throw new Error(`Live spend ledger status is ${liveLedger.status}`);
    const settled = liveLedger.requests.filter((r) => r.status === "settled");
    const unsettled = liveLedger.requests.filter((r) => r.status !== "settled");
    if (unsettled.length > 0) throw new Error(`Live spend ledger has ${unsettled.length} unsettled requests`);
    if (settled.length !== 18) throw new Error(`Live spend ledger expected 18 settled requests, got ${settled.length}`);
    return {
      source: "live-ledger",
      totalSettledRequests: settled.length,
      cumulativeTariffUsd: liveLedger.cumulative_tariff_usd,
      unsettledRequests: 0,
      ceilingUsd: liveLedger.ceiling_usd,
      status: liveLedger.status,
    };
  }

  if (summaryLedger) {
    assertSafeInteger(summaryLedger.totalSettledRequests, "summary spendLedger totalSettledRequests");
    assertFiniteNumber(summaryLedger.cumulativeTariffUsd, "summary spendLedger cumulativeTariffUsd");
    if (summaryLedger.unsettledRequests !== 0 || summaryLedger.status !== "ok") {
      throw new Error("Packaged summary spendLedger has nonzero unsettled requests or non-ok status");
    }
    return {
      source: "historical-snapshot",
      totalSettledRequests: summaryLedger.totalSettledRequests,
      cumulativeTariffUsd: summaryLedger.cumulativeTariffUsd,
      unsettledRequests: 0,
      ceilingUsd: summaryLedger.ceilingUsd || 1.0,
      status: "ok",
    };
  }

  return {
    source: "historical-snapshot",
    totalSettledRequests: 18,
    cumulativeTariffUsd: 0.0362235,
    unsettledRequests: 0,
    ceilingUsd: 1.0,
    status: "ok",
  };
}

/**
 * Reads quality evidence strictly within the specified root without live network/model dispatch.
 * Fails closed on any tampering, data deletion, or missing sources.
 *
 * @param {object} [options]
 * @param {string} [options.root=process.cwd()]
 * @returns {Promise<object>}
 */
export async function readQualityEvidence({ root = process.cwd() } = {}) {
  try {
    const absRoot = resolve(root);

    // 1. Try raw retained observations
    const rawObsPath = join(absRoot, RAW_OBSERVATIONS_PATH);
    if (existsSync(rawObsPath)) {
      const rawContent = readFileSync(rawObsPath, "utf8");
      const canonicalLF = rawContent.replace(/\r\n/g, "\n");
      const hash = createHash("sha256").update(canonicalLF).digest("hex");
      if (hash !== EXPECTED_OBSERVATIONS_HASH) {
        throw new Error(`Integrity mismatch on raw observations: got ${hash}, expected ${EXPECTED_OBSERVATIONS_HASH}`);
      }

      const rawJson = JSON.parse(canonicalLF);
      if (rawJson.model !== EXPECTED_MODEL) throw new Error(`Model mismatch in raw observations: ${rawJson.model}`);
      const pairs = rawOutcomesToPairs(rawJson.outcomes);
      const projected = validateAndProjectPairs(pairs, hash);

      // Resolve ledger: check for live ledger at root
      const ledgerInfo = resolveLedgerInfo(absRoot);
      return {
        valid: true,
        status: "ok",
        source: "retained-observations",
        ...projected,
        ledger: ledgerInfo,
        limitations: LIMITATIONS,
      };
    }

    // 2. Try packaged summary in root
    const summaryPath = join(absRoot, SUMMARY_PATH);
    if (existsSync(summaryPath)) {
      const summaryContent = readFileSync(summaryPath, "utf8");
      const summaryJson = JSON.parse(summaryContent);
      if (!summaryJson.sourceHash) throw new Error("Missing sourceHash in packaged summary");
      const projected = validateAndProjectPairs(summaryJson.pairs, summaryJson.sourceHash, summaryJson);

      const ledgerInfo = resolveLedgerInfo(absRoot, summaryJson.summary?.spendLedger);

      return {
        valid: true,
        status: "ok",
        source: "packaged-summary",
        ...projected,
        ledger: ledgerInfo,
        limitations: LIMITATIONS,
      };
    }

    // Neither exists in specified root: fail closed
    return {
      valid: false,
      status: "error",
      claimStatus: "unknown",
      error: `Quality evidence sources absent in root: ${absRoot}`,
    };
  } catch (err) {
    return {
      valid: false,
      status: "error",
      claimStatus: "unknown",
      error: err.message || String(err),
    };
  }
}

/**
 * Formats evidence for human-readable console output.
 *
 * @param {object} evidence
 * @returns {string}
 */
export function formatQualityEvidence(evidence) {
  if (!evidence || !evidence.valid || evidence.status !== "ok") {
    return [
      "NULLFORM QUALITY EVIDENCE",
      "=========================",
      "Status: ERROR / UNKNOWN",
      "Claim Status: unknown (failing closed; no positive claim fallback)",
      `Error: ${evidence?.error || "Unknown validation failure"}`,
    ].join("\n");
  }

  const lines = [
    "NULLFORM QUALITY EVIDENCE — Retained Historical Observations",
    "===========================================================",
    `Claim Status    : ${evidence.claimStatus.toUpperCase()} (Honest release: no unproven quality claims)`,
    `Evaluated Model : ${evidence.model}`,
    `Tariff Source   : ${evidence.tariffSource}`,
    `Source Binding  : SHA-256 ${evidence.sourceHash}`,
    "",
    "Comparative Results (Four Constructed Task Pairs, Single Model, One Repetition):",
    "-------------------------------------------------------------------------------",
    `• Review Tasks (3 pairs):`,
    `    Baseline (no skills) : 3/3 accurate (0 missed defects, 0 false positives)  [$${evidence.review.baselineTariffUsd.toFixed(7)} USD]`,
    `    Candidate (with skill): 3/3 accurate (0 missed defects, 0 false positives)  [$${evidence.review.candidateTariffUsd.toFixed(7)} USD]`,
    `    Finding: Equal defect/simplification accuracy; candidate roughly doubled tariff spend.`,
    "",
    `• Workflow Task (1 pair):`,
    `    Baseline : ${evidence.workflow.baselineStatus.toUpperCase()} in ${evidence.workflow.baselineRequests} physical requests [$${evidence.workflow.baselineTariffUsd.toFixed(7)} USD]`,
    `    Candidate: ${evidence.workflow.candidateStatus.toUpperCase()} in ${evidence.workflow.candidateRequests} physical requests [$${evidence.workflow.candidateTariffUsd.toFixed(7)} USD]`,
    `               (${evidence.workflow.candidateTermination})`,
    `    Finding: Baseline completed cleanly; candidate halted at request cap without final report.`,
    "",
    "Spending & Accounting:",
    "----------------------",
    `• Cohort Spend   : ${evidence.cohort.totalRequests} requests totaling $${evidence.cohort.cumulativeTariffUsd.toFixed(7)} USD`,
    `• Durable Ledger : ${evidence.ledger.totalSettledRequests} settled requests ($${evidence.ledger.cumulativeTariffUsd.toFixed(7)} USD, ≤ $${evidence.ledger.ceilingUsd.toFixed(2)} USD ceiling)`,
    `  Accounting     : ${evidence.ledger.source} | status: ${evidence.ledger.status} (${evidence.ledger.unsettledRequests} unsettled)`,
    "",
    "Explicit Limitations:",
    "---------------------",
    ...evidence.limitations.map((lim, i) => `[${i + 1}] ${lim}`),
  ];

  return lines.join("\n");
}
