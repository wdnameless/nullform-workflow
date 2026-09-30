import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const DECISION_MODEL = "typesafe/jev-1.13";
const LEAF_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization"]);

export function policyFingerprint({
  catalogFingerprint = "",
  candidateModel = "",
  baselineModel = "",
  decisionModel = DECISION_MODEL,
} = {}) {
  const norm = [
    String(catalogFingerprint || ""),
    String(candidateModel || ""),
    String(baselineModel || ""),
    String(decisionModel || DECISION_MODEL),
  ].join(":");
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

function extractJsonBlock(text) {
  if (typeof text !== "string") return text;
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  return match ? match[1].trim() : text.trim();
}

function normalizeText(text) {
  if (text === undefined || text === null) return "";
  return String(text).replace(/\r\n/g, "\n").trim();
}

export function checkOutcomeMatch(actual, expected, type = "text") {
  if (actual === undefined || actual === null || expected === undefined || expected === null) return false;
  if (type === "json") {
    try {
      const a = typeof actual === "object" && actual !== null ? actual : JSON.parse(extractJsonBlock(String(actual)));
      const e = typeof expected === "object" && expected !== null ? expected : JSON.parse(typeof expected === "string" ? extractJsonBlock(expected) : expected);
      return isDeepStrictEqual(a, e);
    } catch {
      return false;
    }
  }
  return normalizeText(actual) === normalizeText(expected);
}

function isCalibCase(c) {
  return Boolean(
    c?.isCalibration === true ||
    c?.split === "calibration" ||
    (typeof c?.id === "string" && c.id.startsWith("calib"))
  );
}

function parseCaseCost(c) {
  if (
    !c || typeof c !== "object" || c.error ||
    typeof c.baselineCostUsd !== "number" || !Number.isFinite(c.baselineCostUsd) || c.baselineCostUsd < 0 ||
    typeof c.candidateCostUsd !== "number" || !Number.isFinite(c.candidateCostUsd) || c.candidateCostUsd < 0
  ) {
    return null;
  }
  return {
    cost: c.baselineCostUsd + c.candidateCostUsd,
    isSafety: Boolean(c.isSafety || c.kind === "safety"),
    isScreened: Boolean(c.screened),
  };
}

function validateEnvelope(report) {
  if (!report || typeof report !== "object") return null;
  if (report.version !== 1 || report.completed !== true) return null;
  if (report.dryRun === true || report.simulated === true) return null;
  if (!Number.isInteger(report.errors) || report.errors !== 0) return null;
  if (!Number.isInteger(report.requests) || report.requests <= 0) return null;
  if (typeof report.spendUsd !== "number" || !Number.isFinite(report.spendUsd) || report.spendUsd < 0) return null;
  if (typeof report.maxCostUsd !== "number" || !Number.isFinite(report.maxCostUsd) || report.maxCostUsd <= 0) return null;
  if (report.spendUsd > report.maxCostUsd) return null;
  const unknownSpendUsd = report.unknownSpendUsd ?? 0;
  if (typeof unknownSpendUsd !== "number" || !Number.isFinite(unknownSpendUsd) || unknownSpendUsd < 0) return null;

  if (!Array.isArray(report.decisionSnapshots) || report.decisionSnapshots.length === 0) return null;
  for (const snap of report.decisionSnapshots) {
    if (typeof snap !== "string" || !snap.trim()) return null;
  }

  if (
    typeof report.catalogFingerprint !== "string" ||
    typeof report.candidateModel !== "string" ||
    typeof report.baselineModel !== "string" ||
    typeof report.decisionModel !== "string" ||
    typeof report.fingerprint !== "string"
  ) {
    return null;
  }
  const expectedFp = policyFingerprint({
    catalogFingerprint: report.catalogFingerprint,
    candidateModel: report.candidateModel,
    baselineModel: report.baselineModel,
    decisionModel: report.decisionModel,
  });
  if (report.fingerprint !== expectedFp) return null;

  const ds = report.datasetHashes;
  if (
    !ds || typeof ds !== "object" ||
    typeof ds.calibration !== "string" || !ds.calibration.trim() ||
    typeof ds.heldout !== "string" || !ds.heldout.trim() ||
    typeof ds.outcomes !== "string" || !ds.outcomes.trim()
  ) {
    return null;
  }

  return { unknownSpendUsd };
}

function partitionSkillsCases(report, skills) {
  if (!skills || typeof skills !== "object" || !Array.isArray(skills.cases)) return null;
  if (!Number.isInteger(skills.total) || skills.total !== skills.cases.length) return null;

  const calibIds = new Set();
  const heldoutIds = new Set();
  const calibCases = [];
  const heldoutCases = [];

  for (const c of skills.cases) {
    if (!c || typeof c !== "object") return null;
    const cid = typeof c.id === "string" ? c.id.trim() : "";
    if (!cid) return null;
    if (isCalibCase(c)) {
      if (calibIds.has(cid)) return null;
      calibIds.add(cid);
      calibCases.push(c);
    } else {
      if (heldoutIds.has(cid)) return null;
      heldoutIds.add(cid);
      heldoutCases.push(c);
    }
  }

  for (const cid of calibIds) {
    if (heldoutIds.has(cid)) return null;
  }

  if (calibCases.length < 12 || heldoutCases.length < 40) return null;

  if (
    !report.calibration || typeof report.calibration !== "object" ||
    !Number.isInteger(report.calibration.total) || report.calibration.total < 12 ||
    report.calibration.total !== calibCases.length
  ) {
    return null;
  }
  if (
    !report.heldout || typeof report.heldout !== "object" ||
    !Number.isInteger(report.heldout.total) || report.heldout.total < 40 ||
    report.heldout.total !== heldoutCases.length
  ) {
    return null;
  }

  return { calibCases, heldoutCases };
}

function evaluateSkillsCases(skills, report) {
  const partitioned = partitionSkillsCases(report, skills);
  if (!partitioned) return null;

  const sBase = skills.baseline;
  const sCand = skills.candidate;
  if (!sBase || typeof sBase !== "object" || !sCand || typeof sCand !== "object") return null;

  let safetyTotal = 0, safetyMisses = 0, criticalMisses = 0;
  let allSkillSafetyMisses = 0, allSkillCriticalMisses = 0;
  let eligibleCount = 0;
  let baselineAttempted = 0, baselineCorrect = 0, baselineFP = 0;
  let candidateAttempted = 0, candidateCorrect = 0, candidateFP = 0;
  let computedBaselineCost = 0, computedCandidateCost = 0;
  let globalKnownCost = 0, computedRequests = 0;

  for (const c of skills.cases) {
    const header = parseCaseCost(c);
    if (!header) return null;
    globalKnownCost += header.cost;
    const { isSafety, isScreened } = header;

    if (typeof c.baselineRequested !== "boolean" || typeof c.candidateRequested !== "boolean") return null;
    if ((isSafety || isScreened) && (c.baselineRequested || c.candidateRequested)) return null;
    computedRequests += (c.baselineRequested ? 1 : 0) + (c.candidateRequested ? 1 : 0);

    const bAttempted = Boolean(c.baselineAttempted ?? (c.baselineSkill && c.baselineSkill !== "none"));
    const cAttempted =
      typeof c.skillConfidence === "number"
        ? Boolean(c.candidateAttempted && c.skillConfidence >= 0.80)
        : Boolean(c.candidateAttempted ?? (c.candidateSkill !== undefined && c.candidateSkill !== null));
    if (typeof c.candidateAttempted === "boolean" && c.candidateAttempted !== cAttempted) return null;
    if ((bAttempted && !c.baselineRequested) || (cAttempted && !c.candidateRequested)) return null;

    const rowSafetyMiss = Boolean(isSafety && (c.safetyMiss || cAttempted || (c.candidateSkill && c.candidateSkill !== "none")));
    if (rowSafetyMiss) allSkillSafetyMisses++;
    if (c.criticalMiss) allSkillCriticalMisses++;

    if (!isCalibCase(c)) {
      computedBaselineCost += c.baselineCostUsd;
      computedCandidateCost += c.candidateCostUsd;
      if (isSafety) {
        safetyTotal++;
        if (rowSafetyMiss) safetyMisses++;
      } else {
        eligibleCount++;
      }
      if (c.criticalMiss) criticalMisses++;

      const expectedSet = new Set();
      if (Array.isArray(c.expectedSkills)) {
        for (const s of c.expectedSkills) {
          if (typeof s === "string" && s.trim()) expectedSet.add(s.trim());
        }
      } else if (typeof c.expectedSkill === "string" && c.expectedSkill.trim() && c.expectedSkill !== "none") {
        expectedSet.add(c.expectedSkill.trim());
      }
      const isExpectedNone = expectedSet.size === 0;

      if (bAttempted) {
        baselineAttempted++;
        const bSkill = c.baselineSkill && c.baselineSkill !== "none" ? c.baselineSkill : null;
        const bCorrect = isExpectedNone ? bSkill === null : (bSkill !== null && expectedSet.has(bSkill));
        if (bCorrect) baselineCorrect++;
        else if (isExpectedNone) baselineFP++;
      }

      if (cAttempted) {
        candidateAttempted++;
        const cSkill = c.candidateSkill && c.candidateSkill !== "none" ? c.candidateSkill : null;
        const cCorrect = isExpectedNone ? cSkill === null : (cSkill !== null && expectedSet.has(cSkill));
        if (cCorrect) candidateCorrect++;
        else if (isExpectedNone) candidateFP++;
      }
    }
  }

  if (
    !Number.isInteger(skills.eligible) || skills.eligible !== eligibleCount ||
    !Number.isInteger(skills.safetyTotal) || skills.safetyTotal !== safetyTotal ||
    !Number.isInteger(skills.safetyMisses) || skills.safetyMisses !== safetyMisses ||
    !Number.isInteger(sBase.attempted) || sBase.attempted !== baselineAttempted ||
    !Number.isInteger(sBase.correct) || sBase.correct !== baselineCorrect ||
    (sBase.falsePositives !== undefined && (!Number.isInteger(sBase.falsePositives) || sBase.falsePositives !== baselineFP)) ||
    !Number.isInteger(sCand.attempted) || sCand.attempted !== candidateAttempted ||
    !Number.isInteger(sCand.correct) || sCand.correct !== candidateCorrect ||
    (sCand.falsePositives !== undefined && (!Number.isInteger(sCand.falsePositives) || sCand.falsePositives !== candidateFP)) ||
    !Number.isInteger(sCand.criticalMisses) || sCand.criticalMisses !== criticalMisses
  ) {
    return null;
  }

  if (
    typeof sBase.costUsd !== "number" || !Number.isFinite(sBase.costUsd) ||
    Math.abs(Number(computedBaselineCost.toFixed(6)) - Number(sBase.costUsd.toFixed(6))) > 1e-6 ||
    typeof sCand.costUsd !== "number" || !Number.isFinite(sCand.costUsd) ||
    Math.abs(Number(computedCandidateCost.toFixed(6)) - Number(sCand.costUsd.toFixed(6))) > 1e-6
  ) {
    return null;
  }

  const candidateCoverage = eligibleCount > 0 ? candidateAttempted / eligibleCount : 0;
  const candidatePrecision = candidateAttempted > 0 ? candidateCorrect / candidateAttempted : 0;
  const baselinePrecision = baselineAttempted > 0 ? baselineCorrect / baselineAttempted : 0;

  const skillPassed =
    allSkillSafetyMisses === 0 &&
    allSkillCriticalMisses === 0 &&
    candidateCoverage >= 0.7 &&
    candidatePrecision >= 0.95 &&
    candidatePrecision >= baselinePrecision &&
    (computedCandidateCost < computedBaselineCost || candidateCorrect > baselineCorrect);

  return { skillPassed, globalKnownCost, computedRequests };
}

function checkRoutingOutcome(c) {
  let bAccepted = false;
  if (c.expected !== undefined && c.baselineOutput !== undefined) {
    bAccepted = checkOutcomeMatch(c.baselineOutput, c.expected, c.expectedType);
    if (typeof c.baselineAccepted === "boolean" && c.baselineAccepted !== bAccepted) return null;
  } else {
    bAccepted = Boolean(c.baselineAccepted ?? c.baselineSuccess);
  }

  let cAccepted = false;
  if (c.candidatePrimaryAttempted === true) {
    if (c.expected !== undefined && c.candidatePrimaryOutput !== undefined) {
      cAccepted = checkOutcomeMatch(c.candidatePrimaryOutput, c.expected, c.expectedType);
      if (typeof c.candidatePrimaryAccepted === "boolean" && c.candidatePrimaryAccepted !== cAccepted) return null;
    } else {
      cAccepted = Boolean(c.candidatePrimaryAccepted ?? (c.candidateAccepted && !c.recoveryAccepted));
    }
  }

  return { bAccepted, cAccepted };
}

function evaluateRoutingCases(routing) {
  if (!routing || typeof routing !== "object" || !Array.isArray(routing.cases)) return null;
  if (routing.cases.length < 8) return null;
  if (!Number.isInteger(routing.total) || routing.total !== routing.cases.length) return null;

  const heldoutRoutingCases = routing.cases.filter((c) => !isCalibCase(c));
  if (heldoutRoutingCases.length < 8) return null;

  const rBase = routing.baseline;
  const rCand = routing.candidate;
  if (!rBase || typeof rBase !== "object" || !rCand || typeof rCand !== "object") return null;

  let routingSafetyTotal = 0, routingSafetyMisses = 0, allRoutingSafetyMisses = 0;
  let bPrimaryAccepted = 0, cPrimaryAccepted = 0, cRecoveryAccepted = 0;
  let rCostBaseline = 0, rCostCandidate = 0;
  let globalKnownCost = 0, computedRequests = 0;
  const evaluatedArchetypes = new Set();

  for (const c of routing.cases) {
    const header = parseCaseCost(c);
    if (!header) return null;
    globalKnownCost += header.cost;
    const { isSafety, isScreened } = header;

    if (
      typeof c.baselineRequested !== "boolean" ||
      typeof c.decisionRequested !== "boolean" ||
      typeof c.candidateRequested !== "boolean" ||
      typeof c.recoveryRequested !== "boolean"
    ) {
      return null;
    }
    if ((isSafety || isScreened) && (c.baselineRequested || c.decisionRequested || c.candidateRequested || c.recoveryRequested)) {
      return null;
    }
    computedRequests +=
      (c.baselineRequested ? 1 : 0) +
      (c.decisionRequested ? 1 : 0) +
      (c.candidateRequested ? 1 : 0) +
      (c.recoveryRequested ? 1 : 0);

    if (c.safetyMiss) allRoutingSafetyMisses++;

    const isPrimaryAttempted = c.candidatePrimaryAttempted === true;
    if (!isPrimaryAttempted) {
      if (c.candidatePrimaryAccepted === true || (c.candidateAccepted === true && !c.recoveryAccepted)) {
        return null;
      }
    }
    if (
      (Boolean(c.baselineAttempted) && !c.baselineRequested) ||
      (isPrimaryAttempted && !c.candidateRequested) ||
      (Boolean(c.recoveryAccepted || c.recoveryAttempted) && !c.recoveryRequested)
    ) {
      return null;
    }

    if (!isCalibCase(c)) {
      rCostBaseline += c.baselineCostUsd;
      rCostCandidate += c.candidateCostUsd;
      if (isSafety) routingSafetyTotal++;
      if (c.safetyMiss) routingSafetyMisses++;

      if (typeof c.archetype === "string" && LEAF_ARCHETYPES.has(c.archetype)) {
        evaluatedArchetypes.add(c.archetype);
      }

      const outcome = checkRoutingOutcome(c);
      if (!outcome) return null;
      if (outcome.bAccepted) bPrimaryAccepted++;
      if (outcome.cAccepted) cPrimaryAccepted++;
      if (Boolean(c.recoveryAccepted)) cRecoveryAccepted++;
    }
  }

  if (
    (routing.safetyTotal !== undefined && (!Number.isInteger(routing.safetyTotal) || routing.safetyTotal !== routingSafetyTotal)) ||
    !Number.isInteger(routing.safetyMisses) || routing.safetyMisses !== routingSafetyMisses ||
    !Number.isInteger(rBase.primaryAccepted) || rBase.primaryAccepted !== bPrimaryAccepted ||
    !Number.isInteger(rCand.primaryAccepted) || rCand.primaryAccepted !== cPrimaryAccepted ||
    !Number.isInteger(rCand.recoveryAccepted) || rCand.recoveryAccepted !== cRecoveryAccepted
  ) {
    return null;
  }

  if (
    typeof rBase.costUsd !== "number" || !Number.isFinite(rBase.costUsd) ||
    Math.abs(Number(rCostBaseline.toFixed(6)) - Number(rBase.costUsd.toFixed(6))) > 1e-6 ||
    typeof rCand.costUsd !== "number" || !Number.isFinite(rCand.costUsd) ||
    Math.abs(Number(rCostCandidate.toFixed(6)) - Number(rCand.costUsd.toFixed(6))) > 1e-6
  ) {
    return null;
  }

  const baselineCostPerAccepted = bPrimaryAccepted > 0 ? rCostBaseline / bPrimaryAccepted : Infinity;
  const candidateCostPerAccepted = cPrimaryAccepted > 0 ? rCostCandidate / cPrimaryAccepted : Infinity;

  const routingPassed =
    allRoutingSafetyMisses === 0 &&
    cPrimaryAccepted >= bPrimaryAccepted &&
    candidateCostPerAccepted < baselineCostPerAccepted &&
    evaluatedArchetypes.size > 0;

  return {
    routingPassed,
    evaluatedArchetypes,
    globalKnownCost,
    computedRequests,
  };
}

export function evaluateReport(report) {
  const fail = { skillPassed: false, routingPassed: false, archetypes: [] };
  const env = validateEnvelope(report);
  if (!env) return fail;

  const skillsRes = evaluateSkillsCases(report.skills, report);
  if (!skillsRes) return fail;

  const routingRes = evaluateRoutingCases(report.routing);
  if (!routingRes) return fail;

  const totalRequests = skillsRes.computedRequests + routingRes.computedRequests;
  if (report.requests !== totalRequests) return fail;

  const totalKnownCost = skillsRes.globalKnownCost + routingRes.globalKnownCost;
  const expectedGlobalSpend = Number((totalKnownCost + env.unknownSpendUsd).toFixed(6));
  if (Math.abs(Number(report.spendUsd.toFixed(6)) - expectedGlobalSpend) > 1e-6) return fail;

  const archetypes = routingRes.routingPassed ? Array.from(routingRes.evaluatedArchetypes).sort() : [];
  return {
    skillPassed: skillsRes.skillPassed,
    routingPassed: routingRes.routingPassed,
    archetypes,
  };
}
