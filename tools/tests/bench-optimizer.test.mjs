import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runCandidateOptimizer, generateOneMutation } from "../bench-optimizer.mjs";
import { loadSpendLedger, saveSpendLedger, computeTariffCost, REQUEST_RESERVE_USD, DEFAULT_MODEL, OPTIMIZER_MAX_ADDITIONAL_USD } from "../bench-budget.mjs";

function createSandbox(prefix = "bench-optimizer-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("OPTIMIZER_MAX_ADDITIONAL_USD is capped at 10.0", () => {
  assert.equal(OPTIMIZER_MAX_ADDITIONAL_USD, 10.0);
});

test("generateOneMutation applies exactly one mutation to source code", () => {
  const source = "export function add(a, b) {\n  return a + b;\n}\n";
  const { mutatedCode, mutation } = generateOneMutation(source);
  assert.ok(mutation);
  assert.ok(mutation.operator);
  assert.equal(mutation.lineNumber, 2);
  assert.equal(mutation.originalLine, "return a + b;");
  assert.equal(mutation.mutatedLine, "return a - b;");
  assert.equal(mutatedCode, "export function add(a, b) {\n  return a - b;\n}\n");
});

test("optimizer: baseline -> one mutation -> reeval -> keep when candidate improves", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "calc.mjs");
    // Baseline has a bug: `return a - b;` instead of `+`
    const baselineSource = "export function add(a, b) {\n  return a - b;\n}\n";
    writeFileSync(targetFile, baselineSource, "utf8");

    // Custom deterministic eval: check whether add(2, 3) === 5
    const evalFn = async ({ targetPath }) => {
      const code = readFileSync(targetPath, "utf8");
      // Simple parse/eval test without loading dynamic imports
      const passed = code.includes("return a + b;");
      return {
        passed,
        score: passed ? 1.0 : 0.0,
        checks: [{ name: "adds-numbers", passed }],
      };
    };

    // Mutator that changes `-` to `+`
    const mutator = (code) => {
      const mutated = code.replace("return a - b;", "return a + b;");
      return {
        mutatedCode: mutated,
        mutation: {
          operator: "arithmetic-fix",
          description: "- to +",
          lineNumber: 2,
          originalLine: "return a - b;",
          mutatedLine: "return a + b;",
          diff: "-  return a - b;\n+  return a + b;",
        },
      };
    };

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      evalFn,
      mutator,
    });

    assert.equal(result.decision, "keep");
    assert.equal(result.applied, false);
    assert.equal(result.baseline.passed, false);
    assert.equal(result.candidate.passed, true);
    assert.equal(result.baseline.score, 0.0);
    assert.equal(result.candidate.score, 1.0);
    assert.ok(result.candidateArtifactPath);
    assert.ok(existsSync(result.candidateArtifactPath));
    assert.equal(readFileSync(result.candidateArtifactPath, "utf8"), "export function add(a, b) {\n  return a + b;\n}\n");

    // CRITICAL: Original target file was NEVER auto-applied or edited in place!
    assert.equal(readFileSync(targetFile, "utf8"), baselineSource);
  } finally {
    cleanup();
  }
});

test("optimizer: baseline -> one mutation -> reeval -> revert when candidate regresses", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "calc.mjs");
    // Baseline is correct: `return a + b;`
    const baselineSource = "export function add(a, b) {\n  return a + b;\n}\n";
    writeFileSync(targetFile, baselineSource, "utf8");

    const evalFn = async ({ targetPath }) => {
      const code = readFileSync(targetPath, "utf8");
      const passed = code.includes("return a + b;");
      return {
        passed,
        score: passed ? 1.0 : 0.0,
        checks: [{ name: "adds-numbers", passed }],
      };
    };

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      evalFn,
      // Default mutator will turn + to -
    });

    assert.equal(result.decision, "revert");
    assert.equal(result.applied, false);
    assert.equal(result.baseline.passed, true);
    assert.equal(result.candidate.passed, false);
    assert.ok(result.candidateArtifactPath);
    assert.ok(existsSync(result.candidateArtifactPath));

    // Original target file remains untouched
    assert.equal(readFileSync(targetFile, "utf8"), baselineSource);
  } finally {
    cleanup();
  }
});

test("optimizer: enforces max $10 additional spend ceiling and updates ledger", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const ledgerDir = join(dir, "bench", "runs");
    mkdirSync(ledgerDir, { recursive: true });
    const usage = { input: 2000, output: 400, cacheRead: 0, cacheWrite: 0 };
    const singleCost = computeTariffCost(usage, DEFAULT_MODEL).tariff_usd;
    const requests = [
      {
        id: "req-0001",
        runId: "run-init",
        selector: DEFAULT_MODEL,
        status: "settled",
        reserve_usd: REQUEST_RESERVE_USD,
        dispatchedAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-01T00:00:01.000Z",
        usage,
        sdk_tariff_usd: singleCost,
        tariff_usd: singleCost,
      },
    ];
    const initialLedger = {
      version: 2,
      ceiling_usd: 50.0,
      cumulative_tariff_usd: singleCost,
      status: "ok",
      requests,
    };
    saveSpendLedger(dir, initialLedger);

    const targetFile = join(dir, "calc.mjs");
    writeFileSync(targetFile, "export function add(a, b) { return a + b; }\n");

    // Test rejection of ceiling exceeding $10 additional
    await assert.rejects(
      async () => {
        await runCandidateOptimizer({
          root: dir,
          target: targetFile,
          ceiling: 15.0, // exceeds $10 additional limit
          evalFn: () => ({ passed: true, score: 1.0, checks: [] }),
        });
      },
      /exceed.*10/i
    );

    // Valid run within $10 ceiling
    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      ceiling: 10.0,
      evalFn: () => ({ passed: true, score: 1.0, checks: [] }),
    });

    assert.equal(result.spend.maxAdditionalSpendUsd, 10.0);
    assert.ok(result.spend.optimizerSpendUsd <= 10.0);
    assert.equal(result.spend.initialSpendUsd, singleCost);

    const updatedLedger = loadSpendLedger(dir);
    assert.ok(updatedLedger.cumulative_tariff_usd <= singleCost + 10.0);
  } finally {
    cleanup();
  }
});

test("optimizer: unavailable provider returns UNVERIFIED live model evidence and not-proven quality", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "calc.mjs");
    writeFileSync(targetFile, "export function add(a, b) { return a + b; }\n");

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      providerAvailable: false, // Explicitly simulate unavailable admitted provider
      evalFn: () => ({ passed: true, score: 1.0, checks: [] }),
    });

    assert.equal(result.liveModelEvidence, "UNVERIFIED");
    assert.equal(result.qualityClaim, "not-proven");
    assert.equal(result.applied, false);
    assert.ok(result.candidateArtifactPath);
  } finally {
    cleanup();
  }
});

test("optimizer: candidate artifacts are written and ledger records metadata", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "calc.mjs");
    writeFileSync(targetFile, "export function add(a, b) { return a - b; }\n");

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      evalFn: ({ targetPath }) => {
        const passed = readFileSync(targetPath, "utf8").includes("+");
        return { passed, score: passed ? 1.0 : 0.0, checks: [{ name: "test", passed }] };
      },
      mutator: (code) => ({
        mutatedCode: code.replace("-", "+"),
        mutation: { operator: "fix", description: "fix minus", lineNumber: 1, originalLine: "-", mutatedLine: "+", diff: "" },
      }),
    });

    assert.ok(result.candidateArtifactPath);
    assert.ok(existsSync(result.candidateArtifactPath));

    // Check candidate manifest artifact exists
    const candidateManifest = join(dir, "bench", "candidates", result.candidateId, "candidate.json");
    assert.ok(existsSync(candidateManifest));
    const manifestData = JSON.parse(readFileSync(candidateManifest, "utf8"));
    assert.equal(manifestData.candidateId, result.candidateId);
    assert.equal(manifestData.decision, "keep");
    assert.equal(manifestData.applied, false);
  } finally {
    cleanup();
  }
});
test("optimizer: prompt surfaces (e.g. SKILL.md) are NEVER edited in place (candidate-only)", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const skillDir = join(dir, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    const originalSkillText = "---\nname: test-skill\ndescription: demo skill\n---\n# Test Skill\nAlways return true;\n";
    writeFileSync(skillFile, originalSkillText, "utf8");

    const result = await runCandidateOptimizer({
      root: dir,
      target: skillFile,
      operator: "boolean-true",
      evalFn: () => ({ passed: true, score: 1.0, checks: [] }),
    });

    assert.equal(result.applied, false);
    assert.equal(result.promptEdits, false);
    assert.equal(result.noAutoApply, true);
    // Original SKILL.md remains strictly identical!
    assert.equal(readFileSync(skillFile, "utf8"), originalSkillText);
    // Candidate artifact was created in bench/candidates/
    assert.ok(result.candidateArtifactPath.includes("bench"));
    assert.ok(result.candidateArtifactPath.includes("candidates"));
    assert.equal(readFileSync(result.candidateArtifactPath, "utf8").includes("return false;"), true);
  } finally {
    cleanup();
  }
});

test("optimizer: deterministic checks run shell verification without network", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "math.js");
    writeFileSync(targetFile, "function check() { return 1 + 2; }\n");

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      checks: [`node -e "process.exit(0);"`],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.baseline.passed, true);
    assert.equal(result.candidate.passed, true);
  } finally {
    cleanup();
  }
});

test("optimizer: ledger updates accurately when recordRequest is supplied", async () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "target.js");
    writeFileSync(targetFile, "const flag = true;\n");

    const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };
    const expectedCost = computeTariffCost(usage, DEFAULT_MODEL).tariff_usd;

    const result = await runCandidateOptimizer({
      root: dir,
      target: targetFile,
      recordRequest: { usage },
      evalFn: () => ({ passed: true, score: 1.0, checks: [] }),
    });

    assert.ok(result.spend.optimizerSpendUsd > 0);
    assert.equal(result.spend.optimizerSpendUsd, expectedCost);

    const ledger = loadSpendLedger(dir);
    assert.equal(ledger.cumulative_tariff_usd, expectedCost);
    assert.equal(ledger.requests.length, 1);
    assert.equal(ledger.requests[0].status, "settled");
    assert.equal(ledger.requests[0].tariff_usd, expectedCost);
  } finally {
    cleanup();
  }
});

test("optimizer CLI: --help exits 0 with usage report", () => {
  const cliPath = fileURLToPath(new URL("../bench-optimizer.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Candidate-only workflow optimizer/i);
  assert.match(res.stdout, /--ceiling/);
});

test("optimizer CLI: --target and --json executes and emits valid JSON", () => {
  const { dir, cleanup } = createSandbox();
  try {
    const targetFile = join(dir, "cli-test.js");
    writeFileSync(targetFile, "const val = 1 + 2;\n");
    const cliPath = fileURLToPath(new URL("../bench-optimizer.mjs", import.meta.url));

    const res = spawnSync(
      process.execPath,
      [cliPath, "--root", dir, "--target", targetFile, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    const data = JSON.parse(res.stdout);
    assert.equal(data.status, "completed");
    assert.equal(data.applied, false);
    assert.ok(data.candidateId);
    assert.ok(data.candidateArtifactPath);
    assert.equal(data.liveModelEvidence, "UNVERIFIED");
    assert.equal(data.qualityClaim, "not-proven");
  } finally {
    cleanup();
  }
});
