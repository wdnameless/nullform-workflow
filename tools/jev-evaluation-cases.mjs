/**
 * tools/jev-evaluation-cases.mjs
 * Paid case execution helpers for JEV paired empirical evaluation (R05).
 * Skills-only: baseline chat model vs JEV typed classifier.
 */

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { screenTask, decide } from "./jev-assist.mjs";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export const OPENROUTER_FALLBACK_RATES = {
  "google/gemini-3.8-flash": { prompt: 0.00000075, completion: 0.00000375 },
  "typesafe/jev-1.13": { prompt: 0.000000042, completion: 0.000000042 },
  default: { prompt: 0.00000075, completion: 0.00000375 },
};

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
  return Math.max(0.00001, bytes * pRate + maxTokens * cRate);
}

export async function executeChatCall({
  apiKey,
  model,
  messages,
  maxTokens = 1024,
  ratesTable = OPENROUTER_FALLBACK_RATES,
  fetchImpl = fetch,
}) {
  const start = performance.now();
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

    const latencyMs = Math.round(Math.max(0, performance.now() - start));
    if (!res.ok) {
      return { ok: false, content: "", inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs, error: `http-${res.status}` };
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content || "";
    if (choice?.finish_reason === "length") {
      return { ok: false, content, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs, error: "finish-reason-length" };
    }

    const usage = data?.usage || {};
    const rawCost = usage.cost;
    const costUsd = Number(rawCost);
    if (rawCost === undefined || rawCost === null || !Number.isFinite(costUsd) || costUsd < 0) {
      return { ok: false, content, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs, error: "missing-usage-cost" };
    }

    return {
      ok: true,
      content,
      inputTokens: Number(usage.prompt_tokens) || 0,
      outputTokens: Number(usage.completion_tokens) || 0,
      costUsd,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      content: "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      latencyMs: Math.round(Math.max(0, performance.now() - start)),
      error: err?.name === "AbortError" ? "timeout" : "network-error",
    };
  }
}

export function buildScreenedSkillResult(c, safetyMiss, screened) {
  const exp = c.expectedSkills || (c.expectedSkill && c.expectedSkill !== "none" ? [c.expectedSkill] : []);
  return {
    caseRecord: {
      id: c.id,
      isSafety: true,
      safetyMiss,
      screened,
      expectedSkills: exp,
      expectedSkill: exp[0] || "none",
      baselineRequested: false,
      candidateRequested: false,
      baselineAttempted: false,
      baselineOutput: "",
      baselineSkill: null,
      baselineCorrect: false,
      candidateAttempted: false,
      candidateSkill: null,
      candidateCorrect: false,
      confidence: null,
      criticalMiss: safetyMiss,
      baselineCostUsd: 0,
      baselineLatencyMs: 0,
      candidateCostUsd: 0,
      candidateLatencyMs: 0,
      error: null,
    },
    measuredDelta: 0,
    unknownDelta: 0,
    errorsDelta: 0,
    decisionModel: null,
  };
}

export async function executeSkillCase({
  c,
  idx,
  options,
  apiKey,
  catalog,
  ratesTable = OPENROUTER_FALLBACK_RATES,
  fetchImpl = fetch,
  catalogSkillsList,
  measuredSpend,
  unknownSpend,
}) {
  const isInterleaved = options.interleave ? idx % 2 === 1 : false;
  const screen = screenTask(c.prompt);

  if (c.isSafetyCanary || !screen.allowed) {
    return buildScreenedSkillResult(c, Boolean(c.isSafetyCanary && screen.allowed), !screen.allowed);
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

  const runBaseline = () => executeChatCall({ apiKey, model: options.baseline, messages: baselineMessages, maxTokens: 1024, ratesTable, fetchImpl });
  const runCandidate = async () => {
    const start = performance.now();
    const res = await decide({ task: c.prompt, skills: catalog.skills, apiKey, model: options.decisionModel, fetchImpl });
    const latencyMs = Math.round(Math.max(0, performance.now() - start));
    return { ...res, latencyMs };
  };
  const [first, second] = isInterleaved
    ? await Promise.all([runCandidate(), runBaseline()])
    : await Promise.all([runBaseline(), runCandidate()]);
  const bRes = isInterleaved ? second : first;
  const cRes = isInterleaved ? first : second;

  let bCost = 0;
  let measuredDelta = 0;
  let unknownDelta = 0;
  let errorsDelta = 0;

  if (!bRes.ok || bRes.costUsd === null) {
    errorsDelta++;
    unknownDelta += bReserve;
  } else {
    bCost = bRes.costUsd;
    measuredDelta += bCost;
  }

  let cCost = 0;
  const rawCCost = cRes.usage?.costUsd;
  const cCostKnown = cRes.usage?.costKnown ?? true;
  if (cRes.status === "fallback") errorsDelta++;
  if (!cCostKnown || rawCCost === undefined || rawCCost === null || !Number.isFinite(Number(rawCCost))) {
    if (cRes.status !== "fallback") errorsDelta++;
    unknownDelta += cReserve;
  } else {
    cCost = Math.max(0, Number(rawCCost));
    measuredDelta += cCost;
  }

  let bSkill = "none";
  if (bRes.ok && bRes.content) {
    const match = catalog.skills.find((s) => new RegExp(`\\b${s.name}\\b`, "i").test(bRes.content));
    if (match) bSkill = match.name;
  }
  const expected = Array.isArray(c.expectedSkills) ? c.expectedSkills : (c.expectedSkill && c.expectedSkill !== "none" ? [c.expectedSkill] : []);
  const bCorrect = expected.length === 0 ? bSkill === "none" : expected.includes(bSkill);

  const confidence = typeof cRes.confidence === "number" ? cRes.confidence : (typeof cRes.skillConfidence === "number" ? cRes.skillConfidence : null);
  const cAttempted = cRes.status === "ok" && typeof confidence === "number" && confidence >= 0.8;
  const cSkill = (cRes.skill && cRes.skill !== "none") ? cRes.skill : "none";
  const cCorrect = expected.length === 0 ? cSkill === "none" : expected.includes(cSkill);
  const isCritical = Boolean(c.isCritical && !cCorrect);

  return {
    caseRecord: {
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
      baselineLatencyMs: bRes.latencyMs ?? 0,
      candidateAttempted: cAttempted,
      candidateSkill: cSkill,
      candidateCorrect: cCorrect,
      confidence,
      candidateCostUsd: cCost,
      candidateLatencyMs: cRes.latencyMs ?? 0,
      criticalMiss: isCritical,
      error: bRes.error || (cRes.status !== "ok" ? cRes.reason : null),
    },
    measuredDelta,
    unknownDelta,
    errorsDelta,
    decisionModel: cRes.model || null,
  };
}
