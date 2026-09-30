#!/usr/bin/env node
/**
 * tools/jev-evaluate.mjs
 * Paired empirical evaluation CLI for JEV automatic assistance (R05, R06).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  readCredential,
  loadSkillCatalog,
  screenTask,
  decide,
  policyFingerprint,
  evaluateReport,
} from "./jev-assist.mjs";

const DEFAULT_BASELINE = "google/gemini-3.8-flash";
const DEFAULT_CANDIDATE = "google/gemini-3.1-flash-lite";
const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";
const DEFAULT_MAX_COST_USD = 1.0;
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LEAF_ARCHETYPES = new Set(["lookup", "json-transform", "formatting", "text-normalization"]);

export const OPENROUTER_FALLBACK_RATES = {
  "google/gemini-3.8-flash": { prompt: 0.00000075, completion: 0.00000375 },
  "google/gemini-3.1-flash-lite": { prompt: 0.00000025, completion: 0.0000015 },
  "typesafe/jev-1.13": { prompt: 0.000000042, completion: 0.000000042 },
  default: { prompt: 0.00000075, completion: 0.00000375 },
};

export function parseEvalArgs(argv = process.argv.slice(2)) {
  const args = {
    root: process.cwd(),
    home: process.env.HOME || process.env.USERPROFILE || process.cwd(),
    baseline: DEFAULT_BASELINE,
    candidate: DEFAULT_CANDIDATE,
    decisionModel: DEFAULT_DECISION_MODEL,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    output: null,
    catalog: null,
    effectiveSkills: null,
    fixtureOnly: false,
    dryRun: false,
    interleave: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) args.root = resolve(argv[++i]);
    else if (a === "--home" && argv[i + 1]) args.home = resolve(argv[++i]);
    else if (a === "--baseline" && argv[i + 1]) args.baseline = argv[++i];
    else if (a === "--candidate" && argv[i + 1]) args.candidate = argv[++i];
    else if (a === "--decision-model" && argv[i + 1]) args.decisionModel = argv[++i];
    else if (a === "--max-cost-usd" && argv[i + 1]) {
      const val = argv[++i];
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --max-cost-usd: must be finite non-negative number, got '${val}'`);
      }
      args.maxCostUsd = parsed;
    }
    else if (a === "--output" && argv[i + 1]) args.output = resolve(argv[++i]);
    else if (a === "--catalog" && argv[i + 1]) args.catalog = resolve(argv[++i]);
    else if (a === "--fixture-only") args.fixtureOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-interleave") args.interleave = false;
  }

  if (!args.output) {
    args.output = join(args.home, ".omp", "agent", "jev-evaluation.json");
  }
  return args;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function fetchModelPricing(apiKey, fetchImpl = fetch) {
  const rates = { ...OPENROUTER_FALLBACK_RATES };
  const observed = new Set();
  try {
    const headers = { "User-Agent": "nullform-workflow/jev-evaluate" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const fetcher = fetchImpl || fetch;
    const res = await fetcher(OPENROUTER_MODELS_URL, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data)) {
        for (const item of data.data) {
          if (item?.id && item?.pricing) {
            const p = Number(item.pricing.prompt);
            const c = Number(item.pricing.completion);
            if (Number.isFinite(p) && Number.isFinite(c) && p >= 0 && c >= 0) {
              rates[item.id] = { prompt: p, completion: c };
              observed.add(item.id);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal for fixture runs; live runs enforce exact observed IDs
  }
  rates.__observed = observed;
  return rates;
}

export function estimateCallCost({
  model,
  promptBytes,
  promptTokens,
  maxTokens = 1024,
  ratesTable = OPENROUTER_FALLBACK_RATES,
}) {
  const bytes = promptBytes ?? promptTokens ?? 1000;
  const rates = ratesTable[model] || ratesTable.default;
  const pRate = rates.prompt > 0 ? rates.prompt : ratesTable.default.prompt;
  const cRate = rates.completion > 0 ? rates.completion : ratesTable.default.completion;
  // maxTokens includes reasoning; conservative prompt tokens from UTF8 bytes (>= 1 token / byte upper bound)
  return Math.max(0.00001, bytes * pRate + maxTokens * cRate);
}

export function checkOutcomeMatch(output, expected, expectedType) {
  if (typeof output !== "string") return false;
  const cleaned = output.trim();
  if (expectedType === "json") {
    let jsonStr = cleaned;
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    try {
      return deepEqual(JSON.parse(jsonStr), expected);
    } catch {
      return false;
    }
  }
  return cleaned.replace(/\r\n/g, "\n").trim() === String(expected).replace(/\r\n/g, "\n").trim();
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || !keysA.every((k, i) => k === keysB[i])) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
}

export async function executeChatCall({
  apiKey,
  model,
  messages,
  maxTokens = 1024,
  ratesTable = OPENROUTER_FALLBACK_RATES,
  fetchImpl = fetch,
}) {
  const start = Date.now();
  const body = {
    model,
    messages,
    max_tokens: Math.max(1024, maxTokens),
    reasoning: { effort: "low" },
  };

  try {
    const res = await fetchImpl(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "nullform-workflow/jev-evaluate",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        content: "",
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        latencyMs,
        error: `http-${res.status}`,
      };
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content || "";
    const finishReason = choice?.finish_reason;
    const usage = data?.usage || {};
    const inputTokens = Number(usage.prompt_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens) || 0;
    const reasoningTokens = Number(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) || 0;

    if (finishReason === "length") {
      return {
        ok: false,
        content,
        inputTokens,
        outputTokens,
        reasoningTokens,
        costUsd: null,
        latencyMs,
        error: "finish-reason-length",
      };
    }

    const rawCost = usage.cost;
    const costUsd = Number(rawCost);
    if (rawCost === undefined || rawCost === null || !Number.isFinite(costUsd) || costUsd < 0) {
      return {
        ok: false,
        content,
        inputTokens,
        outputTokens,
        reasoningTokens,
        costUsd: null,
        latencyMs,
        error: "missing-usage-cost",
      };
    }

    return {
      ok: true,
      content,
      inputTokens,
      outputTokens,
      reasoningTokens,
      costUsd,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      content: "",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - start,
      error: err?.name === "AbortError" ? "timeout" : "network-error",
    };
  }
}
function resolveExpectedSet(c) {
  const arr = Array.isArray(c.expectedSkills)
    ? c.expectedSkills
    : c.expectedSkill && c.expectedSkill !== "none"
      ? [c.expectedSkill]
      : [];
  return new Set(arr.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean));
}

function resolveAccepted(output, expected, expectedType, fallbackFlag) {
  return expected !== undefined && output !== undefined
    ? checkOutcomeMatch(output, expected, expectedType)
    : Boolean(fallbackFlag);
}
const isCalibCase = (c) => Boolean(
  c.isCalibration === true ||
  c.split === "calibration" ||
  (typeof c.id === "string" && c.id.startsWith("calib"))
);

export function buildReportV1({
  catalogFingerprint,
  catalogSource = "filesystem",
  baselineModel,
  candidateModel,
  decisionModel,
  datasetHashes,
  decisionSnapshots,
  calibrationCount = 0,
  heldoutCount = 0,
  skillCases,
  routingCases,
  maxCostUsd,
  totalSpend = 0,
  unknownSpend = 0,
  errors = 0,
  modelPrices = null,
}) {
  let skillBaselineCost = 0;
  let skillCandidateCost = 0;
  let skillBaselineAttempted = 0;
  let skillBaselineCorrect = 0;
  let skillBaselineFP = 0;
  let skillCandidateAttempted = 0;
  let skillCandidateCorrect = 0;
  let skillCandidateFP = 0;
  let skillCriticalMisses = 0;
  let skillSafetyTotal = 0;
  let skillSafetyMisses = 0;
  let skillEligible = 0;
  let allRawSpend = 0;

  for (const c of skillCases) {
    allRawSpend += (c.baselineCostUsd || 0) + (c.candidateCostUsd || 0);
    const isCalib = isCalibCase(c);
    const isSafety = Boolean(c.isSafety || c.kind === "safety");

    if (isSafety) {
      if (!isCalib) skillSafetyTotal++;
      if (c.safetyMiss || c.candidateAttempted || (c.candidateSkill && c.candidateSkill !== "none")) {
        if (!isCalib) skillSafetyMisses++;
      }
    } else {
      if (!isCalib) skillEligible++;
    }

    if (c.criticalMiss && !isCalib) skillCriticalMisses++;

    const expectedSet = resolveExpectedSet(c);
    const isExpectedNone = expectedSet.size === 0;

    const bAttempted = Boolean(c.baselineAttempted ?? (c.baselineSkill && c.baselineSkill !== "none"));
    if (bAttempted) {
      const bSkill = c.baselineSkill && c.baselineSkill !== "none" ? c.baselineSkill : null;
      const bCorrect = isExpectedNone ? bSkill === null : (bSkill !== null && expectedSet.has(bSkill));
      if (!isCalib) {
        skillBaselineAttempted++;
        if (bCorrect) skillBaselineCorrect++;
        else if (isExpectedNone) skillBaselineFP++;
      }
    }

    const cAttempted = Boolean(c.candidateAttempted ?? (c.candidateSkill !== undefined));
    if (cAttempted) {
      const cSkill = c.candidateSkill && c.candidateSkill !== "none" ? c.candidateSkill : null;
      const cCorrect = isExpectedNone ? cSkill === null : (cSkill !== null && expectedSet.has(cSkill));
      if (!isCalib) {
        skillCandidateAttempted++;
        if (cCorrect) skillCandidateCorrect++;
        else if (isExpectedNone) skillCandidateFP++;
      }
    }

    if (!isCalib) {
      skillBaselineCost += c.baselineCostUsd || 0;
      skillCandidateCost += c.candidateCostUsd || 0;
    }
  }

  let routingSafetyTotal = 0;
  let routingSafetyMisses = 0;
  let routingBaselinePrimary = 0;
  let routingCandidatePrimary = 0;
  let routingCandidateRecovery = 0;
  let routingBaselineCost = 0;
  let routingCandidateCost = 0;
  const routingArchetypes = new Set();

  for (const c of routingCases) {
    allRawSpend += (c.baselineCostUsd || 0) + (c.candidateCostUsd || 0);
    const isCalib = isCalibCase(c);

    if (c.isSafety) {
      if (!isCalib) routingSafetyTotal++;
      if (c.safetyMiss && !isCalib) routingSafetyMisses++;
    }
    if (c.archetype && LEAF_ARCHETYPES.has(c.archetype) && !isCalib) {
      routingArchetypes.add(c.archetype);
    }

    if (resolveAccepted(c.baselineOutput, c.expected, c.expectedType, c.baselineAccepted ?? c.baselineSuccess)) {
      if (!isCalib) routingBaselinePrimary++;
    }

    if (Boolean(c.candidatePrimaryAttempted) && resolveAccepted(c.candidatePrimaryOutput, c.expected, c.expectedType, c.candidatePrimaryAccepted)) {
      if (!isCalib) routingCandidatePrimary++;
    }
    if (c.recoveryAccepted && !isCalib) routingCandidateRecovery++;

    if (!isCalib) {
      routingBaselineCost += c.baselineCostUsd || 0;
      routingCandidateCost += c.candidateCostUsd || 0;
    }
  }

  const totalRequests =
    skillCases.reduce(
      (acc, c) =>
        acc +
        (Boolean(c.baselineRequested ?? c.baselineAttempted) ? 1 : 0) +
        (Boolean(c.candidateRequested ?? c.candidateAttempted) ? 1 : 0),
      0
    ) +
    routingCases.reduce(
      (acc, c) =>
        acc +
        (Boolean(c.baselineRequested ?? c.baselineAttempted) ? 1 : 0) +
        (Boolean(c.decisionRequested) ? 1 : 0) +
        (Boolean(c.candidateRequested ?? c.candidatePrimaryAttempted) ? 1 : 0) +
        (Boolean(c.recoveryRequested ?? c.recoveryAttempted) ? 1 : 0),
      0
    );

  const fp = policyFingerprint({ catalogFingerprint, candidateModel, baselineModel, decisionModel });
  const effectiveTotalSpend = totalSpend > 0 ? totalSpend : allRawSpend;
  const effectiveUnknownSpend = Number((unknownSpend || 0).toFixed(6));
  const effectiveSpendUsd = Number((effectiveTotalSpend + effectiveUnknownSpend).toFixed(6));

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    catalogFingerprint,
    catalogSource,
    baselineModel,
    candidateModel,
    decisionModel,
    fingerprint: fp,
    datasetHashes,
    decisionSnapshots: Array.from(new Set(decisionSnapshots)),
    modelPrices: modelPrices || undefined,
    calibration: { total: calibrationCount, hash: datasetHashes.calibration },
    heldout: { total: heldoutCount, hash: datasetHashes.heldout },
    skills: {
      total: skillCases.length,
      eligible: skillEligible,
      safetyTotal: skillSafetyTotal,
      safetyMisses: skillSafetyMisses,
      baseline: {
        attempted: skillBaselineAttempted,
        correct: skillBaselineCorrect,
        falsePositives: skillBaselineFP,
        costUsd: Number(skillBaselineCost.toFixed(6)),
      },
      candidate: {
        attempted: skillCandidateAttempted,
        correct: skillCandidateCorrect,
        falsePositives: skillCandidateFP,
        criticalMisses: skillCriticalMisses,
        costUsd: Number(skillCandidateCost.toFixed(6)),
      },
      cases: skillCases,
    },
    routing: {
      total: routingCases.length,
      safetyTotal: routingSafetyTotal,
      safetyMisses: routingSafetyMisses,
      archetypes: Array.from(routingArchetypes).sort(),
      baseline: {
        primaryAccepted: routingBaselinePrimary,
        costUsd: Number(routingBaselineCost.toFixed(6)),
      },
      candidate: {
        primaryAccepted: routingCandidatePrimary,
        recoveryAccepted: routingCandidateRecovery,
        costUsd: Number(routingCandidateCost.toFixed(6)),
      },
      cases: routingCases,
    },
    requests: totalRequests,
    errors,
    spendUsd: Number((totalSpend + unknownSpend).toFixed(6)),
    unknownSpendUsd: Number(unknownSpend.toFixed(6)),
    maxCostUsd,
    completed: errors === 0,
  };
}

export async function runEvaluation(optionsInput = parseEvalArgs()) {
  const defaults = parseEvalArgs([]);
  const options = Array.isArray(optionsInput)
    ? parseEvalArgs(optionsInput)
    : { ...defaults, ...(optionsInput || {}) };
  const root = options.root;
  const home = options.home;
  const maxCost = Number(options.maxCostUsd);
  if (!Number.isFinite(maxCost) || maxCost < 0) {
    throw new Error(`Evaluation aborted: invalid maxCostUsd '${options.maxCostUsd}' (must be finite non-negative number)`);
  }
  const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "tests", "fixtures", "jev");

  const calibPath = join(fixturesDir, "calibration.json");
  const heldoutPath = join(fixturesDir, "heldout.json");
  const outcomesPath = join(fixturesDir, "outcomes.json");

  if (!existsSync(calibPath) || !existsSync(heldoutPath) || !existsSync(outcomesPath)) {
    throw new Error(`Evaluation fixtures missing in ${fixturesDir}`);
  }

  const calibRaw = readFileSync(calibPath, "utf8");
  const heldoutRaw = readFileSync(heldoutPath, "utf8");
  const outcomesRaw = readFileSync(outcomesPath, "utf8");

  const datasetHashes = {
    calibration: sha256(calibRaw),
    heldout: sha256(heldoutRaw),
    outcomes: sha256(outcomesRaw),
  };

  const calibCases = JSON.parse(calibRaw);
  const heldoutCases = JSON.parse(heldoutRaw);
  const outcomeTasks = JSON.parse(outcomesRaw);

  let effectiveSkills = options.effectiveSkills || null;
  let catalogSource = "filesystem";
  if (!effectiveSkills && options.catalog) {
    if (!existsSync(options.catalog)) {
      throw new Error(`Catalog snapshot file not found at ${options.catalog}`);
    }
    try {
      const parsedCat = JSON.parse(readFileSync(options.catalog, "utf8"));
      effectiveSkills = Array.isArray(parsedCat) ? parsedCat : parsedCat?.skills;
      if (!Array.isArray(effectiveSkills)) {
        throw new Error(`Catalog snapshot at ${options.catalog} must be a JSON array or { skills: [...] }`);
      }
      catalogSource = `snapshot (${options.catalog})`;
    } catch (err) {
      throw new Error(`Failed to load catalog snapshot from ${options.catalog}: ${err.message}`);
    }
  }

  // Authoritative installed catalog: loads via effectiveSkills snapshot if provided, else falls back to filesystem
  const catalog = loadSkillCatalog({ cwd: root, home, effectiveSkills });

  if (options.fixtureOnly || options.dryRun) {
    console.log(`JEV Evaluation: ${options.dryRun ? "Dry run (plan only, zero API)" : "Fixtures verified successfully."}`);
    console.log(`- Calibration: ${calibCases.length}, Heldout: ${heldoutCases.length}, Outcomes: ${outcomeTasks.length}`);
    console.log(`- Catalog source: ${catalogSource}`);
    console.log(`- Catalog: ${catalog.skills.length} skills (fingerprint: ${catalog.fingerprint})`);
    return {
      success: true,
      dryRun: Boolean(options.dryRun),
      fixtureOnly: Boolean(options.fixtureOnly),
      datasetHashes,
      catalogFingerprint: catalog.fingerprint,
      catalogSource,
      plan: {
        baselineModel: options.baseline,
        candidateModel: options.candidate,
        decisionModel: options.decisionModel,
        maxCostUsd: options.maxCostUsd,
        plannedCases: calibCases.length + heldoutCases.length + outcomeTasks.length,
      },
    };
  }

  const apiKey = options.apiKey || (await readCredential());
  if (!apiKey && !options.dryRun) {
    throw new Error("Missing OpenRouter credential in environment (OPENROUTER_API_KEY) or native vault.");
  }
  const fetchImpl = options.fetchImpl || fetch;
  const ratesTable = await fetchModelPricing(apiKey, fetchImpl);
  if (!options.dryRun) {
    const observed = ratesTable.__observed;
    if (!observed?.has(options.baseline) || !observed?.has(options.candidate)) {
      throw new Error(`Evaluation aborted: exact catalog prices not observed for required models (${options.baseline}, ${options.candidate})`);
    }
  }

  let measuredSpend = 0;
  let unknownSpend = 0;
  let totalErrors = 0;
  const decisionSnapshots = [];
  const skillResultCases = [];
  const routingResultCases = [];

  const writeCheckpoint = (completed = false, failureReason = null) => {
    if (!options.output) return null;
    try {
      const interimReport = buildReportV1({
        catalogFingerprint: catalog.fingerprint,
        catalogSource,
        baselineModel: options.baseline,
        candidateModel: options.candidate,
        decisionModel: options.decisionModel,
        datasetHashes,
        decisionSnapshots,
        calibrationCount: calibCases.length,
        heldoutCount: heldoutCases.length,
        skillCases: skillResultCases,
        routingCases: routingResultCases,
        maxCostUsd: options.maxCostUsd,
        totalSpend: measuredSpend,
        unknownSpend,
        errors: completed ? totalErrors : Math.max(1, totalErrors),
        modelPrices: {
          [options.baseline]: {
            prompt: ratesTable[options.baseline]?.prompt ?? OPENROUTER_FALLBACK_RATES[options.baseline].prompt,
            completion: ratesTable[options.baseline]?.completion ?? OPENROUTER_FALLBACK_RATES[options.baseline].completion,
            observed: Boolean(ratesTable.__observed?.has(options.baseline)),
          },
          [options.candidate]: {
            prompt: ratesTable[options.candidate]?.prompt ?? OPENROUTER_FALLBACK_RATES[options.candidate].prompt,
            completion: ratesTable[options.candidate]?.completion ?? OPENROUTER_FALLBACK_RATES[options.candidate].completion,
            observed: Boolean(ratesTable.__observed?.has(options.candidate)),
          },
          [options.decisionModel]: {
            prompt: ratesTable[options.decisionModel]?.prompt ?? 0.000000042,
            completion: ratesTable[options.decisionModel]?.completion ?? 0.000000042,
            observed: false,
            source: "published-rate",
          },
        },
      });
      if (!completed) {
        interimReport.completed = false;
        if (failureReason) interimReport.interrupted = failureReason;
      }
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, JSON.stringify(interimReport, null, 2), "utf8");
      return interimReport;
    } catch {
      return null;
    }
  };

  const catalogSkillsList = catalog.skills
    .map((s) => `- ${s.name}: ${s.description || "General utility"}`)
    .join("\n");
  const allSkillCases = [...calibCases, ...heldoutCases];

  try {
    for (let idx = 0; idx < allSkillCases.length; idx++) {
      const c = allSkillCases[idx];
      const isInterleaved = options.interleave ? idx % 2 === 1 : false;
      const screen = screenTask(c.prompt);

      // Keep safety-canary inputs no-network before both arms and count safety denominators separately
      if (c.isSafetyCanary || !screen.allowed) {
        const safetyMiss = Boolean(c.isSafetyCanary && screen.allowed);
        skillResultCases.push({
          id: c.id,
          isSafety: true,
          safetyMiss,
          screened: !screen.allowed,
          expectedSkills: c.expectedSkills || [],
          expectedSkill: c.expectedSkills?.[0] || "none",
          baselineRequested: false,
          candidateRequested: false,
          baselineAttempted: false,
          baselineOutput: "",
          baselineSkill: null,
          baselineCorrect: false,
          candidateAttempted: false,
          candidateSkill: null,
          candidateCorrect: false,
          criticalMiss: safetyMiss,
          baselineCostUsd: 0,
          candidateCostUsd: 0,
          error: null,
        });
        writeCheckpoint(false);
        continue;
      }

      const baselineMessages = [
        {
          role: "system",
          content: `You are a skill router. Given the user task and the following list of available skills, identify the single most relevant skill name from the list, or reply 'none' if no skill applies.\n\nAvailable skills:\n${catalogSkillsList}`,
        },
        { role: "user", content: c.prompt },
      ];
      const bReserve = estimateCallCost({
        model: options.baseline,
        promptBytes: Buffer.byteLength(JSON.stringify(baselineMessages), "utf8"),
        maxTokens: 1024,
        ratesTable,
      });
      const cReserve = estimateCallCost({
        model: options.decisionModel,
        promptBytes: Buffer.byteLength(JSON.stringify({ task: c.prompt, skills: catalog.skills }), "utf8"),
        maxTokens: 256,
        ratesTable,
      });

      if (measuredSpend + unknownSpend + bReserve + cReserve > options.maxCostUsd) {
        throw new Error(`Evaluation aborted: pre-call reserve would exceed hard spend cap ($${options.maxCostUsd})`);
      }

      const runBaseline = () =>
        executeChatCall({ apiKey, model: options.baseline, messages: baselineMessages, maxTokens: 1024, ratesTable, fetchImpl });
      const runCandidate = () =>
        decide({ task: c.prompt, skills: catalog.skills, apiKey, model: options.decisionModel, fetchImpl });

      const [first, second] = isInterleaved
        ? await Promise.all([runCandidate(), runBaseline()])
        : await Promise.all([runBaseline(), runCandidate()]);
      const bRes = isInterleaved ? second : first;
      const cRes = isInterleaved ? first : second;

      let bCost = 0;
      if (!bRes.ok || bRes.costUsd === null) {
        totalErrors++;
        unknownSpend += bReserve;
      } else {
        bCost = bRes.costUsd;
        measuredSpend += bCost;
      }

      let cCost = 0;
      const rawCCost = cRes.usage?.costUsd;
      const cCostKnown = cRes.usage?.costKnown ?? true;
      if (cRes.status === "fallback") {
        totalErrors++;
      }
      if (!cCostKnown || rawCCost === undefined || rawCCost === null || !Number.isFinite(Number(rawCCost))) {
        if (cRes.status !== "fallback") totalErrors++;
        unknownSpend += cReserve;
      } else {
        cCost = Math.max(0, Number(rawCCost));
        measuredSpend += cCost;
      }

      let bSkill = "none";
      if (bRes.ok && bRes.content) {
        const match = catalog.skills.find((s) => new RegExp(`\\b${s.name}\\b`, "i").test(bRes.content));
        if (match) bSkill = match.name;
      }
      const expected = c.expectedSkills || [];
      const bCorrect = expected.length === 0 ? bSkill === "none" : expected.includes(bSkill);

      // Valid classifier response with skillConfidence >= 0.80 counts as valid attempt independent of nonnull skill
      const cAttempted = cRes.status === "ok" && typeof cRes.skillConfidence === "number" && cRes.skillConfidence >= 0.8;
      const cSkill = cRes.skill || "none";
      if (cRes.model) decisionSnapshots.push(cRes.model);
      const cCorrect = expected.length === 0 ? cSkill === "none" : expected.includes(cSkill);

      // Ordinary wrong skill is noncritical; criticalMiss only explicit safety-critical cases
      const isCritical = Boolean(c.isCritical && !cCorrect);

      skillResultCases.push({
        id: c.id,
        isSafety: false,
        safetyMiss: false,
        screened: false,
        expectedSkills: expected,
        expectedSkill: expected[0] || "none",
        baselineRequested: true,
        candidateRequested: true,
        baselineAttempted: bRes.ok,
        baselineOutput: bRes.content || "",
        baselineSkill: bSkill,
        baselineCorrect: bCorrect,
        baselineCostUsd: bCost,
        candidateAttempted: cAttempted,
        candidateSkill: cSkill,
        candidateCorrect: cCorrect,
        candidateCostUsd: cCost,
        criticalMiss: isCritical,
        error: bRes.error || (cRes.status !== "ok" ? cRes.reason : null),
      });
      writeCheckpoint(false);
    }

    for (let idx = 0; idx < outcomeTasks.length; idx++) {
      const t = outcomeTasks[idx];
      const screen = screenTask(t.prompt);

      if (t.isSafetyCanary || !screen.allowed) {
        const safetyMiss = Boolean(t.isSafetyCanary && screen.allowed);
        routingResultCases.push({
          id: t.id,
          archetype: t.archetype,
          isSafety: true,
          safetyMiss,
          screened: !screen.allowed,
          expected: t.expected,
          expectedType: t.expectedType,
          baselineRequested: false,
          decisionRequested: false,
          candidateRequested: false,
          recoveryRequested: false,
          baselineAttempted: false,
          baselineOutput: "",
          baselineAccepted: false,
          baselineCostUsd: 0,
          jevStatus: null,
          jevRoute: null,
          jevArchetype: null,
          candidatePrimaryAttempted: false,
          candidatePrimaryOutput: null,
          candidatePrimaryAccepted: false,
          recoveryAttempted: false,
          recoveryOutput: null,
          recoveryAccepted: false,
          candidateCostUsd: 0,
          error: null,
        });
        writeCheckpoint(false);
        continue;
      }

      const outcomeMessages = [{ role: "user", content: t.prompt }];
      const bReserve = estimateCallCost({
        model: options.baseline,
        promptBytes: Buffer.byteLength(JSON.stringify(outcomeMessages), "utf8"),
        maxTokens: 1024,
        ratesTable,
      });
      const jevReserve = estimateCallCost({
        model: options.decisionModel,
        promptBytes: Buffer.byteLength(JSON.stringify({ task: t.prompt, skills: [] }), "utf8"),
        maxTokens: 256,
        ratesTable,
      });
      const cReserve = estimateCallCost({
        model: options.candidate,
        promptBytes: Buffer.byteLength(JSON.stringify(outcomeMessages), "utf8"),
        maxTokens: 1024,
        ratesTable,
      });

      if (measuredSpend + unknownSpend + bReserve + jevReserve + cReserve > options.maxCostUsd) {
        throw new Error(`Evaluation aborted: pre-call reserve would exceed hard spend cap ($${options.maxCostUsd})`);
      }

      // Baseline outcome arm
      const bCall = await executeChatCall({ apiKey, model: options.baseline, messages: outcomeMessages, maxTokens: 1024, ratesTable, fetchImpl });
      let bCost = 0;
      if (!bCall.ok || bCall.costUsd === null) {
        totalErrors++;
        unknownSpend += bReserve;
      } else {
        bCost = bCall.costUsd;
        measuredSpend += bCost;
      }
      const bAccepted = bCall.ok && checkOutcomeMatch(bCall.content, t.expected, t.expectedType);

      // Candidate arm: JEV decide first
      const jevDecide = await decide({ task: t.prompt, skills: [], apiKey, model: options.decisionModel, fetchImpl });
      if (jevDecide.model) decisionSnapshots.push(jevDecide.model);
      let jevCost = 0;
      const rawJevCost = jevDecide.usage?.costUsd;
      const jevCostKnown = Boolean(jevDecide.usage?.costKnown);
      if (jevDecide.status === "fallback") {
        totalErrors++;
      }
      if (!jevCostKnown || rawJevCost === undefined || rawJevCost === null || !Number.isFinite(Number(rawJevCost))) {
        if (jevDecide.status !== "fallback") totalErrors++;
        unknownSpend += jevReserve;
      } else {
        jevCost = Math.max(0, Number(rawJevCost));
        measuredSpend += jevCost;
      }

      // Execute cheap only when actual JEV route/archetype passes, otherwise independent baseline recovery
      const isCheapEligible = jevDecide.status === "ok" &&
        jevDecide.route === "cheap" &&
        LEAF_ARCHETYPES.has(jevDecide.archetype) &&
        (jevDecide.eligibleScore === undefined || jevDecide.eligibleScore >= 0.7);
      let candidatePrimaryAttempted = false;
      let candidatePrimaryOutput = null;
      let candidatePrimaryAccepted = false;
      let recoveryAttempted = false;
      let recoveryOutput = null;
      let recoveryAccepted = false;
      let cheapCost = 0;
      let fallbackCost = 0;

      const runRecovery = async () => {
        const fCall = await executeChatCall({ apiKey, model: options.baseline, messages: outcomeMessages, maxTokens: 1024, ratesTable, fetchImpl });
        recoveryAttempted = true;
        recoveryOutput = fCall.content || "";
        if (!fCall.ok || fCall.costUsd === null) {
          totalErrors++;
          unknownSpend += bReserve;
        } else {
          fallbackCost = fCall.costUsd;
          measuredSpend += fallbackCost;
        }
        recoveryAccepted = fCall.ok && checkOutcomeMatch(fCall.content, t.expected, t.expectedType);
      };

      if (isCheapEligible) {
        const cCall = await executeChatCall({ apiKey, model: options.candidate, messages: outcomeMessages, maxTokens: 1024, ratesTable, fetchImpl });
        candidatePrimaryAttempted = true;
        candidatePrimaryOutput = cCall.content || "";
        if (!cCall.ok || cCall.costUsd === null) {
          totalErrors++;
          unknownSpend += cReserve;
        } else {
          cheapCost = cCall.costUsd;
          measuredSpend += cheapCost;
        }
        candidatePrimaryAccepted = cCall.ok && checkOutcomeMatch(cCall.content, t.expected, t.expectedType);
        if (!candidatePrimaryAccepted) await runRecovery();
      } else {
        await runRecovery();
      }
      const candidateTotalCost = jevCost + cheapCost + fallbackCost;

      routingResultCases.push({
        id: t.id,
        archetype: t.archetype,
        isSafety: false,
        safetyMiss: false,
        screened: false,
        expected: t.expected,
        expectedType: t.expectedType,
        baselineRequested: true,
        decisionRequested: true,
        candidateRequested: isCheapEligible,
        recoveryRequested: recoveryAttempted,
        baselineAttempted: bCall.ok,
        baselineOutput: bCall.content || "",
        baselineAccepted: bAccepted,
        baselineCostUsd: bCost,
        jevStatus: jevDecide.status,
        jevRoute: jevDecide.route,
        jevArchetype: jevDecide.archetype,
        candidatePrimaryAttempted,
        candidatePrimaryOutput,
        candidatePrimaryAccepted,
        recoveryAttempted,
        recoveryOutput,
        recoveryAccepted,
        candidateCostUsd: candidateTotalCost,
        error: bCall.error || null,
      });
      writeCheckpoint(false);
    }
  } catch (err) {
    totalErrors++;
    writeCheckpoint(false, "execution-interrupted");
    throw err;
  }

  const report = writeCheckpoint(true);
  const hurdleEval = evaluateReport(report);

  console.log("=== JEV Paired Evaluation Report ===");
  console.log(`Report written to: ${options.output}`);
  console.log(`Fingerprint: ${report.fingerprint}`);
  console.log(`Total Spend: $${report.spendUsd.toFixed(6)} / $${report.maxCostUsd}`);
  console.log(`Skill Hurdles: ${hurdleEval.skillPassed ? "PASSED" : "FAILED"}`);
  console.log(`Routing Hurdles: ${hurdleEval.routingPassed ? "PASSED" : "FAILED"}`);
  console.log(`Eligible Archetypes: ${hurdleEval.archetypes.join(", ") || "none"}`);

  return { success: true, report, hurdles: hurdleEval };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runEvaluation().catch((err) => {
    console.error(`Evaluation failed: ${err.message}`);
    process.exit(1);
  });
}
