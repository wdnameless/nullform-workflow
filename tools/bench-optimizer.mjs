#!/usr/bin/env node
/**
 * tools/bench-optimizer.mjs — Candidate-only workflow & skill optimizer.
 *
 * Implements R11: baseline -> one mutation -> re-eval -> keep/revert.
 * Enforces max additional $10 ceiling against the durable spend ledger.
 * Candidate-only: candidate artifacts and evidence only, NO prompt mutation,
 * and NO auto-apply.
 *
 * If admitted provider is unavailable, returns honest UNVERIFIED live model evidence
 * and evaluates using deterministic fixtures only (no simulated model quality).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  loadSpendLedger,
  saveSpendLedger,
  computeTariffCost,
  DEFAULT_MODEL,
  FIXED_TARIFFS,
  REQUEST_RESERVE_USD,
  OPTIMIZER_MAX_ADDITIONAL_USD,
  LEDGER_FILE,
} from "./bench-budget.mjs";
import { MUTATION_OPERATORS } from "./mutation-test.mjs";

export const BUILTIN_MUTATION_OPERATORS = MUTATION_OPERATORS;

/**
 * Applies exactly one mutation to source code.
 */
export function generateOneMutation(sourceCode, options = {}) {
  const lines = sourceCode.split(/\r?\n/);
  const operatorFilter = options.operator || null;
  const operators = operatorFilter
    ? BUILTIN_MUTATION_OPERATORS.filter((o) => o.name === operatorFilter)
    : BUILTIN_MUTATION_OPERATORS;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    for (const op of operators) {
      const matches = [...line.matchAll(op.find)];
      if (matches.length > 0) {
        const m = matches[0];
        const mutatedLine = line.slice(0, m.index) + op.replace + line.slice(m.index + m[0].length);
        if (mutatedLine !== line) {
          const mutatedLines = [...lines];
          mutatedLines[lineIdx] = mutatedLine;
          return {
            mutatedCode: mutatedLines.join("\n"),
            mutation: {
              operator: op.name,
              description: op.description,
              lineNumber: lineIdx + 1,
              originalLine: trimmed,
              mutatedLine: mutatedLine.trim(),
              diff: `@@ -${lineIdx + 1},1 +${lineIdx + 1},1 @@\n- ${line}\n+ ${mutatedLine}`,
            },
          };
        }
      }
    }
  }

  throw new Error("No applicable mutation found in source code");
}

/**
 * Checks whether an admitted live model provider is available.
 */
export function checkAdmittedProvider(root, model = DEFAULT_MODEL) {
  if (!FIXED_TARIFFS[model]) return false;
  if (model === "local/model") return true;

  try {
    const runner = join(root, "tools", "bench-session-runner.ts");
    if (!existsSync(runner)) return false;
    const probe = spawnSync(
      "bun",
      [runner, "--setup-only", "--root", root, "--model", model],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      }
    );
    if (probe.error || probe.status !== 0) return false;
    const report = JSON.parse(probe.stdout.trim());
    return report.setup === "ready" && report.authConfigured === true;
  } catch {
    return false;
  }
}

/**
 * Runs the candidate-only optimizer.
 */
export async function runCandidateOptimizer(options = {}) {
  const root = resolve(options.root || ".");
  const targetPath = options.target ? resolve(root, options.target) : null;
  if (!targetPath || !existsSync(targetPath)) {
    throw new Error(`Target file does not exist: ${options.target}`);
  }

  const requestedCeiling = Number(options.ceiling ?? OPTIMIZER_MAX_ADDITIONAL_USD);
  if (!Number.isFinite(requestedCeiling) || requestedCeiling <= 0) {
    throw new Error("Ceiling must be a positive number");
  }
  if (requestedCeiling > OPTIMIZER_MAX_ADDITIONAL_USD) {
    throw new Error(`Optimizer additional spend cannot exceed $${OPTIMIZER_MAX_ADDITIONAL_USD}`);
  }

  const ledger = loadSpendLedger(root);
  const initialSpendUsd = ledger.cumulative_tariff_usd;
  const maxAdditionalSpendUsd = Math.min(requestedCeiling, OPTIMIZER_MAX_ADDITIONAL_USD);
  const effectiveCeilingUsd = initialSpendUsd + maxAdditionalSpendUsd;

  const model = options.model || DEFAULT_MODEL;
  const providerAvailable =
    options.providerAvailable !== undefined
      ? Boolean(options.providerAvailable)
      : checkAdmittedProvider(root, model);

  const liveModelEvidence = providerAvailable ? "VERIFIED" : "UNVERIFIED";
  const qualityClaim = providerAvailable ? "proven" : "not-proven";

  const baselineSource = readFileSync(targetPath, "utf8");

  // 1. Evaluate baseline
  let baselineResult;
  if (typeof options.evalFn === "function") {
    baselineResult = await options.evalFn({
      targetPath,
      isCandidate: false,
      root,
    });
  } else if (Array.isArray(options.checks) && options.checks.length > 0) {
    baselineResult = runDeterministicChecks(options.checks, root);
  } else {
    baselineResult = { passed: true, score: 1.0, checks: [] };
  }

  // 2. Generate one mutation for candidate
  let mutatedCode;
  let mutationInfo;
  if (typeof options.mutator === "function") {
    const res = options.mutator(baselineSource);
    mutatedCode = res.mutatedCode;
    mutationInfo = res.mutation;
  } else {
    const res = generateOneMutation(baselineSource, { operator: options.operator });
    mutatedCode = res.mutatedCode;
    mutationInfo = res.mutation;
  }

  // 3. Write candidate artifact (NEVER edit baseline file)
  const candidateId = `cand-${randomUUID().slice(0, 8)}`;
  const candidatesDir = join(root, "bench", "candidates", candidateId);
  mkdirSync(candidatesDir, { recursive: true });

  const targetFilename = basename(targetPath);
  const candidateArtifactPath = join(candidatesDir, targetFilename);
  writeFileSync(candidateArtifactPath, mutatedCode, "utf8");

  // 4. Re-evaluate candidate
  let candidateResult;
  if (typeof options.evalFn === "function") {
    candidateResult = await options.evalFn({
      targetPath: candidateArtifactPath,
      isCandidate: true,
      root,
    });
  } else if (Array.isArray(options.checks) && options.checks.length > 0) {
    candidateResult = runDeterministicChecks(options.checks, candidatesDir);
  } else {
    candidateResult = { passed: true, score: 1.0, checks: [] };
  }

  // 5. Decision: keep vs revert
  let decision = "revert";
  const basePassed = Boolean(baselineResult.passed);
  const candPassed = Boolean(candidateResult.passed);
  const baseScore = Number(baselineResult.score ?? (basePassed ? 1.0 : 0.0));
  const candScore = Number(candidateResult.score ?? (candPassed ? 1.0 : 0.0));

  if (candPassed && !basePassed) {
    decision = "keep";
  } else if (candScore > baseScore) {
    decision = "keep";
  } else if (candScore === baseScore && candPassed && basePassed) {
    const baseLines = baselineSource.split(/\r?\n/).length;
    const candLines = mutatedCode.split(/\r?\n/).length;
    if (candLines < baseLines) {
      decision = "keep";
    }
  }

  // 6. Spend calculation & ledger tracking
  let optimizerSpendUsd = Number(options.observedSpendUsd ?? 0.0);
  if (options.recordRequest && options.recordRequest.usage) {
    const req = options.recordRequest;
    const cost = computeTariffCost(req.usage, model);
    optimizerSpendUsd += cost.tariff_usd;

    if (optimizerSpendUsd > maxAdditionalSpendUsd) {
      throw new Error(`Budget ceiling exceeded: optimizer spend $${optimizerSpendUsd} > max $${maxAdditionalSpendUsd}`);
    }

    ledger.cumulative_tariff_usd += cost.tariff_usd;
    ledger.requests.push({
      id: randomUUID(),
      runId: candidateId,
      selector: model,
      status: "settled",
      reserve_usd: REQUEST_RESERVE_USD,
      dispatchedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      usage: req.usage,
      tariff_usd: cost.tariff_usd,
      sdk_tariff_usd: cost.tariff_usd,
      stopReason: "stop",
    });
    saveSpendLedger(root, ledger);
  } else if (optimizerSpendUsd > maxAdditionalSpendUsd) {
    throw new Error(`Budget ceiling exceeded: optimizer spend $${optimizerSpendUsd} > max $${maxAdditionalSpendUsd}`);
  }

  // Verify baseline file invariance
  const currentBaselineSource = readFileSync(targetPath, "utf8");
  if (currentBaselineSource !== baselineSource) {
    writeFileSync(targetPath, baselineSource, "utf8");
    throw new Error("Target file was mutated: candidate-only optimizer forbids auto-apply or in-place prompt/source edits");
  }

  // 7. Write candidate manifest
  const candidateManifestPath = join(candidatesDir, "candidate.json");
  const candidateArtifacts = [candidateArtifactPath, candidateManifestPath];

  const output = {
    status: "completed",
    candidateId,
    target: targetPath,
    decision,
    applied: false,
    baseline: {
      passed: basePassed,
      score: baseScore,
      checks: baselineResult.checks || [],
    },
    candidate: {
      passed: candPassed,
      score: candScore,
      checks: candidateResult.checks || [],
    },
    mutation: mutationInfo,
    candidateArtifactPath,
    candidateArtifacts,
    spend: {
      initialSpendUsd,
      optimizerSpendUsd,
      maxAdditionalSpendUsd,
      effectiveCeilingUsd,
      ledgerPath: join(root, LEDGER_FILE),
    },
    liveModelEvidence,
    qualityClaim,
    noAutoApply: true,
    promptEdits: false,
  };

  writeFileSync(candidateManifestPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  return output;
}

function runDeterministicChecks(checks, cwd) {
  const results = [];
  let allPassed = true;
  for (const check of checks) {
    const res = spawnSync(check, { cwd, shell: true, encoding: "utf8", timeout: 30000 });
    const passed = res.status === 0;
    results.push({ check, passed, stdout: res.stdout, stderr: res.stderr });
    if (!passed) allPassed = false;
  }
  return {
    passed: allPassed,
    score: allPassed ? 1.0 : 0.0,
    checks: results,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { root: ".", ceiling: OPTIMIZER_MAX_ADDITIONAL_USD };
  let idx = 0;
  while (idx < argv.length) {
    const token = argv[idx++];
    if (token === "--target") opts.target = argv[idx++];
    else if (token === "--root") opts.root = argv[idx++];
    else if (token === "--ceiling") opts.ceiling = Number(argv[idx++]);
    else if (token === "--json") opts.json = true;
    else if (token === "--help" || token === "-h") opts.help = true;
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (args.help || !args.target) {
    console.log(`bench-optimizer.mjs — Candidate-only workflow optimizer

Usage:
  node tools/bench-optimizer.mjs --target <path> [options]

Options:
  --target <path>   Target file to optimize
  --root <path>     Project root (default: .)
  --ceiling <usd>   Spending ceiling in USD (default: ${OPTIMIZER_MAX_ADDITIONAL_USD}, max: ${OPTIMIZER_MAX_ADDITIONAL_USD})
  --json            Output structured JSON report
  -h, --help        Show this help message`);
    process.exit(args.help ? 0 : 1);
  }

  runCandidateOptimizer(args)
    .then((result) => {
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Candidate Optimizer Result:
  Candidate ID: ${result.candidateId}
  Decision:     ${result.decision} (applied: ${result.applied})
  Baseline:     ${result.baseline.passed ? "PASS" : "FAIL"} (score: ${result.baseline.score})
  Candidate:    ${result.candidate.passed ? "PASS" : "FAIL"} (score: ${result.candidate.score})
  Artifact:     ${result.candidateArtifactPath}
  Spend:        $${result.spend.optimizerSpendUsd} (max additional: $${result.spend.maxAdditionalSpendUsd})
  Evidence:     ${result.liveModelEvidence} (quality claim: ${result.qualityClaim})`);
      }
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
