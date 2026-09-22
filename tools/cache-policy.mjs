#!/usr/bin/env node
/**
 * cache-policy.mjs — safe, advisory policy checks for neural prompt cache observability.
 *
 * Requirements:
 *   - check --root <path> [--policy <file>] [--return-contract <file>] [--json]
 *   - Safe gates ONLY:
 *     * HARD fail: prompt-lint scan fails (volatile literals detected)
 *     * HARD fail: fingerprint repeated twice differs (non-deterministic prompt surfaces)
 *     * HARD fail: supplied return-contract file fails validation
 *     * Advisory warning only: model count, context usage, output length thresholds
 *     * Explicitly prints: 'quality-sensitive settings are advisory; no model/context changes performed'
 *     * NEVER writes to model config, never compacts or truncates context, never switches models
 *
 * Zero dependencies. Node 18+ / Bun.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectFingerprint } from "./prompt-lint.mjs";
import { validateReturnContract } from "./return-contract.mjs";

const ADVISORY_NOTICE = "quality-sensitive settings are advisory; no model/context changes performed";

const DEFAULT_POLICY = {
  version: 1,
  maxModelsPerTask: 2,
  compactionThreshold: 0.78,
  maxInlineToolOutputLines: 80,
  maxInlineSubagentResultLines: 25,
  requireStableToolOrder: true,
  dynamicContextPlacement: "tail",
};

function parseArgs(argv) {
  const out = { _: [], root: null, policy: null, returnContract: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a === "--policy") {
      out.policy = argv[++i];
    } else if (a === "--return-contract") {
      out.returnContract = argv[++i];
    } else if (a === "--json") {
      out.json = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function loadPolicy(root, policyPath) {
  const candidatePaths = [];
  if (policyPath) {
    candidatePaths.push(policyPath);
  }
  if (root) {
    candidatePaths.push(join(root, ".workflow", "cache-policy.json"));
    candidatePaths.push(join(root, ".workflow", "cache-policy.example.json"));
  }
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        return { policy: { ...DEFAULT_POLICY, ...data }, source: p };
      } catch {
        // fallback to default
      }
    }
  }
  return { policy: { ...DEFAULT_POLICY }, source: "defaults" };
}

export function runCachePolicyCheck({ root, policyPath, returnContractPath }) {
  const targetRoot = root || process.cwd();
  const { policy, source: policySource } = loadPolicy(targetRoot, policyPath);

  const errors = [];
  const warnings = [];

  // Gate 1: Check prompt surfaces for volatile literals (equivalent to prompt-lint scan)
  const promptLintPath = join(targetRoot, "tools", "prompt-lint.mjs");
  if (existsSync(promptLintPath)) {
    const res = spawnSync("node", [promptLintPath, "scan", "--root", targetRoot], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0) {
      errors.push("Gate 1 failed: prompt-lint scan detected volatile literals in prompt surfaces");
    }
  }

  // Gate 2: Check fingerprint determinism (run fingerprint twice and ensure exact match)
  const fp1 = collectFingerprint(targetRoot);
  const fp2 = collectFingerprint(targetRoot);
  const fp1Str = JSON.stringify(fp1);
  const fp2Str = JSON.stringify(fp2);

  if (fp1Str !== fp2Str || fp1.compositeSha !== fp2.compositeSha) {
    errors.push("Gate 2 failed: prompt surface fingerprint is non-deterministic between consecutive runs");
  }

  // Gate 3: If return-contract path supplied, validate it
  let contractResult = null;
  if (returnContractPath) {
    if (!existsSync(returnContractPath)) {
      errors.push(`Gate 3 failed: return contract file not found: ${returnContractPath}`);
    } else {
      const contractText = readFileSync(returnContractPath, "utf8");
      contractResult = validateReturnContract(contractText);
      if (!contractResult.valid) {
        errors.push(`Gate 3 failed: return contract invalid: ${contractResult.errors.join("; ")}`);
      }
    }
  }

  // Advisory checks (threshold checks from policy)
  // For example: advisory notes about configured thresholds
  warnings.push(`Advisory threshold: maxModelsPerTask is configured to ${policy.maxModelsPerTask}`);
  warnings.push(`Advisory threshold: compactionThreshold is configured to ${policy.compactionThreshold}`);
  warnings.push(`Advisory threshold: maxInlineToolOutputLines is configured to ${policy.maxInlineToolOutputLines}`);
  warnings.push(`Advisory threshold: maxInlineSubagentResultLines is configured to ${policy.maxInlineSubagentResultLines}`);

  const passed = errors.length === 0;

  return {
    passed,
    policySource,
    notice: ADVISORY_NOTICE,
    compositeSha: fp1.compositeSha,
    errors,
    warnings,
    contractResult,
  };
}

/* ----------------------------------------------------------------------- main */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("cache-policy.mjs");

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd !== "check") {
    console.log("cache-policy.mjs — safe, advisory policy checks for prompt cache observability\n");
    console.log("  node cache-policy.mjs check --root <harness> [--policy <file>] [--return-contract <file>] [--json]\n");
    process.exit(0);
  }

  const result = runCachePolicyCheck({
    root: args.root,
    policyPath: args.policy,
    returnContractPath: args.returnContract,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`cache-policy: ${result.notice}\n`);
    console.log(`Policy loaded from: ${result.policySource}`);
    console.log(`Fingerprint composite SHA: ${result.compositeSha}`);

    if (result.warnings.length > 0) {
      console.log("\nAdvisory checks:");
      for (const w of result.warnings) {
        console.log(`  [ADVISORY] ${w}`);
      }
    }

    if (!result.passed) {
      console.error("\nHARD GATES FAILED:");
      for (const err of result.errors) {
        console.error(`  [FAIL] ${err}`);
      }
      process.exit(1);
    } else {
      console.log("\nAll hard safety gates PASSED.");
      process.exit(0);
    }
  }
}
