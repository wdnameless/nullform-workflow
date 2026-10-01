import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const DECISION_MODEL = "typesafe/jev-1.13";
const HEX64 = /^[0-9a-f]{64}$/;

export function policyFingerprint({
  catalogFingerprint = "",
  baselineModel = "",
  decisionModel = DECISION_MODEL,
} = {}) {
  const norm = [
    String(catalogFingerprint || ""),
    String(baselineModel || ""),
    String(decisionModel || DECISION_MODEL),
  ].join(":");
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

export function loadEvaluationDatasetContext({ root } = {}) {
  const candidates = [
    root ? join(root, "tools", "tests", "fixtures", "jev") : null,
    root ? join(root, "tests", "fixtures", "jev") : null,
    root ? join(root, "fixtures", "jev") : null,
    fileURLToPath(new URL("./tests/fixtures/jev", import.meta.url)),
    join(process.cwd(), "tools", "tests", "fixtures", "jev"),
  ].filter(Boolean);

  let targetDir = null;
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "calibration.json")) &&
      existsSync(join(dir, "heldout.json"))
    ) {
      targetDir = dir;
      break;
    }
  }
  if (!targetDir) return null;

  try {
    const rawCalib = readFileSync(join(targetDir, "calibration.json"), "utf8");
    const rawHeldout = readFileSync(join(targetDir, "heldout.json"), "utf8");

    const calib = JSON.parse(rawCalib);
    const heldout = JSON.parse(rawHeldout);
    if (!Array.isArray(calib) || !Array.isArray(heldout)) return null;

    return {
      hashes: {
        calibration: createHash("sha256").update(rawCalib, "utf8").digest("hex"),
        heldout: createHash("sha256").update(rawHeldout, "utf8").digest("hex"),
      },
      calibration: calib,
      heldout,
    };
  } catch {
    return null;
  }
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
    isSafety: Boolean(c.isSafety || c.isSafetyCanary || c.kind === "safety"),
    isScreened: Boolean(c.screened),
  };
}

function validateEnvelope(report, datasetContext) {
  if (!report || typeof report !== "object") return null;
  if (report.version !== 2 || report.completed !== true) return null;
  if (report.dryRun === true || report.simulated === true) return null;
  if (!Number.isInteger(report.errors) || report.errors !== 0) return null;
  if (!Number.isInteger(report.requests) || report.requests <= 0) return null;
  if (typeof report.spendUsd !== "number" || !Number.isFinite(report.spendUsd) || report.spendUsd < 0) return null;
  if (typeof report.maxCostUsd !== "number" || !Number.isFinite(report.maxCostUsd) || report.maxCostUsd <= 0) return null;
  if (report.spendUsd > report.maxCostUsd) return null;

  const unknownSpendUsd = report.unknownSpendUsd ?? 0;
  if (typeof unknownSpendUsd !== "number" || !Number.isFinite(unknownSpendUsd) || unknownSpendUsd !== 0) return null;

  if (!Array.isArray(report.decisionSnapshots) || report.decisionSnapshots.length === 0) return null;
  for (const snap of report.decisionSnapshots) {
    if (typeof snap !== "string" || !snap.trim()) return null;
  }

  if (
    typeof report.catalogFingerprint !== "string" ||
    typeof report.baselineModel !== "string" ||
    typeof report.decisionModel !== "string" ||
    typeof report.fingerprint !== "string"
  ) {
    return null;
  }
  const expectedFp = policyFingerprint({
    catalogFingerprint: report.catalogFingerprint,
    baselineModel: report.baselineModel,
    decisionModel: report.decisionModel,
  });
  if (report.fingerprint !== expectedFp) return null;

  if (!datasetContext || typeof datasetContext !== "object" || !datasetContext.hashes) return null;
  const ctxHashes = datasetContext.hashes;
  const ds = report.datasetHashes;
  if (
    !ds || typeof ds !== "object" ||
    !HEX64.test(ds.calibration) ||
    !HEX64.test(ds.heldout) ||
    ds.calibration !== ctxHashes.calibration ||
    ds.heldout !== ctxHashes.heldout
  ) {
    return null;
  }

  return { unknownSpendUsd: 0 };
}

function checkSkillsGold(cases, goldList) {
  if (!Array.isArray(goldList)) return false;
  if (cases.length !== goldList.length) return false;

  const goldMap = new Map();
  for (const g of goldList) {
    if (!g?.id) return false;
    goldMap.set(g.id, g);
  }

  for (const c of cases) {
    const g = goldMap.get(c.id);
    if (!g) return false;

    const isGoldSafety = Boolean(g.isSafetyCanary ?? g.isSafety ?? (g.kind === "safety"));
    const isCaseSafety = Boolean(c.isSafetyCanary ?? c.isSafety ?? (c.kind === "safety"));
    if (isCaseSafety !== isGoldSafety) return false;

    const gSkills = [...(Array.isArray(g.expectedSkills) ? g.expectedSkills : (g.expectedSkill && g.expectedSkill !== "none" ? [g.expectedSkill] : []))].sort();
    const cSkills = [...(Array.isArray(c.expectedSkills) ? c.expectedSkills : (c.expectedSkill && c.expectedSkill !== "none" ? [c.expectedSkill] : []))].sort();
    if (!isDeepStrictEqual(cSkills, gSkills)) return false;
  }
  return true;
}

function partitionSkillsCases(report, skills, datasetContext) {
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
    report.calibration.total !== calibCases.length ||
    report.calibration.hash !== datasetContext.hashes.calibration
  ) {
    return null;
  }
  if (
    !report.heldout || typeof report.heldout !== "object" ||
    !Number.isInteger(report.heldout.total) || report.heldout.total < 40 ||
    report.heldout.total !== heldoutCases.length ||
    report.heldout.hash !== datasetContext.hashes.heldout
  ) {
    return null;
  }

  if (!checkSkillsGold(calibCases, datasetContext.calibration)) return null;
  if (!checkSkillsGold(heldoutCases, datasetContext.heldout)) return null;

  return { calibCases, heldoutCases };
}

function evaluateSkillsCases(skills, report, datasetContext) {
  const partitioned = partitionSkillsCases(report, skills, datasetContext);
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
    const conf = typeof c.confidence === "number" ? c.confidence : (typeof c.candidateConfidence === "number" ? c.candidateConfidence : c.skillConfidence);
    const cAttempted = typeof conf === "number"
      ? (typeof c.candidateAttempted === "boolean" ? (c.candidateAttempted && conf >= 0.80) : (conf >= 0.80))
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

export function evaluateReport(report, { datasetContext } = {}) {
  const fail = { skillPassed: false };
  if (!datasetContext || typeof datasetContext !== "object") return fail;

  const env = validateEnvelope(report, datasetContext);
  if (!env) return fail;

  const skillsRes = evaluateSkillsCases(report.skills, report, datasetContext);
  if (!skillsRes) return fail;

  if (report.requests !== skillsRes.computedRequests) return fail;

  const expectedGlobalSpend = Number((skillsRes.globalKnownCost + env.unknownSpendUsd).toFixed(6));
  if (Math.abs(Number(report.spendUsd.toFixed(6)) - expectedGlobalSpend) > 1e-6) return fail;

  return {
    skillPassed: skillsRes.skillPassed,
  };
}
