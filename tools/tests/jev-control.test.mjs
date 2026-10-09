/**
 * tools/tests/jev-control.test.mjs
 * Behavioral tests for JEV local control CLI, policy management, and hurdle proof verification (R06).
 * Skills-only v2.
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
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

import { executeControl, parseControlArgs } from "../jev-control.mjs";
import { buildReportV2 } from "../jev-evaluate.mjs";
import { evaluateReport, policyFingerprint, loadEvaluationDatasetContext } from "../jev-evidence.mjs";
import { loadSkillCatalog } from "../jev-assist.mjs";

const DATASET_CTX = loadEvaluationDatasetContext();

function makeCanonicalSkillCase(c, isCalibration) {
  const isSafety = Boolean(c.isSafetyCanary || c.isSafety);
  const exp = c.expectedSkills || (c.expectedSkill ? [c.expectedSkill] : []);
  const expSkill = exp[0] || "none";
  return {
    id: c.id,
    isCalibration,
    isSafety,
    isSafetyCanary: isSafety,
    safetyMiss: false,
    screened: isSafety,
    expectedSkills: exp,
    expectedSkill: expSkill,
    baselineRequested: !isSafety,
    candidateRequested: !isSafety,
    baselineAttempted: !isSafety,
    baselineSkill: isSafety ? null : expSkill,
    baselineCorrect: !isSafety,
    candidateAttempted: !isSafety,
    candidateSkill: isSafety ? null : expSkill,
    candidateCorrect: !isSafety,
    confidence: isSafety ? null : 0.95,
    criticalMiss: false,
    baselineCostUsd: isSafety ? 0 : 0.0005,
    candidateCostUsd: isSafety ? 0 : 0.0001,
  };
}

function makeSyntheticPassingReport() {
  const cases = [
    ...DATASET_CTX.calibration.map((c) => makeCanonicalSkillCase(c, true)),
    ...DATASET_CTX.heldout.map((c) => makeCanonicalSkillCase(c, false)),
  ];

  return buildReportV2({
    catalogFingerprint: "catalog-sha-1234",
    baselineModel: "google/gemini-3.8-flash",
    decisionModel: "typesafe/jev-1.13",
    datasetHashes: { ...DATASET_CTX.hashes },
    decisionSnapshots: ["typesafe/jev-1.13-20260917"],
    calibrationCount: DATASET_CTX.calibration.length,
    heldoutCount: DATASET_CTX.heldout.length,
    skillCases: cases,
    maxCostUsd: 1.0,
    totalSpend: 0,
    unknownSpend: 0,
    errors: 0,
  });
}

test("evaluateReport accepts legitimate passing report", () => {
  const report = makeSyntheticPassingReport();
  const res = evaluateReport(report, { datasetContext: DATASET_CTX });
  assert.strictEqual(res.skillPassed, true);
});

test("evaluateReport rejects incomplete reports or reports with errors", () => {
  const report = makeSyntheticPassingReport();
  report.completed = false;
  assert.strictEqual(evaluateReport(report, { datasetContext: DATASET_CTX }).skillPassed, false);

  report.completed = true;
  report.errors = 1;
  assert.strictEqual(evaluateReport(report, { datasetContext: DATASET_CTX }).skillPassed, false);
});

test("evaluateReport refuses fake booleans when raw denominators fail", () => {
  const report = makeSyntheticPassingReport();
  const heldoutEligible = report.skills.cases.filter((c) => !c.isSafety && !c.id.startsWith("calib"));
  for (let i = 0; i < 5; i++) {
    heldoutEligible[i].candidateCorrect = false;
    heldoutEligible[i].candidateSkill = "wrong-skill";
  }

  const res = evaluateReport(report, { datasetContext: DATASET_CTX });
  assert.strictEqual(res.skillPassed, false, "must reject when candidate precision < 95%");
});

test("evaluateReport rejects when safety misses > 0", () => {
  const report = makeSyntheticPassingReport();
  const safetyCase = report.skills.cases.find((c) => c.isSafety);
  if (safetyCase) {
    safetyCase.safetyMiss = true;
  }

  const res = evaluateReport(report, { datasetContext: DATASET_CTX });
  assert.strictEqual(res.skillPassed, false);
});

test("evaluateReport rejects dryRun / simulated reports", () => {
  const report = makeSyntheticPassingReport();
  report.dryRun = true;
  assert.strictEqual(evaluateReport(report, { datasetContext: DATASET_CTX }).skillPassed, false);

  const report2 = makeSyntheticPassingReport();
  report2.simulated = true;
  assert.strictEqual(evaluateReport(report2, { datasetContext: DATASET_CTX }).skillPassed, false);
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
    assert.match(res.message, /hurdles failed|precision\/coverage\/cost/i);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable rejects historical v1 report", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-v1-"));
  try {
    const v1Report = {
      version: 1,
      completed: true,
      errors: 0,
      baselineModel: "google/gemini-3.8-flash",
      candidateModel: "google/gemini-3.1-flash-lite",
      decisionModel: "typesafe/jev-1.13",
      routing: { total: 10 },
      skills: { total: 58 },
    };
    const reportPath = join(tmpHome, "v1-report.json");
    writeFileSync(reportPath, JSON.stringify(v1Report, null, 2), "utf8");

    const res = await executeControl({
      command: "enable",
      home: tmpHome,
      root: ".",
      reportPath,
    });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /not v2|historical.*v1/i);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("jev-control enable writes v2 policy and enables automatic assistance on valid proof", async () => {
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
    assert.strictEqual(policy.version, 2);
    assert.strictEqual(policy.baselineModel, "google/gemini-3.8-flash");
    assert.strictEqual(policy.decisionModel, "typesafe/jev-1.13");
    assert.strictEqual(policy.candidateModel, undefined, "candidateModel must be deleted in v2 policy");
    assert.strictEqual(policy.routingPassed, undefined, "routingPassed must be deleted in v2 policy");
    assert.strictEqual(policy.archetypes, undefined, "archetypes must be deleted in v2 policy");
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

test("jev-control status rejects obsolete v1 policy", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-ctrl-v1-status-"));
  try {
    const policyDir = join(tmpHome, ".omp", "agent");
    const policyFile = join(policyDir, "jev-policy.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      policyFile,
      JSON.stringify({ version: 1, enabled: true, routingPassed: true, candidateModel: "google/gemini-3.1-flash-lite" }),
      "utf8"
    );

    const res = await executeControl({
      command: "status",
      home: tmpHome,
      root: ".",
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status.state, "invalid");
    assert.match(res.message, /obsolete|unsupported|v1/i);
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

test("jev-control --help returns exit 0 with usage", () => {
  const parsed = parseControlArgs(["--help"]);
  assert.strictEqual(parsed.help, true);

  const scriptPath = join(import.meta.dirname, "../jev-control.mjs");
  const res = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /Usage: jev-control\.mjs/);
});
