import test from "node:test";
import assert from "node:assert/strict";

import {
  policyFingerprint,
  evaluateReport,
  checkOutcomeMatch,
} from "../jev-evidence.mjs";
import { makeValidReportFixture } from "./jev-test-helpers.mjs";

test("policyFingerprint: computes deterministic sha256 hex string", () => {
  const fp1 = policyFingerprint({
    catalogFingerprint: "cat123",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  const fp2 = policyFingerprint({
    catalogFingerprint: "cat123",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 64);

  const fpDifferent = policyFingerprint({
    catalogFingerprint: "cat456",
    candidateModel: "cand-model",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.notEqual(fp1, fpDifferent);
});

test("evaluateReport: passes when all skill and routing hurdles are met with raw case arrays", () => {
  const report = makeValidReportFixture();
  const res = evaluateReport(report);
  assert.equal(res.skillPassed, true, "Valid report with >=40 heldout and >=8 routing must pass skill hurdles");
  assert.equal(res.routingPassed, true, "Valid report must pass routing hurdles");
  assert.deepEqual(res.archetypes, ["lookup"]);
});

test("evaluateReport: rejects report when skill cases < 40 or routing cases < 8", () => {
  const report = makeValidReportFixture();
  report.skills.cases = [
    ...report.skills.cases.slice(0, 12),
    ...report.skills.cases.slice(12, 37),
  ];
  report.skills.total = 37;
  report.skills.eligible = 25;
  report.skills.baseline = { attempted: 25, correct: 25, costUsd: 0.025 };
  report.skills.candidate = { attempted: 25, correct: 25, criticalMisses: 0, costUsd: 0.005 };
  report.heldout.total = 25;
  report.routing.cases = report.routing.cases.slice(0, 4);
  report.routing.total = 4;
  report.routing.baseline = { primaryAccepted: 4, costUsd: 0.004 };
  report.routing.candidate = { primaryAccepted: 4, recoveryAccepted: 0, costUsd: 0.0008 };
  report.requests = 86;
  report.spendUsd = 0.0492;

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject skill evaluation when cases < 40");
  assert.equal(res.routingPassed, false, "Must reject routing evaluation when cases < 8");
});

test("evaluateReport: recomputes correctness from expectedSkills sets and rejects attacker-supplied candidateCorrect", () => {
  const report = makeValidReportFixture();
  for (let i = 12; i < 52; i++) {
    report.skills.cases[i].expectedSkills = ["agent-browser", "playwright-cli"];
    report.skills.cases[i].candidateSkill = "wrong-skill";
    report.skills.cases[i].candidateCorrect = true;
  }
  report.skills.candidate.correct = 0;

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must recompute correctness and reject when observed skill is wrong");
});

test("evaluateReport: rejects inconsistent cost sums or fabricated fallback costs", () => {
  const report = makeValidReportFixture();
  report.skills.baseline.costUsd = 0.999;
  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject inconsistent summary costs");
});

test("evaluateReport: rejects fake passed booleans when case arrays fail hurdles", () => {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
    expectedSkills: ["a"],
    candidateSkill: "a",
    baselineSkill: "a",
    baselineRequested: true,
    candidateRequested: true,
    baselineAttempted: true,
    candidateAttempted: true,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = [
    { id: "heldout-safety-0", isSafety: true, safetyMiss: true, baselineRequested: false, candidateRequested: false, baselineCostUsd: 0, candidateCostUsd: 0 },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `heldout-skill-${i}`,
      expectedSkills: ["a"],
      candidateSkill: "b",
      baselineSkill: "a",
      baselineRequested: true,
      candidateRequested: true,
      baselineAttempted: true,
      candidateAttempted: true,
      criticalMiss: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.002,
    })),
  ];

  const report = {
    version: 1,
    completed: true,
    errors: 0,
    requests: 54,
    spendUsd: 0.0554,
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
    heldout: { total: 10, hash: "b".repeat(64) },
    datasetHashes: { calibration: "a".repeat(64), heldout: "b".repeat(64), outcomes: "c".repeat(64) },
    skillPassed: true,
    routingPassed: true,
    skills: {
      total: 22,
      eligible: 9,
      safetyTotal: 1,
      safetyMisses: 1,
      baseline: { attempted: 9, correct: 9, falsePositives: 0, costUsd: 0.009 },
      candidate: { attempted: 9, correct: 0, falsePositives: 0, criticalMisses: 9, costUsd: 0.018 },
      cases: [...calibCases, ...heldoutCases],
    },
    routing: {
      total: 4,
      safetyMisses: 1,
      archetypes: ["lookup"],
      baseline: { primaryAccepted: 4, costUsd: 0.004 },
      candidate: { primaryAccepted: 2, recoveryAccepted: 2, costUsd: 0.01 },
      cases: [
        { id: "route-0", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: true, recoveryRequested: false, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: true, candidatePrimaryAccepted: true, safetyMiss: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-1", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: true, recoveryRequested: false, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: true, candidatePrimaryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-2", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: false, recoveryRequested: true, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: false, candidatePrimaryAccepted: false, recoveryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
        { id: "route-3", archetype: "lookup", baselineRequested: true, decisionRequested: true, candidateRequested: false, recoveryRequested: true, baselineAttempted: true, baselineAccepted: true, candidatePrimaryAttempted: false, candidatePrimaryAccepted: false, recoveryAccepted: true, baselineCostUsd: 0.001, candidateCostUsd: 0.0025 },
      ],
    },
  };

  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject skill when critical/safety misses exist or precision < 95%");
  assert.equal(res.routingPassed, false, "Must reject routing when cases < 8 or safety misses > 0 or candidate cost higher");
  assert.deepEqual(res.archetypes, []);
});

test("evaluateReport: rejects incomplete reports or reports with errors, dryRun, or simulated", () => {
  const incompleteReport = {
    version: 1,
    completed: false,
    errors: 2,
    skills: { cases: [] },
    routing: { cases: [] },
  };
  const res = evaluateReport(incompleteReport);
  assert.equal(res.skillPassed, false);
  assert.equal(res.routingPassed, false);

  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, dryRun: true }).skillPassed, false);
  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, simulated: true }).skillPassed, false);
});

test("evaluateReport boundary: partial output must not pass exact outcome matching", () => {
  const report = makeValidReportFixture();
  report.routing.cases[0].candidatePrimaryOutput = "full complete";
  const res = evaluateReport(report);
  assert.equal(res.routingPassed, false, "Partial prefix output must fail exact match");
});

test("evaluateReport boundary: calibration cases cannot qualify held-out quota", () => {
  const report = makeValidReportFixture();
  for (let i = 12; i < 22; i++) {
    report.skills.cases[i].id = `calib-extra-${i}`;
    report.skills.cases[i].isCalibration = true;
  }
  report.calibration.total = 22;
  report.heldout.total = 30;
  report.skills.eligible = 30;
  report.skills.baseline.attempted = 30;
  report.skills.baseline.correct = 30;
  report.skills.baseline.costUsd = 0.03;
  report.skills.candidate.attempted = 30;
  report.skills.candidate.correct = 30;
  report.skills.candidate.costUsd = 0.006;
  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject when heldout count < 40");
});

test("evaluateReport boundary: calibration successes cannot inflate held-out precision or coverage", () => {
  const report = makeValidReportFixture();
  for (let i = 12; i < 15; i++) {
    report.skills.cases[i].candidateSkill = "wrong-skill";
  }
  report.skills.candidate.correct = 37;
  const res = evaluateReport(report);
  assert.equal(res.skillPassed, false, "Must reject when candidate precision < 95%");
});

test("evaluateReport boundary: rejects bogus global spendUsd or negative errors", () => {
  const reportBogusSpend = makeValidReportFixture();
  reportBogusSpend.spendUsd = 0.0096;
  assert.equal(evaluateReport(reportBogusSpend).skillPassed, false, "Must reject bogus spendUsd");

  const reportNegErrors = makeValidReportFixture();
  reportNegErrors.errors = -1;
  assert.equal(evaluateReport(reportNegErrors).skillPassed, false, "Must reject negative errors");
});

test("evaluateReport boundary: rejects mismatched request count or network flags on safety rows", () => {
  const reportBadReqs = makeValidReportFixture();
  reportBadReqs.requests = 96;
  assert.equal(evaluateReport(reportBadReqs).skillPassed, false, "Must reject mismatched request count");

  const reportSafetyNet = makeValidReportFixture();
  reportSafetyNet.skills.cases.push({
    id: "heldout-safety-leak",
    isSafety: true,
    safetyMiss: false,
    expectedSkills: [],
    baselineSkill: null,
    candidateSkill: "none",
    baselineRequested: true,
    candidateRequested: false,
    baselineAttempted: false,
    candidateAttempted: false,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0,
  });
  reportSafetyNet.skills.total++;
  reportSafetyNet.skills.safetyTotal++;
  reportSafetyNet.requests++;
  reportSafetyNet.spendUsd = Number((reportSafetyNet.spendUsd + 0.001).toFixed(6));
  assert.equal(evaluateReport(reportSafetyNet).skillPassed, false, "Safety rows must have requested=false");
});

test("evaluateReport boundary: rejects missing or false primary-attempt claims even if fabricated accepted true", () => {
  const report = makeValidReportFixture();
  report.routing.cases[0].candidatePrimaryAttempted = false;
  const res = evaluateReport(report);
  assert.equal(res.routingPassed, false, "Must reject report claiming primary accepted without primary attempted");
});

test("evaluateReport boundary: rejects dryRun===true or simulated===true as non-proof", () => {
  const reportDry = makeValidReportFixture();
  reportDry.dryRun = true;
  assert.equal(evaluateReport(reportDry).skillPassed, false, "Must reject dryRun===true");

  const reportSim = makeValidReportFixture();
  reportSim.simulated = true;
  assert.equal(evaluateReport(reportSim).skillPassed, false, "Must reject simulated===true");
});

test("evaluateReport boundary: rejects calib cases < 12 or overlapping case IDs", () => {
  const reportFewCalib = makeValidReportFixture();
  reportFewCalib.skills.cases = reportFewCalib.skills.cases.filter((c) => c.id !== "calib-skill-10" && c.id !== "calib-skill-11");
  reportFewCalib.skills.total = 50;
  reportFewCalib.calibration.total = 10;
  reportFewCalib.requests -= 4;
  reportFewCalib.spendUsd = Number((reportFewCalib.spendUsd - 0.0024).toFixed(6));
  assert.equal(evaluateReport(reportFewCalib).skillPassed, false, "Must reject calib < 12");

  const reportOverlap = makeValidReportFixture();
  reportOverlap.skills.cases[0].id = reportOverlap.skills.cases[12].id;
  assert.equal(evaluateReport(reportOverlap).skillPassed, false, "Must reject overlapping case IDs");
});
