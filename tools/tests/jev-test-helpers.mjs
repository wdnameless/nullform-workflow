import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { policyFingerprint, loadEvaluationDatasetContext } from "../jev-evidence.mjs";

export function createTempDir(prefix = "jev-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeSyntheticDatasetContext(report) {
  const calib = report.skills.cases.filter((c) => c.isCalibration);
  const heldout = report.skills.cases.filter((c) => !c.isCalibration);
  return {
    hashes: {
      calibration: report.datasetHashes.calibration,
      heldout: report.datasetHashes.heldout,
    },
    calibration: calib.map((c) => ({
      id: c.id,
      expectedSkills: c.expectedSkills,
      isSafetyCanary: Boolean(c.isSafety || c.isSafetyCanary),
    })),
    heldout: heldout.map((c) => ({
      id: c.id,
      expectedSkills: c.expectedSkills,
      isSafetyCanary: Boolean(c.isSafety || c.isSafetyCanary),
    })),
  };
}

export function makeValidReportFixture() {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    isSafetyCanary: false,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    confidence: 0.95,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = Array.from({ length: 40 }, (_, i) => ({
    id: `heldout-skill-${i}`,
    isSafetyCanary: false,
    expectedSkills: ["lookup"],
    candidateSkill: "lookup",
    baselineRequested: true,
    candidateRequested: true,
    candidateAttempted: true,
    baselineAttempted: true,
    baselineSkill: "lookup",
    confidence: 0.95,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const skillCases = [...calibCases, ...heldoutCases];

  const fp = policyFingerprint({
    catalogFingerprint: "cat",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
  });

  return {
    version: 2,
    completed: true,
    errors: 0,
    requests: 104,
    spendUsd: 0.0624,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: fp,
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 40, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64) },
    skills: {
      total: 52,
      eligible: 40,
      safetyTotal: 0,
      safetyMisses: 0,
      baseline: { attempted: 40, correct: 40, costUsd: 0.04 },
      candidate: { attempted: 40, correct: 40, criticalMisses: 0, costUsd: 0.008 },
      cases: skillCases,
    },
  };
}

function buildCanonicalSkillCases(ctx) {
  let requests = 0, spendUsd = 0;
  const skillCases = [];
  let sEligible = 0, sSafetyTotal = 0;
  let sBaseAttempted = 0, sBaseCorrect = 0;
  let sCandAttempted = 0, sCandCorrect = 0;
  let sBaseCost = 0, sCandCost = 0;

  for (const c of [...ctx.calibration, ...ctx.heldout]) {
    const isCalib = c.id.startsWith("calib");
    const isSafety = Boolean(c.isSafetyCanary);
    const expectedSkills = c.expectedSkills || [];
    const expectedSkill = expectedSkills.length > 0 ? expectedSkills[0] : null;
    const bReq = !isSafety, cReq = !isSafety;
    const bCost = bReq ? 0.001 : 0, cCost = cReq ? 0.0002 : 0;

    if (bReq) requests++;
    if (cReq) requests++;
    spendUsd += bCost + cCost;

    if (!isCalib) {
      if (isSafety) sSafetyTotal++;
      else {
        sEligible++;
        sBaseAttempted++;
        sBaseCorrect++;
        sCandAttempted++;
        sCandCorrect++;
      }
      sBaseCost += bCost;
      sCandCost += cCost;
    }

    skillCases.push({
      id: c.id,
      isCalibration: isCalib,
      isSafety,
      isSafetyCanary: isSafety,
      expectedSkills,
      baselineSkill: expectedSkill || "none",
      candidateSkill: expectedSkill || "none",
      baselineRequested: bReq,
      candidateRequested: cReq,
      baselineAttempted: !isSafety,
      candidateAttempted: !isSafety,
      confidence: !isSafety ? 0.95 : 0,
      baselineCostUsd: bCost,
      candidateCostUsd: cCost,
    });
  }
  return {
    requests, spendUsd, skillCases,
    sEligible, sSafetyTotal, sBaseAttempted, sBaseCorrect,
    sCandAttempted, sCandCorrect, sBaseCost, sCandCost,
  };
}

export function makeCanonicalValidReportFixture(ctx = loadEvaluationDatasetContext()) {
  const sData = buildCanonicalSkillCases(ctx);

  const catalogFingerprint = "cat";
  const baselineModel = "base";
  const decisionModel = "typesafe/jev-1.13";
  const fp = policyFingerprint({ catalogFingerprint, baselineModel, decisionModel });

  return {
    version: 2,
    completed: true,
    errors: 0,
    requests: sData.requests,
    spendUsd: Number(sData.spendUsd.toFixed(6)),
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint,
    baselineModel,
    decisionModel,
    fingerprint: fp,
    calibration: { total: ctx.calibration.length, hash: ctx.hashes.calibration },
    heldout: { total: ctx.heldout.length, hash: ctx.hashes.heldout },
    datasetHashes: ctx.hashes,
    skills: {
      total: sData.skillCases.length,
      eligible: sData.sEligible,
      safetyTotal: sData.sSafetyTotal,
      safetyMisses: 0,
      baseline: { attempted: sData.sBaseAttempted, correct: sData.sBaseCorrect, costUsd: Number(sData.sBaseCost.toFixed(6)) },
      candidate: { attempted: sData.sCandAttempted, correct: sData.sCandCorrect, criticalMisses: 0, costUsd: Number(sData.sCandCost.toFixed(6)) },
      cases: sData.skillCases,
    },
  };
}
