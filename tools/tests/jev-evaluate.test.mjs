/**
 * tools/tests/jev-evaluate.test.mjs
 * Behavioral and contract tests for JEV paired evaluation and local control CLI (R05, R06).
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
import { fileURLToPath } from "node:url";

import {
  parseEvalArgs,
  estimateCallCost,
  checkOutcomeMatch,
  executeChatCall,
  buildReportV1,
  runEvaluation,
  OPENROUTER_FALLBACK_RATES,
} from "../jev-evaluate.mjs";

import {
  parseControlArgs,
  executeControl,
} from "../jev-control.mjs";

import {
  evaluateReport,
  policyFingerprint,
  loadSkillCatalog,
} from "../jev-assist.mjs";

const FIXTURES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "jev");

// ---------------------------------------------------------------------------
// 1. Fixture Contract and Integrity (R05)
// ---------------------------------------------------------------------------

test("calibration.json contains >=12 cases with valid schema and safety canaries", () => {
  const filePath = join(FIXTURES_DIR, "calibration.json");
  assert.ok(existsSync(filePath), "calibration.json must exist");
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  assert.ok(Array.isArray(data), "calibration must be an array");
  assert.ok(data.length >= 12, `expected >=12 calibration cases, got ${data.length}`);

  const ids = new Set();
  let safetyCanaries = 0;
  for (const c of data) {
    assert.ok(c.id && typeof c.id === "string", "each case must have string id");
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.prompt && typeof c.prompt === "string", "must have prompt");
    assert.ok(Array.isArray(c.expectedSkills), "expectedSkills must be array");
    assert.strictEqual(typeof c.isSafetyCanary, "boolean", "isSafetyCanary must be boolean");
    if (c.isSafetyCanary) safetyCanaries++;
  }
  assert.ok(safetyCanaries >= 2, "calibration must contain at least 2 safety canaries");
});

test("heldout.json contains >=40 independently constructed RU/EN cases with safety canaries", () => {
  const filePath = join(FIXTURES_DIR, "heldout.json");
  assert.ok(existsSync(filePath), "heldout.json must exist");
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  assert.ok(Array.isArray(data), "heldout must be an array");
  assert.ok(data.length >= 40, `expected >=40 heldout cases, got ${data.length}`);

  const ids = new Set();
  let enCount = 0;
  let ruCount = 0;
  let safetyCanaries = 0;
  let noSkillCount = 0;

  for (const c of data) {
    assert.ok(c.id && typeof c.id === "string", "each case must have string id");
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.prompt && typeof c.prompt === "string", "must have prompt");
    assert.ok(Array.isArray(c.expectedSkills), "expectedSkills must be array");
    assert.strictEqual(typeof c.isSafetyCanary, "boolean", "isSafetyCanary must be boolean");

    if (c.lang === "en") enCount++;
    if (c.lang === "ru") ruCount++;
    if (c.isSafetyCanary) safetyCanaries++;
    if (!c.isSafetyCanary && c.expectedSkills.length === 0) noSkillCount++;
  }

  assert.ok(enCount >= 18, `expected >=18 EN cases, got ${enCount}`);
  assert.ok(ruCount >= 18, `expected >=18 RU cases, got ${ruCount}`);
  assert.ok(safetyCanaries >= 2, `expected >=2 safety canaries, got ${safetyCanaries}`);
  assert.ok(noSkillCount >= 6, `expected >=6 non-safety no-skill cases, got ${noSkillCount}`);
});

test("outcomes.json contains >=8 cases covering all 4 declared leaf archetypes", () => {
  const filePath = join(FIXTURES_DIR, "outcomes.json");
  assert.ok(existsSync(filePath), "outcomes.json must exist");
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  assert.ok(Array.isArray(data), "outcomes must be an array");
  assert.ok(data.length >= 8, `expected >=8 outcome cases, got ${data.length}`);

  const requiredArchetypes = new Set(["lookup", "json-transform", "formatting", "text-normalization"]);
  const seenArchetypes = new Set();

  for (const c of data) {
    assert.ok(c.id && typeof c.id === "string");
    assert.ok(c.archetype && typeof c.archetype === "string");
    assert.ok(c.prompt && typeof c.prompt === "string");
    if (!c.isSafetyCanary) {
      assert.ok(c.expected !== undefined, "non-safety outcomes must have expected output");
      assert.ok(["json", "text"].includes(c.expectedType), "expectedType must be json or text");
    }
    seenArchetypes.add(c.archetype);
  }

  for (const arch of requiredArchetypes) {
    assert.ok(seenArchetypes.has(arch), `missing required archetype ${arch} in outcomes`);
  }
});

test("zero overlap between calibration prompts and heldout prompts", () => {
  const calib = JSON.parse(readFileSync(join(FIXTURES_DIR, "calibration.json"), "utf8"));
  const heldout = JSON.parse(readFileSync(join(FIXTURES_DIR, "heldout.json"), "utf8"));

  const calibPrompts = new Set(calib.map((c) => c.prompt.trim().toLowerCase()));
  for (const h of heldout) {
    const norm = h.prompt.trim().toLowerCase();
    assert.ok(!calibPrompts.has(norm), `heldout prompt is identical to calibration prompt: ${h.prompt}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Pricing and Conservative Budget Reserve (R05)
// ---------------------------------------------------------------------------

test("OPENROUTER_FALLBACK_RATES matches parent observed catalog prices", () => {
  // Baseline: google/gemini-3.8-flash: $.75/M input, $3.75/M output
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.8-flash"].prompt, 0.00000075);
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.8-flash"].completion, 0.00000375);

  // Candidate: google/gemini-3.1-flash-lite: $.25/M input, $1.50/M output
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.1-flash-lite"].prompt, 0.00000025);
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.1-flash-lite"].completion, 0.0000015);
});

test("estimateCallCost accounts for promptBytes, max_tokens, and never defaults to 0", () => {
  const cost = estimateCallCost({
    model: "google/gemini-3.8-flash",
    promptBytes: 800,
    maxTokens: 1024,
  });

  assert.ok(Number.isFinite(cost), "cost must be finite");
  assert.ok(cost > 0, "cost must be strictly positive (no unknown-cost=0)");

  // With unknown model, fallback conservative rate must apply
  const unknownCost = estimateCallCost({
    model: "custom/unknown-model",
    promptBytes: 500,
    maxTokens: 1024,
  });
  assert.ok(unknownCost > 0, "unknown model must receive non-zero conservative rate");
});

// ---------------------------------------------------------------------------
// 3. Chat Completion & Usage Accounting (R05)
// ---------------------------------------------------------------------------

test("executeChatCall flags missing usage.cost as missing-usage-cost error, never fabricating 0", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "result" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }, // no cost field!
    }),
  });

  const res = await executeChatCall({
    apiKey: "test-key",
    model: "google/gemini-3.8-flash",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: mockFetch,
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.costUsd, null);
  assert.strictEqual(res.error, "missing-usage-cost");
});

test("executeChatCall flags finish_reason length as failure", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "partial content" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 1024, cost: 0.005 },
    }),
  });

  const res = await executeChatCall({
    apiKey: "test-key",
    model: "google/gemini-3.8-flash",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: mockFetch,
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "finish-reason-length");
});

test("executeChatCall passes valid response and measured cost", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "complete response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 25, cost: 0.00012 },
    }),
  });

  const res = await executeChatCall({
    apiKey: "test-key",
    model: "google/gemini-3.8-flash",
    messages: [{ role: "user", content: "test" }],
    fetchImpl: mockFetch,
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.content, "complete response");
  assert.strictEqual(res.costUsd, 0.00012);
});

// ---------------------------------------------------------------------------
// 4. Deterministic Outcome Matcher (R05)
// ---------------------------------------------------------------------------

test("checkOutcomeMatch validates JSON and normalized text strictly", () => {
  const jsonExpected = { code: 404, text: "Not Found" };
  assert.strictEqual(checkOutcomeMatch('{"code": 404, "text": "Not Found"}', jsonExpected, "json"), true);
  assert.strictEqual(checkOutcomeMatch('```json\n{"code": 404, "text": "Not Found"}\n```', jsonExpected, "json"), true);
  assert.strictEqual(checkOutcomeMatch('{"code": 500, "text": "Error"}', jsonExpected, "json"), false);

  assert.strictEqual(checkOutcomeMatch("  hello-world-2026-release  \n", "hello-world-2026-release", "text"), true);
  assert.strictEqual(checkOutcomeMatch("wrong-slug", "hello-world-2026-release", "text"), false);
});

// ---------------------------------------------------------------------------
// 5. Hurdle Validation and Refusal of Bad Proof (R06)
// ---------------------------------------------------------------------------

function makeSyntheticPassingReport() {
  const cases = [];
  // 12 calibration cases (>=12 separate from heldout)
  for (let i = 0; i < 12; i++) {
    cases.push({
      id: `calib-${i}`,
      isCalibration: true,
      isSafety: false,
      safetyMiss: false,
      expectedSkills: ["better-ui"],
      expectedSkill: "better-ui",
      baselineRequested: true,
      candidateRequested: true,
      baselineAttempted: true,
      baselineSkill: "better-ui",
      baselineCorrect: true,
      candidateAttempted: true,
      candidateSkill: "better-ui",
      candidateCorrect: true,
      skillConfidence: 0.95,
      criticalMiss: false,
      baselineCostUsd: 0.0005,
      candidateCostUsd: 0.0001,
    });
  }
  // 40 heldout eligible cases (>=40 total)
  for (let i = 0; i < 40; i++) {
    cases.push({
      id: `heldout-${i}`,
      isCalibration: false,
      isSafety: false,
      safetyMiss: false,
      expectedSkills: ["better-ui"],
      expectedSkill: "better-ui",
      baselineRequested: true,
      candidateRequested: true,
      baselineAttempted: true,
      baselineSkill: "better-ui",
      baselineCorrect: true,
      candidateAttempted: true,
      candidateSkill: "better-ui",
      candidateCorrect: true,
      skillConfidence: 0.95,
      criticalMiss: false,
      baselineCostUsd: 0.0005,
      candidateCostUsd: 0.0001,
    });
  }
  // 2 heldout safety cases
  for (let i = 0; i < 2; i++) {
    cases.push({
      id: `heldout-safety-${i}`,
      isCalibration: false,
      isSafety: true,
      safetyMiss: false,
      screened: true,
      expectedSkills: [],
      expectedSkill: "none",
      baselineRequested: false,
      candidateRequested: false,
      baselineAttempted: false,
      baselineSkill: null,
      baselineCorrect: false,
      candidateAttempted: false,
      candidateSkill: null,
      candidateCorrect: false,
      criticalMiss: false,
      baselineCostUsd: 0,
      candidateCostUsd: 0,
    });
  }

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
  // Corrupt multiple heldout skill cases to drop precision
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
    c.candidateCostUsd = 0.005; // 5x baseline
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

// ---------------------------------------------------------------------------
// 6. jev-control CLI Lifecycle (R06)
// ---------------------------------------------------------------------------

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

    // Test status command
    const statusRes = await executeControl({
      command: "status",
      home: tmpHome,
      root: ".",
    });
    assert.strictEqual(statusRes.success, true);
    assert.strictEqual(statusRes.policy?.enabled, true);

    // Test disable command
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

test("runEvaluation accepts --catalog snapshot metadata without reading bodies", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-eval-cat-"));
  try {
    const catalogPath = join(tmpHome, "catalog-snapshot.json");
    const snapshot = [
      { name: "better-ui", description: "Polish UI visual details" },
      { name: "docker-patterns", description: "Docker best practices" },
    ];
    writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2), "utf8");

    const expectedCatalog = loadSkillCatalog({ cwd: tmpHome, home: tmpHome, effectiveSkills: snapshot });

    const res = await runEvaluation({
      root: tmpHome,
      home: tmpHome,
      catalog: catalogPath,
      fixtureOnly: true,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.catalogFingerprint, expectedCatalog.fingerprint);
    assert.strictEqual(res.catalogSource, `snapshot (${catalogPath})`);
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

test("runEvaluation executes deterministic offline run with injected fetchImpl covering full outcomes flow", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-eval-offline-"));
  try {
    const catalogPath = join(tmpHome, "catalog-snapshot.json");
    const snapshot = [
      { name: "better-ui", description: "Polish UI visual details" },
      { name: "docker-patterns", description: "Docker patterns" },
      { name: "python-resilience", description: "Python resilience" },
      { name: "adversarial-code-review", description: "Security review" },
      { name: "better-typography", description: "Typography scale" },
    ];
    writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2), "utf8");

    const outputPath = join(tmpHome, "eval-report.json");

    const mockFetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "google/gemini-3.8-flash", pricing: { prompt: "0.00000075", completion: "0.00000375" } },
              { id: "google/gemini-3.1-flash-lite", pricing: { prompt: "0.00000025", completion: "0.0000015" } },
            ],
          }),
        };
      }

      if (urlStr.includes("/decisions")) {
        let reqBody = {};
        try {
          reqBody = typeof options.body === "string" ? JSON.parse(options.body) : {};
        } catch {}
        const criteria = reqBody.questions?.skill?.criteria || {};
        const availableSkills = Object.keys(criteria).filter((k) => k !== "none");
        const skillChoice = availableSkills.length > 0 ? (availableSkills.includes("better-ui") ? "better-ui" : availableSkills[0]) : "none";

        return {
          ok: true,
          json: async () => ({
            model: "typesafe/jev-1.13-20260917",
            answers: {
              skill: {
                choice: skillChoice,
                confidence: 0.98,
              },
              eligible: {
                noul: 0.96,
              },
              archetype: {
                choice: "lookup",
                confidence: 0.95,
              },
            },
            usage: {
              input_tokens: 200,
              output_tokens: 30,
              cost: 0.00001,
            },
          }),
        };
      }

      if (urlStr.includes("chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "better-ui",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 150,
              completion_tokens: 20,
              cost: 0.00005,
            },
          }),
        };
      }

      return { ok: false, status: 404 };
    };

    const evalOptions = {
      ...parseEvalArgs([]),
      root: tmpHome,
      home: tmpHome,
      catalog: catalogPath,
      output: outputPath,
      dryRun: false,
      apiKey: "mock-key",
      fetchImpl: mockFetch,
    };
    const res = await runEvaluation(evalOptions);

    assert.strictEqual(res.success, true);
    assert.ok(existsSync(outputPath), "checkpoint/report file must be written");

    const savedReport = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.strictEqual(savedReport.skills.cases.length, 58, "must collect exact full 58 skill cases");
    assert.strictEqual(savedReport.skills.total, 58);
    assert.strictEqual(savedReport.routing.cases.length, 10, "must collect exact full 10 outcome cases");
    assert.strictEqual(savedReport.routing.total, 10);

    const calibFixt = JSON.parse(readFileSync(join(FIXTURES_DIR, "calibration.json"), "utf8"));
    const heldFixt = JSON.parse(readFileSync(join(FIXTURES_DIR, "heldout.json"), "utf8"));
    const outFixt = JSON.parse(readFileSync(join(FIXTURES_DIR, "outcomes.json"), "utf8"));

    const skillIds = new Set(savedReport.skills.cases.map((c) => c.id));
    assert.strictEqual(skillIds.size, 58);
    for (const c of [...calibFixt, ...heldFixt]) {
      assert.ok(skillIds.has(c.id), `missing skill case ID: ${c.id}`);
    }

    const routingIds = new Set(savedReport.routing.cases.map((c) => c.id));
    assert.strictEqual(routingIds.size, 10);
    for (const t of outFixt) {
      assert.ok(routingIds.has(t.id), `missing outcome case ID: ${t.id}`);
    }

    assert.strictEqual(savedReport.errors, 0, "errors must be 0 on clean mocked run");
    assert.strictEqual(savedReport.completed, true, "completed must be true on successful run");
    assert.ok(
      savedReport.spendUsd > 0 && savedReport.spendUsd < 0.1,
      `spendUsd must be bounded actual receipts sum (got ${savedReport.spendUsd})`
    );
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("runEvaluation records provider network faults as errors and persists completed:false report with preserved receipts", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-eval-exc-"));
  try {
    const catalogPath = join(tmpHome, "catalog-snapshot.json");
    const snapshot = [
      { name: "better-ui", description: "Polish UI visual details" },
      { name: "docker-patterns", description: "Docker patterns" },
      { name: "python-resilience", description: "Python resilience" },
    ];
    writeFileSync(catalogPath, JSON.stringify(snapshot, null, 2), "utf8");

    const outputPath = join(tmpHome, "eval-report-exc.json");

    let callCount = 0;
    const failingFetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "google/gemini-3.8-flash", pricing: { prompt: "0.00000075", completion: "0.00000375" } },
              { id: "google/gemini-3.1-flash-lite", pricing: { prompt: "0.00000025", completion: "0.0000015" } },
            ],
          }),
        };
      }
      callCount++;
      if (callCount > 6) {
        throw new Error("Simulated network explosion mid-flight");
      }
      if (urlStr.includes("/decisions")) {
        let reqBody = {};
        try {
          reqBody = typeof options.body === "string" ? JSON.parse(options.body) : {};
        } catch {}
        const criteria = reqBody.questions?.skill?.criteria || {};
        const availableSkills = Object.keys(criteria).filter((k) => k !== "none");
        const skillChoice = availableSkills.length > 0 ? (availableSkills.includes("better-ui") ? "better-ui" : availableSkills[0]) : "none";

        return {
          ok: true,
          json: async () => ({
            model: "typesafe/jev-1.13-20260917",
            answers: {
              skill: { choice: skillChoice, confidence: 0.98 },
              eligible: { noul: 0.96 },
              archetype: { choice: "lookup", confidence: 0.95 },
            },
            usage: { input_tokens: 100, output_tokens: 20, cost: 0.00001 },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "better-ui" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00005 },
        }),
      };
    };

    const evalOptions = {
      ...parseEvalArgs([]),
      root: tmpHome,
      home: tmpHome,
      catalog: catalogPath,
      output: outputPath,
      dryRun: false,
      apiKey: "mock-key",
      fetchImpl: failingFetch,
    };

    const res = await runEvaluation(evalOptions);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.report.completed, false, "report must have completed: false on provider faults");
    assert.ok(res.report.errors >= 1, "report must record errors >= 1");
    assert.ok(res.report.unknownSpendUsd > 0, "unknown spend must be reserved for failed calls");

    assert.ok(existsSync(outputPath), "checkpoint file must be written");
    const savedReport = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.strictEqual(savedReport.completed, false);
    assert.ok(savedReport.errors >= 1);
    assert.strictEqual(savedReport.skills.cases.length, 58, "all 58 skill cases must be tracked");
    assert.strictEqual(savedReport.routing.cases.length, 10, "all 10 outcome cases must be tracked");

    const failedCases = savedReport.skills.cases.filter((c) => c.error !== null);
    assert.ok(failedCases.length > 0, "failed cases must record transport errors");
    const passedCases = savedReport.skills.cases.filter((c) => c.candidateCorrect === true || c.baselineCorrect === true);
    assert.ok(passedCases.length > 0, "prior known receipts before failure must be preserved");
    assert.ok(savedReport.spendUsd >= 0, "spendUsd must be recorded");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("parseEvalArgs and runEvaluation reject non-finite or negative maxCostUsd before network", async () => {
  // 1. parseEvalArgs rejects NaN / invalid strings
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "abc"]), /Invalid --max-cost-usd/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "-1"]), /Invalid --max-cost-usd/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "NaN"]), /Invalid --max-cost-usd/);

  // 2. runEvaluation rejects invalid maxCostUsd programmatic options before making any API call
  let called = false;
  const spyFetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };

  await assert.rejects(
    async () =>
      runEvaluation({
        maxCostUsd: NaN,
        fetchImpl: spyFetch,
      }),
    /invalid maxCostUsd/
  );
  assert.strictEqual(called, false, "must not execute any network request on invalid spend cap");
});

test("runEvaluation with --dry-run returns plan without emitting activation-eligible report or executing API calls", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "jev-eval-dry-"));
  try {
    let fetchCalled = false;
    const spyFetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    };

    const outputPath = join(tmpHome, "dry-report.json");
    const res = await runEvaluation({
      root: tmpHome,
      home: tmpHome,
      output: outputPath,
      dryRun: true,
      fetchImpl: spyFetch,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.dryRun, true);
    assert.ok(res.plan, "plan must be present");
    assert.strictEqual(res.plan.plannedCases > 0, true);
    assert.strictEqual(fetchCalled, false, "dryRun must perform zero API calls");
    assert.strictEqual(existsSync(outputPath), false, "dryRun must not write an activation-eligible evaluation report");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
