import test from "node:test";
import assert from "node:assert/strict";

import {
  policyFingerprint,
  evaluateReport,
  loadEvaluationDatasetContext,
} from "../jev-evidence.mjs";
import {
  makeValidReportFixture,
  makeSyntheticDatasetContext,
  makeCanonicalValidReportFixture,
} from "./jev-test-helpers.mjs";

test("policyFingerprint: computes deterministic sha256 hex string", () => {
  const fp1 = policyFingerprint({
    catalogFingerprint: "cat123",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  const fp2 = policyFingerprint({
    catalogFingerprint: "cat123",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 64);

  const fpDifferentCat = policyFingerprint({
    catalogFingerprint: "cat456",
    baselineModel: "base-model",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.notEqual(fp1, fpDifferentCat);

  const fpDifferentBase = policyFingerprint({
    catalogFingerprint: "cat123",
    baselineModel: "other-base",
    decisionModel: "typesafe/jev-1.13",
  });
  assert.notEqual(fp1, fpDifferentBase);
});

test("evaluateReport: passes when all skill hurdles are met with raw case arrays", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, true, "Valid report with >=40 heldout must pass skill hurdles");
});

test("evaluateReport: rejects v1 reports without migration fallback", () => {
  const report = makeValidReportFixture();
  report.version = 1;
  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject v1 report");
});

test("evaluateReport: rejects report when skill heldout cases < 40 or calib cases < 12", () => {
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
  report.requests = 74;
  report.spendUsd = 0.0444;

  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject skill evaluation when cases < 40");
});

test("evaluateReport: recomputes correctness from expectedSkills sets and rejects attacker-supplied candidateCorrect", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);
  for (let i = 12; i < 52; i++) {
    report.skills.cases[i].expectedSkills = ["agent-browser", "playwright-cli"];
    ctx.heldout[i - 12].expectedSkills = ["agent-browser", "playwright-cli"];
    report.skills.cases[i].candidateSkill = "wrong-skill";
    report.skills.cases[i].candidateCorrect = true;
  }
  report.skills.candidate.correct = 0;

  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must recompute correctness and reject when observed skill is wrong");
});

test("evaluateReport: rejects inconsistent cost sums or fabricated fallback costs", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);
  report.skills.baseline.costUsd = 0.999;
  const res = evaluateReport(report, { datasetContext: ctx });
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
    confidence: 0.95,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0.0002,
  }));

  const heldoutCases = [
    {
      id: "heldout-safety-0",
      isSafety: true,
      isSafetyCanary: true,
      safetyMiss: true,
      expectedSkills: [],
      candidateSkill: "a",
      baselineSkill: null,
      baselineRequested: false,
      candidateRequested: false,
      baselineAttempted: false,
      candidateAttempted: false,
      baselineCostUsd: 0,
      candidateCostUsd: 0,
    },
    ...Array.from({ length: 39 }, (_, i) => ({
      id: `heldout-skill-${i}`,
      expectedSkills: ["a"],
      candidateSkill: "b",
      baselineSkill: "a",
      baselineRequested: true,
      candidateRequested: true,
      baselineAttempted: true,
      candidateAttempted: true,
      confidence: 0.95,
      criticalMiss: true,
      baselineCostUsd: 0.001,
      candidateCostUsd: 0.002,
    })),
  ];

  const fp = policyFingerprint({
    catalogFingerprint: "cat",
    baselineModel: "base",
    decisionModel: "typesafe/jev-1.13",
  });

  const report = {
    version: 2,
    completed: true,
    errors: 0,
    requests: 102,
    spendUsd: 0.1314,
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
    skillPassed: true,
    skills: {
      total: 52,
      eligible: 39,
      safetyTotal: 1,
      safetyMisses: 1,
      baseline: { attempted: 39, correct: 39, falsePositives: 0, costUsd: 0.039 },
      candidate: { attempted: 39, correct: 0, falsePositives: 0, criticalMisses: 39, costUsd: 0.078 },
      cases: [...calibCases, ...heldoutCases],
    },
  };

  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject skill when critical/safety misses exist or precision < 95%");
});

test("evaluateReport: rejects incomplete reports or reports with errors, dryRun, or simulated", () => {
  const incompleteReport = {
    version: 2,
    completed: false,
    errors: 2,
    skills: { cases: [] },
  };
  const ctx = { hashes: { calibration: "a".repeat(64), heldout: "b".repeat(64) } };
  const res = evaluateReport(incompleteReport, { datasetContext: ctx });
  assert.equal(res.skillPassed, false);

  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, dryRun: true }, { datasetContext: ctx }).skillPassed, false);
  assert.equal(evaluateReport({ ...incompleteReport, completed: true, errors: 0, simulated: true }, { datasetContext: ctx }).skillPassed, false);
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
  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject when heldout count < 40");
});

test("evaluateReport boundary: calibration successes cannot inflate held-out precision or coverage", () => {
  const report = makeValidReportFixture();
  for (let i = 12; i < 15; i++) {
    report.skills.cases[i].candidateSkill = "wrong-skill";
  }
  report.skills.candidate.correct = 37;
  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject when candidate precision < 95%");
});

test("evaluateReport boundary: rejects bogus global spendUsd or negative errors", () => {
  const reportBogusSpend = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(reportBogusSpend);
  reportBogusSpend.spendUsd = 0.0096;
  assert.equal(evaluateReport(reportBogusSpend, { datasetContext: ctx }).skillPassed, false, "Must reject bogus spendUsd");

  const reportNegErrors = makeValidReportFixture();
  reportNegErrors.errors = -1;
  assert.equal(evaluateReport(reportNegErrors, { datasetContext: ctx }).skillPassed, false, "Must reject negative errors");
});

test("evaluateReport boundary: rejects mismatched request count or network flags on safety rows", () => {
  const reportBadReqs = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(reportBadReqs);
  reportBadReqs.requests = 96;
  assert.equal(evaluateReport(reportBadReqs, { datasetContext: ctx }).skillPassed, false, "Must reject mismatched request count");

  const reportSafetyNet = makeValidReportFixture();
  reportSafetyNet.skills.cases.push({
    id: "heldout-safety-leak",
    isSafety: true,
    isSafetyCanary: true,
    safetyMiss: false,
    expectedSkills: [],
    baselineSkill: null,
    candidateSkill: "none",
    baselineRequested: true,
    candidateRequested: false,
    baselineAttempted: false,
    candidateAttempted: false,
    confidence: 0,
    baselineCostUsd: 0.001,
    candidateCostUsd: 0,
  });
  reportSafetyNet.skills.total++;
  reportSafetyNet.skills.safetyTotal++;
  reportSafetyNet.requests++;
  reportSafetyNet.spendUsd = Number((reportSafetyNet.spendUsd + 0.001).toFixed(6));
  const ctxSafety = makeSyntheticDatasetContext(reportSafetyNet);
  assert.equal(evaluateReport(reportSafetyNet, { datasetContext: ctxSafety }).skillPassed, false, "Safety rows must have requested=false");
});

test("evaluateReport boundary: rejects dryRun===true or simulated===true as non-proof", () => {
  const reportDry = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(reportDry);
  reportDry.dryRun = true;
  assert.equal(evaluateReport(reportDry, { datasetContext: ctx }).skillPassed, false, "Must reject dryRun===true");

  const reportSim = makeValidReportFixture();
  reportSim.simulated = true;
  assert.equal(evaluateReport(reportSim, { datasetContext: ctx }).skillPassed, false, "Must reject simulated===true");
});

test("evaluateReport boundary: rejects calib cases < 12 or overlapping case IDs", () => {
  const reportFewCalib = makeValidReportFixture();
  reportFewCalib.skills.cases = reportFewCalib.skills.cases.filter((c) => c.id !== "calib-skill-10" && c.id !== "calib-skill-11");
  reportFewCalib.skills.total = 50;
  reportFewCalib.calibration.total = 10;
  reportFewCalib.requests -= 4;
  reportFewCalib.spendUsd = Number((reportFewCalib.spendUsd - 0.0024).toFixed(6));
  const ctxFew = makeSyntheticDatasetContext(reportFewCalib);
  assert.equal(evaluateReport(reportFewCalib, { datasetContext: ctxFew }).skillPassed, false, "Must reject calib < 12");

  const reportOverlap = makeValidReportFixture();
  reportOverlap.skills.cases[0].id = reportOverlap.skills.cases[12].id;
  const ctxOverlap = makeSyntheticDatasetContext(reportOverlap);
  assert.equal(evaluateReport(reportOverlap, { datasetContext: ctxOverlap }).skillPassed, false, "Must reject overlapping case IDs");
});

test("evaluateReport boundary: fails closed when datasetContext is missing or invalid", () => {
  const report = makeValidReportFixture();
  assert.equal(evaluateReport(report).skillPassed, false, "Must fail closed when datasetContext omitted");
  assert.equal(evaluateReport(report, {}).skillPassed, false, "Must fail closed when datasetContext empty");
  assert.equal(evaluateReport(report, { datasetContext: null }).skillPassed, false);
});

test("evaluateReport boundary: rejects clean reports with unknownSpendUsd > 0", () => {
  const report = makeValidReportFixture();
  report.unknownSpendUsd = 0.005;
  report.spendUsd = Number((report.spendUsd + 0.005).toFixed(6));
  const ctx = makeSyntheticDatasetContext(report);
  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Clean completed report must require unknownSpendUsd === 0");
});

test("evaluateReport boundary: rejects non-64hex or mismatched dataset hashes", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);

  // Non-64hex string
  const reportShortHash = { ...report, datasetHashes: { calibration: "abc", heldout: "def" } };
  assert.equal(evaluateReport(reportShortHash, { datasetContext: ctx }).skillPassed, false, "Must reject short non-64hex hashes");

  // Mismatched hash
  const reportMismatchHash = { ...report, datasetHashes: { ...report.datasetHashes, heldout: "f".repeat(64) } };
  assert.equal(evaluateReport(reportMismatchHash, { datasetContext: ctx }).skillPassed, false, "Must reject hash mismatching datasetContext");
});

test("evaluateReport boundary: rejects when safety canary flags are stripped or tampered", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);
  ctx.heldout[0].isSafetyCanary = true;
  report.skills.cases[12].isSafety = false;
  report.skills.cases[12].isSafetyCanary = false;

  const res = evaluateReport(report, { datasetContext: ctx });
  assert.equal(res.skillPassed, false, "Must reject report when gold safety canary flag is stripped");
});

test("evaluateReport boundary: rejects when gold expectedSkills is tampered", () => {
  const report = makeValidReportFixture();
  const ctx = makeSyntheticDatasetContext(report);
  report.skills.cases[12].expectedSkills = ["tampered-skill"];
  assert.equal(evaluateReport(report, { datasetContext: ctx }).skillPassed, false, "Must reject tampered expectedSkills");
});

test("loadEvaluationDatasetContext: loads canonical corpus and computes matching 64-hex hashes", () => {
  const ctx = loadEvaluationDatasetContext();
  assert.ok(ctx !== null, "Canonical context must load from installed fixtures");
  assert.equal(ctx.calibration.length, 14);
  assert.equal(ctx.heldout.length, 44);
  assert.equal(ctx.outcomes, undefined, "Outcomes must not be loaded in v2");
  assert.match(ctx.hashes.calibration, /^[0-9a-f]{64}$/);
  assert.match(ctx.hashes.heldout, /^[0-9a-f]{64}$/);

  // Evaluates canonical valid report fixture with canonical datasetContext
  const canonicalReport = makeCanonicalValidReportFixture(ctx);
  const res = evaluateReport(canonicalReport, { datasetContext: ctx });
  assert.equal(res.skillPassed, true);
});
