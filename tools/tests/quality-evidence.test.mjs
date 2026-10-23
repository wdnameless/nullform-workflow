import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readQualityEvidence,
  EXPECTED_MODEL,
  EXPECTED_OBSERVATIONS_HASH,
  RAW_OBSERVATIONS_PATH,
  SUMMARY_PATH,
  SPEND_LEDGER_PATH,
} from "../quality-evidence.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function getValidSummary() {
  const summaryContent = readFileSync(join(REPO_ROOT, SUMMARY_PATH), "utf8");
  return JSON.parse(summaryContent);
}

function writeSummaryToTmp(tmpDir, summaryObj) {
  mkdirSync(join(tmpDir, "core"), { recursive: true });
  writeFileSync(join(tmpDir, "core", "quality-evidence.summary.json"), JSON.stringify(summaryObj, null, 2), "utf8");
}

test("readQualityEvidence on live repository root validates exact historical observations", async () => {
  const evidence = await readQualityEvidence({ root: REPO_ROOT });
  assert.equal(evidence.valid, true);
  assert.equal(evidence.status, "ok");
  assert.equal(evidence.source, "retained-observations");
  assert.equal(evidence.sourceHash, EXPECTED_OBSERVATIONS_HASH);
  assert.equal(evidence.model, EXPECTED_MODEL);
  assert.equal(evidence.claimStatus, "not-proven");

  // Three review pairs: both 3/3 accurate
  assert.equal(evidence.review.pairs, 3);
  assert.equal(evidence.review.baselineAccurate, 3);
  assert.equal(evidence.review.candidateAccurate, 3);
  assert.ok(Math.abs(evidence.review.baselineTariffUsd - 0.0033195) < 1e-8);
  assert.ok(Math.abs(evidence.review.candidateTariffUsd - 0.00665775) < 1e-8);

  // Workflow pair: baseline 5 turns pass, candidate 6 turns fail at cap without final report
  assert.equal(evidence.workflow.baselineStatus, "passed");
  assert.equal(evidence.workflow.baselineRequests, 5);
  assert.equal(evidence.workflow.baselineTariffUsd, 0.0051855);
  assert.equal(evidence.workflow.candidateStatus, "failed");
  assert.equal(evidence.workflow.candidateRequests, 6);
  assert.equal(evidence.workflow.candidateTariffUsd, 0.01945125);

  // Cohort & Ledger totals
  assert.equal(evidence.cohort.totalRequests, 17);
  assert.equal(evidence.cohort.cumulativeTariffUsd, 0.034614);
  assert.equal(evidence.ledger.totalSettledRequests, 35);
  assert.ok(evidence.ledger.cumulativeTariffUsd > 0);
  assert.equal(evidence.ledger.unsettledRequests, 0);
  assert.equal(evidence.ledger.ceilingUsd, 1.0);
  assert.equal(evidence.ledger.status, "warn");
  assert.match(evidence.ledger.note, /drift/i);

  assert.ok(Array.isArray(evidence.limitations));
  assert.ok(evidence.limitations.length >= 5);
});

test("EOL portability: CRLF and LF in raw observations produce identical hash and valid evidence", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "crlf-test-"));
  try {
    const obsDir = join(tmp, "openspec/changes/skill-benefit-evaluation/evidence");
    mkdirSync(obsDir, { recursive: true });
    const raw = readFileSync(join(REPO_ROOT, RAW_OBSERVATIONS_PATH), "utf8");
    const crlf = raw.replace(/\r?\n/g, "\r\n");
    writeFileSync(join(obsDir, "observed-eight-sessions.json"), crlf, "utf8");

    const evidence = await readQualityEvidence({ root: tmp });
    assert.equal(evidence.valid, true);
    assert.equal(evidence.sourceHash, EXPECTED_OBSERVATIONS_HASH);
    assert.equal(evidence.review.baselineAccurate, 3);
    assert.equal(evidence.workflow.candidateRequests, 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readQualityEvidence on clean packaged summary in isolated root succeeds and labels historical snapshot", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "packaged-clean-"));
  try {
    writeSummaryToTmp(tmp, getValidSummary());
    const evidence = await readQualityEvidence({ root: tmp });
    assert.equal(evidence.valid, true);
    assert.equal(evidence.status, "ok");
    assert.equal(evidence.source, "packaged-summary");
    assert.equal(evidence.claimStatus, "not-proven");
    assert.equal(evidence.ledger.source, "historical-snapshot");
    assert.equal(evidence.ledger.totalSettledRequests, 18);
    assert.equal(evidence.ledger.unsettledRequests, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Mutation tests: one field at a time on actual valid summary
test("mutation: deleted summary.review.baselineTariffUsd fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-del-rev-"));
  try {
    const summary = getValidSummary();
    delete summary.summary.review.baselineTariffUsd;
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: NaN summary.review.baselineTariffUsd fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-nan-rev-"));
  try {
    const summary = getValidSummary();
    summary.summary.review.baselineTariffUsd = NaN;
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: string cost summary.review.baselineTariffUsd fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-str-rev-"));
  try {
    const summary = getValidSummary();
    summary.summary.review.baselineTariffUsd = "0.0033195";
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: forged sourceHash fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-forged-hash-"));
  try {
    const summary = getValidSummary();
    summary.sourceHash = "forged";
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: arbitrary 64-hex sourceHash mismatch fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-mismatch-hash-"));
  try {
    const summary = getValidSummary();
    summary.sourceHash = "a".repeat(64);
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: spendLedger unsettledRequests = 99 fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-unsettled-"));
  try {
    const summary = getValidSummary();
    summary.summary.spendLedger.unsettledRequests = 99;
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: spendLedger non-ok status fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-status-"));
  try {
    const summary = getValidSummary();
    summary.summary.spendLedger.status = "blocked_unknown_spend";
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: empty pairs array fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-empty-pairs-"));
  try {
    const summary = getValidSummary();
    summary.pairs = [];
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: duplicate sessionId across runs fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-dup-session-"));
  try {
    const summary = getValidSummary();
    summary.pairs[0].candidate.sessionId = summary.pairs[0].baseline.sessionId;
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
    assert.match(res.error, /Duplicate sessionId/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: model mismatch in baseline pair fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-model-mismatch-"));
  try {
    const summary = getValidSummary();
    summary.pairs[0].baseline.model = "anthropic/claude-3-opus";
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: fixtureHash mismatch in pair fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-fixture-mismatch-"));
  try {
    const summary = getValidSummary();
    summary.pairs[0].fixtureHash = "b".repeat(64);
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: candidate skillHash missing in candidate fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-missing-skillhash-"));
  try {
    const summary = getValidSummary();
    delete summary.pairs[0].candidate.skillHash;
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mutation: workflow candidate laundered to passed fails closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-launder-wf-"));
  try {
    const summary = getValidSummary();
    const wfPair = summary.pairs.find(p => p.task === "eval-workflow-execution-outcome");
    wfPair.candidate.evaluationStatus = "passed";
    wfPair.candidate.requirementsSatisfied = true;
    wfPair.candidate.stopReason = "stop";
    writeSummaryToTmp(tmp, summary);
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
    assert.match(res.error, /Workflow candidate must retain adverse failure/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fallback per explicit root: missing root data fails closed and does not inspect unrelated paths", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "isolated-empty-"));
  try {
    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, false);
    assert.equal(res.status, "error");
    assert.equal(res.claimStatus, "unknown");
    assert.match(res.error, /absent in root/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("R06: live spend-ledger fixture with 35 settled passes with drift note", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ledger-drift-"));
  try {
    const obsDir = join(tmp, "openspec/changes/skill-benefit-evaluation/evidence");
    mkdirSync(obsDir, { recursive: true });
    copyFileSync(join(REPO_ROOT, RAW_OBSERVATIONS_PATH), join(tmp, RAW_OBSERVATIONS_PATH));

    const ledgerDir = join(tmp, "bench/runs");
    mkdirSync(ledgerDir, { recursive: true });
    copyFileSync(join(REPO_ROOT, SPEND_LEDGER_PATH), join(tmp, SPEND_LEDGER_PATH));

    const res = await readQualityEvidence({ root: tmp });
    assert.equal(res.valid, true);
    assert.equal(res.status, "ok");
    assert.equal(res.ledger.source, "live-ledger");
    assert.equal(res.ledger.totalSettledRequests, 35);
    assert.equal(res.ledger.status, "warn");
    assert.match(res.ledger.note, /drift.*35/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
