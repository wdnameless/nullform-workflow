import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { policyFingerprint } from "../jev-evidence.mjs";

export function createTempDir(prefix = "jev-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeValidReportFixture() {
  const calibCases = Array.from({ length: 12 }, (_, i) => ({
    id: `calib-skill-${i}`,
    isCalibration: true,
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
