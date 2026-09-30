/**
 * tools/tests/jev-evaluate.test.mjs
 * Behavioral and contract tests for JEV paired empirical evaluation runner (R05).
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
  executeChatCall,
  runEvaluation,
  OPENROUTER_FALLBACK_RATES,
} from "../jev-evaluate.mjs";
import { checkOutcomeMatch } from "../jev-evidence.mjs";
import { loadSkillCatalog } from "../jev-assist.mjs";

const FIXTURES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "jev");

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

test("OPENROUTER_FALLBACK_RATES matches parent observed catalog prices", () => {
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.8-flash"].prompt, 0.00000075);
  assert.strictEqual(OPENROUTER_FALLBACK_RATES["google/gemini-3.8-flash"].completion, 0.00000375);
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

  const unknownCost = estimateCallCost({
    model: "custom/unknown-model",
    promptBytes: 500,
    maxTokens: 1024,
  });
  assert.ok(unknownCost > 0, "unknown model must receive non-zero conservative rate");
});

test("executeChatCall flags missing usage.cost as missing-usage-cost error, never fabricating 0", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "result" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
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

test("checkOutcomeMatch validates JSON and normalized text strictly", () => {
  const jsonExpected = { code: 404, text: "Not Found" };
  assert.strictEqual(checkOutcomeMatch('{"code": 404, "text": "Not Found"}', jsonExpected, "json"), true);
  assert.strictEqual(checkOutcomeMatch('```json\n{"code": 404, "text": "Not Found"}\n```', jsonExpected, "json"), true);
  assert.strictEqual(checkOutcomeMatch('{"code": 500, "text": "Error"}', jsonExpected, "json"), false);

  assert.strictEqual(checkOutcomeMatch("  hello-world-2026-release  \n", "hello-world-2026-release", "text"), true);
  assert.strictEqual(checkOutcomeMatch("wrong-slug", "hello-world-2026-release", "text"), false);
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

function createMockEvaluationFetch({ maxCallsBeforeFail = Infinity } = {}) {
  let callCount = 0;
  return async (url, options = {}) => {
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
    if (callCount > maxCallsBeforeFail) {
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
}

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
    const mockFetch = createMockEvaluationFetch();

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
    const failingFetch = createMockEvaluationFetch({ maxCallsBeforeFail: 6 });

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
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "abc"]), /Invalid --max-cost-usd/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "-1"]), /Invalid --max-cost-usd/);
  assert.throws(() => parseEvalArgs(["--max-cost-usd", "NaN"]), /Invalid --max-cost-usd/);

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
