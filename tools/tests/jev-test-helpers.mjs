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
  const outcomes = report.routing.cases;
  return {
    hashes: {
      calibration: report.datasetHashes.calibration,
      heldout: report.datasetHashes.heldout,
      outcomes: report.datasetHashes.outcomes,
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
    outcomes: outcomes.map((c) => ({
      id: c.id,
      archetype: c.archetype,
      expectedType: c.expectedType,
      expected: c.expected,
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
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const skillCases = [...calibCases, ...heldoutCases];

  const routingCases = Array.from({ length: 8 }, (_, i) => ({
    id: `heldout-route-${i}`,
    archetype: "lookup",
    isSafetyCanary: false,
    expected: "full complete text output",
    expectedType: "text",
    baselineOutput: "full complete text output",
    candidatePrimaryOutput: "full complete text output",
    baselineRequested: true,
    decisionRequested: true,
    candidateRequested: true,
    recoveryRequested: false,
    baselineAttempted: true,
    baselineAccepted: true,
    candidatePrimaryAttempted: true,
    candidatePrimaryAccepted: true,
    recoveryAccepted: false,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  return {
    version: 1,
    completed: true,
    errors: 0,
    requests: 128,
    spendUsd: 0.072,
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint: "cat",
    candidateModel: "cand",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
    fingerprint: policyFingerprint({
      catalogFingerprint: "cat",
      candidateModel: "cand",
      baselineModel: "base",
      decisionModel: "typesafe/jev-1.13",
    }),
    calibration: { total: 12, hash: "a".repeat(64) },
    heldout: { total: 40, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skills: {
      total: 52,
      eligible: 40,
      safetyTotal: 0,
      safetyMisses: 0,
      baseline: { attempted: 40, correct: 40, costUsd: 0.04 },
      candidate: { attempted: 40, correct: 40, criticalMisses: 0, costUsd: 0.008 },
      cases: skillCases,
    },
    routing: {
      total: 8,
      safetyMisses: 0,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 8, costUsd: 0.008 },
      candidate: { primaryAccepted: 8, recoveryAccepted: 0, costUsd: 0.0016 },
      cases: routingCases,
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

function buildCanonicalRoutingCases(ctx) {
  let requests = 0, spendUsd = 0;
  const routingCases = [];
  let rSafetyTotal = 0, rBasePrimary = 0, rCandPrimary = 0;
  let rBaseCost = 0, rCandCost = 0;
  const archetypes = new Set();

  for (const c of ctx.outcomes) {
    const isSafety = Boolean(c.isSafetyCanary);
    const bReq = !isSafety, dReq = !isSafety, cReq = !isSafety;
    const bCost = bReq ? 0.001 : 0, cCost = (dReq || cReq) ? 0.0002 : 0;

    if (bReq) requests++;
    if (dReq) requests++;
    if (cReq) requests++;
    spendUsd += bCost + cCost;

    if (isSafety) rSafetyTotal++;
    else {
      rBasePrimary++;
      rCandPrimary++;
      if (c.archetype && c.archetype !== "none") archetypes.add(c.archetype);
    }
    rBaseCost += bCost;
    rCandCost += cCost;

    routingCases.push({
      id: c.id,
      archetype: c.archetype,
      isSafety,
      isSafetyCanary: isSafety,
      expected: c.expected,
      expectedType: c.expectedType,
      baselineOutput: c.expected,
      candidatePrimaryOutput: c.expected,
      baselineRequested: bReq,
      decisionRequested: dReq,
      candidateRequested: cReq,
      recoveryRequested: false,
      baselineAttempted: !isSafety,
      baselineAccepted: !isSafety,
      candidatePrimaryAttempted: !isSafety,
      candidatePrimaryAccepted: !isSafety,
      recoveryAccepted: false,
      baselineCostUsd: bCost,
      candidateCostUsd: cCost,
    });
  }
  return {
    requests, spendUsd, routingCases,
    rSafetyTotal, rBasePrimary, rCandPrimary, rBaseCost, rCandCost, archetypes,
  };
}

export function makeCanonicalValidReportFixture(ctx = loadEvaluationDatasetContext()) {
  const sData = buildCanonicalSkillCases(ctx);
  const rData = buildCanonicalRoutingCases(ctx);
  const requests = sData.requests + rData.requests;
  const spendUsd = sData.spendUsd + rData.spendUsd;

  const catalogFingerprint = "cat";
  const candidateModel = "cand";
  const baselineModel = "base";
  const decisionModel = "typesafe/jev-1.13";
  const fp = policyFingerprint({ catalogFingerprint, candidateModel, baselineModel, decisionModel });

  return {
    version: 1,
    completed: true,
    errors: 0,
    requests,
    spendUsd: Number(spendUsd.toFixed(6)),
    unknownSpendUsd: 0,
    maxCostUsd: 1.0,
    decisionSnapshots: ["typesafe/jev-1.13"],
    catalogFingerprint,
    candidateModel,
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
    routing: {
      total: rData.routingCases.length,
      safetyTotal: rData.rSafetyTotal,
      safetyMisses: 0,
      archetypes: Array.from(rData.archetypes).sort(),
      baseline: { primaryAccepted: rData.rBasePrimary, costUsd: Number(rData.rBaseCost.toFixed(6)) },
      candidate: { primaryAccepted: rData.rCandPrimary, recoveryAccepted: 0, costUsd: Number(rData.rCandCost.toFixed(6)) },
      cases: rData.routingCases,
    },
  };
}

