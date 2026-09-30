/**
 * tools/tests/jev-control.test.mjs
 * Behavioral tests for JEV local control CLI, policy management, and hurdle proof verification (R06).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseControlArgs, executeControl } from "../jev-control.mjs";
import { buildReportV1 } from "../jev-evaluate.mjs";
import { evaluateReport, policyFingerprint } from "../jev-evidence.mjs";
import { loadSkillCatalog } from "../jev-assist.mjs";

function makeSkillCase(id, isCalib = false, isSafety = false) {
  return {
    id,
    isCalibration: isCalib,
    isSafety,
    safetyMiss: false,
    screened: isSafety,
    expectedSkills: isSafety ? [] : ["better-ui"],
    expectedSkill: isSafety ? "none" : "better-ui",
    baselineRequested: !isSafety,
    candidateRequested: !isSafety,
    baselineAttempted: !isSafety,
    baselineSkill: isSafety ? null : "better-ui",
    baselineCorrect: !isSafety,
    candidateAttempted: !isSafety,
    candidateSkill: isSafety ? null : "better-ui",
    candidateCorrect: !isSafety,
    skillConfidence: isSafety ? undefined : 0.95,
    criticalMiss: false,
    baselineCostUsd: isSafety ? 0 : 0.0005,
    candidateCostUsd: isSafety ? 0 : 0.0001,
  };
}

function makeSyntheticPassingReport() {
  const cases = [];
  for (let i = 0; i < 12; i++) cases.push(makeSkillCase(`calib-${i}`, true, false));
  for (let i = 0; i < 40; i++) cases.push(makeSkillCase(`heldout-${i}`, false, false));
  for (let i = 0; i < 2; i++) cases.push(makeSkillCase(`heldout-safety-${i}`, false, true));

  const routingCases = [];
  const archetypes = ["lookup", "json-transform", "formatting", "text-normalization"];
  for (let i = 0; i < 8; i++) {
    const arch = archetypes[i % archetypes.length];
    routingCases.push({
      id: `route-${i}`,
      archetype: arch,
      isSafety: false,
      safetyMiss: false,
      expected: `expected-output-${i}`,
      expectedType: "text",
      baselineRequested: true,
      decisionRequested: true,
      candidateRequested: true,
      recoveryRequested: false,
      baselineAttempted: true,
      baselineOutput: `expected-output-${i}`,
      baselineAccepted: true,
      baselineCostUsd: 0.001,
      candidatePrimaryAttempted: true,
      candidatePrimaryOutput: `expected-output-${i}`,
      candidatePrimaryAccepted: true,
      recoveryAttempted: false,
      recoveryOutput: null,
      recoveryAccepted: false,
      candidateCostUsd: 0.0002,
    });
  }

  const datasetHashes = {
    calibration: "a".repeat(64),
    heldout: "b".repeat(64),
    outcomes: "c".repeat(64),
  };

  const rawCost = Number(((12 + 40) * (0.0005 + 0.0001) + 8 * (0.001 + 0.0002)).toFixed(6));

  return buildReportV1({
    catalogFingerprint: "catalog-sha-1234",
    baselineModel: "google/gemini-3.8-flash",
    candidateModel: "google/gemini-3.1-flash-lite",
    decisionModel: "typesafe/jev-1.13",
    datasetHashes,
    decisionSnapshots: ["typesafe/jev-1.13-20260917"],
    calibrationCount: 12,
    heldoutCount: 42,
    skillCases: cases,
    routingCases,
    maxCostUsd: 1.0,
    totalSpend: rawCost,
    unknownSpend: 0,
    errors: 0,
  });
}

test("evaluateReport accepts legitimate passing report", () => {
  const report = makeSyntheticPassingReport();
  const res = evaluateReport(report);
  assert.strictEqual(res.skillPassed, true);
  assert.strictEqual(res.routingPassed, true);
  assert.strictEqual(res.archetypes.length, 4);
});

test("evaluateReport rejects incomplete reports or reports with errors", () => {
  const report = makeSyntheticPassingReport();
  report.completed = false;
  assert.strictEqual(evaluateReport(report).skillPassed, false);

  report.completed = true;
  report.errors = 1;
  assert.strictEqual(evaluateReport(report).skillPassed, false);
});

test("evaluateReport refuses fake booleans when raw denominators fail", () => {
  const report = makeSyntheticPassingReport();
  const heldoutEligible = report.skills.cases.filter((c) => !c.isSafety && !c.id.startsWith("calib"));
  for (let i = 0; i < 5; i++) {
    heldoutEligible[i].candidateCorrect = false;
    heldoutEligible[i].candidateSkill = "wrong-skill";
  }

  report.skillPassed = true;
  report.routingPassed = true;

  const res = evaluateReport(report);
  assert.strictEqual(res.skillPassed, false, "must reject when candidate precision < 95%");
});

test("evaluateReport refuses routing when fallback success is conflated as primary", () => {
  const report = makeSyntheticPassingReport();
  report.routing.cases[0].candidatePrimaryAccepted = false;
  report.routing.cases[0].recoveryAccepted = true;

  const res = evaluateReport(report);
  assert.strictEqual(res.routingPassed, false, "recovery fallback must not inflate primary accepted count");
});

test("evaluateReport refuses routing when cheap cost per accepted outcome is not lower", () => {
  const report = makeSyntheticPassingReport();
  for (const c of report.routing.cases) {
    c.candidateCostUsd = 0.005;
  }
  const res = evaluateReport(report);
  assert.strictEqual(res.routingPassed, false, "must reject when candidate cost >= baseline cost");
});

test("evaluateReport rejects when safety misses > 0", () => {
  const report = makeSyntheticPassingReport();
  report.routing.cases[0].safetyMiss = true;

  const res = evaluateReport(report);
  assert.strictEqual(res.routingPassed, false);
});

test("evaluateReport rejects dryRun / simulated reports", () => {
  const report = makeSyntheticPassingReport();
  report.dryRun = true;
  assert.strictEqual(evaluateReport(report).skillPassed, false);

  const report2 = makeSyntheticPassingReport();
  report2.simulated = true;
  assert.strictEqual(evaluateReport(report2).skillPassed, false);
});

test("jev-control enable refuses non-existent report", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-test-"));
  try {
    const res = await executeControl({
      command: "enable",
      home: tmpHome,
      root: ".",
      reportPath: join(tmpHome, "non-existent.json"),
    });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /not found/i);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable refuses failing report", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-test-"));
  try {
    const badReport = makeSyntheticPassingReport();
    badReport.completed = false;
    const reportPath = join(tmpHome, "report.json");
    writeFileSync(reportPath, JSON.stringify(badReport, null, 2), "utf8");

    const res = await executeControl({
      command: "enable",
      home: tmpHome,
      root: ".",
      reportPath,
    });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /hurdles failed|no passing capabilities/i);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable writes policy and enables automatic assistance on valid proof", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-test-"));
  try {
    const passingReport = makeSyntheticPassingReport();
    const reportPath = join(tmpHome, "valid-report.json");
    writeFileSync(reportPath, JSON.stringify(passingReport, null, 2), "utf8");

    const res = await executeControl({
      command: "enable",
      home: tmpHome,
      root: ".",
      reportPath,
      catalogFingerprint: passingReport.catalogFingerprint,
    });
    assert.strictEqual(res.success, true);

    const policyFile = join(tmpHome, ".omp", "agent", "jev-policy.json");
    assert.ok(existsSync(policyFile), "jev-policy.json must be written");

    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.strictEqual(policy.enabled, true);
    assert.strictEqual(policy.version, 1);
    assert.strictEqual(policy.skillPassed, true);
    assert.strictEqual(policy.routingPassed, true);
    assert.ok(policy.fingerprint, "fingerprint must be present");
    assert.ok(policy.reportSha256, "reportSha256 must be present");
    assert.ok(Array.isArray(policy.decisionSnapshots), "decisionSnapshots must be preserved");

    const statusRes = await executeControl({
      command: "status",
      home: tmpHome,
      root: ".",
    });
    assert.strictEqual(statusRes.success, true);
    assert.strictEqual(statusRes.policy?.enabled, true);

    const disableRes = await executeControl({
      command: "disable",
      home: tmpHome,
      root: ".",
    });
    assert.strictEqual(disableRes.success, true);

    const disabledPolicy = JSON.parse(readFileSync(policyFile, "utf8"));
    assert.strictEqual(disabledPolicy.enabled, false);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable validates catalog fingerprint from --catalog snapshot", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-cat-"));
  try {
    const catalogPath = join(tmpHome, "catalog-snapshot.json");
    const snapshot = [
      { name: "better-ui", description: "Polish UI visual details" },
      { name: "docker-patterns", description: "Docker best practices" },
    ];
    writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2), "utf8");

    const expectedCatalog = loadSkillCatalog({ cwd: tmpHome, home: tmpHome, effectiveSkills: snapshot });

    const passingReport = makeSyntheticPassingReport();
    passingReport.catalogFingerprint = expectedCatalog.fingerprint;
    passingReport.fingerprint = policyFingerprint({
      catalogFingerprint: expectedCatalog.fingerprint,
      candidateModel: passingReport.candidateModel,
      baselineModel: passingReport.baselineModel,
      decisionModel: passingReport.decisionModel,
    });

    const reportPath = join(tmpHome, "valid-report.json");
    writeFileSync(reportPath, JSON.stringify(passingReport, null, 2), "utf8");

    const res = await executeControl({
      command: "enable",
      home: tmpHome,
      root: tmpHome,
      reportPath,
      catalog: catalogPath,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.policy.catalogFingerprint, expectedCatalog.fingerprint);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable fails closed when supplied --catalog snapshot is invalid, nonexistent, or mismatched", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-fail-"));
  try {
    const passingReport = makeSyntheticPassingReport();
    const reportPath = join(tmpHome, "valid-report.json");
    writeFileSync(reportPath, JSON.stringify(passingReport, null, 2), "utf8");

    // 1. Nonexistent catalog file
    const resMissing = await executeControl({
      command: "enable",
      home: tmpHome,
      root: tmpHome,
      reportPath,
      catalog: join(tmpHome, "nonexistent.json"),
    });
    assert.strictEqual(resMissing.success, false);

    // 2. Malformed JSON catalog file
    const malformedPath = join(tmpHome, "malformed.json");
    writeFileSync(malformedPath, "not valid json {", "utf8");
    const resMalformed = await executeControl({
      command: "enable",
      home: tmpHome,
      root: tmpHome,
      reportPath,
      catalog: malformedPath,
    });
    assert.strictEqual(resMalformed.success, false);

    // 3. Mismatched catalog fingerprint
    const diffPath = join(tmpHome, "diff.json");
    writeFileSync(diffPath, JSON.stringify([{ name: "diff-skill", description: "Different" }]), "utf8");
    const resDiff = await executeControl({
      command: "enable",
      home: tmpHome,
      root: tmpHome,
      reportPath,
      catalog: diffPath,
    });
    assert.strictEqual(resDiff.success, false);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
