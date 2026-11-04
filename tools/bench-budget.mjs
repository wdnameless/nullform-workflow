import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_PROGRAM_CEILING_USD = 50.0;
export const DEFAULT_MODEL = "nullform-gateway/gemini-3.8-flash-high";
export const CAPS = Object.freeze({ contextBytes: 49152, inputTokens: 51200, outputTokens: 4096, workflowRequests: 6 });

export const ROLE_TO_CATEGORY = Object.freeze({
  oracle: "strict",
  reviewer: "strict",
  orchestrator: "strict",
  fixer: "builder",
  designer: "builder",
  explorer: "scout",
  scout: "scout",
  sonic: "scout",
  librarian: "scout",
});

export const CATEGORY_TARIFFS = Object.freeze({
  strict: Object.freeze({ input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 }),
  builder: Object.freeze({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 }),
  scout: Object.freeze({ input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 }),
});

export const ROLE_TARIFFS = Object.freeze(
  Object.fromEntries(
    Object.entries(ROLE_TO_CATEGORY).map(([role, cat]) => [role, CATEGORY_TARIFFS[cat]])
  )
);

export const FIXED_TARIFFS = Object.freeze({
  ...Object.fromEntries(["3.8", "3.7"].map(v => [`nullform-gateway/gemini-${v}-flash-high`, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 }])),
  "anthropic/claude-3-5-sonnet": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "openai/gpt-4o": { input: 2.50, output: 10.00, cacheRead: 1.25, cacheWrite: 0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 },
  "nullform-gateway/gemini-2.0-flash": { input: 0.10, output: 0.40, cacheRead: 0.025, cacheWrite: 0 },
  "local/model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

export const LEDGER_FILE = "bench/runs/spend-ledger.json";
export const REQUEST_RESERVE_USD = (CAPS.inputTokens * 0.75 + CAPS.outputTokens * 3.75) / 1e6;

export function resolveTariff(selector) {
  if (FIXED_TARIFFS[selector]) return FIXED_TARIFFS[selector];
  if (CATEGORY_TARIFFS[selector]) return CATEGORY_TARIFFS[selector];
  if (ROLE_TARIFFS[selector]) return ROLE_TARIFFS[selector];
  return null;
}
export function computeTariffCost(usage, selector) {
  const tariff = resolveTariff(selector);
  if (!tariff) throw new Error("Unknown fixed SDK tariff/model");
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) throw new Error(`Invalid native ${key} counter`);
  }
  if ((usage.cacheWrite !== 0 && !tariff.cacheWrite) || usage.orchestration !== undefined || usage.server !== undefined || usage.credits !== undefined || usage.premiumRequests !== undefined) throw new Error("Unsupported billed token bucket");
  return { tariff_usd: (usage.input * tariff.input + usage.output * tariff.output + usage.cacheRead * tariff.cacheRead + (usage.cacheWrite || 0) * (tariff.cacheWrite || 0)) / 1e6 };
}

export function validateAdmissionPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Invalid admission policy: expected an object");
  }
  const ceiling = Number(policy.ceiling_usd ?? policy.ceilingUsd ?? DEFAULT_PROGRAM_CEILING_USD);
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > DEFAULT_PROGRAM_CEILING_USD) {
    throw new Error(`Admission policy ceiling must be positive and <= $${DEFAULT_PROGRAM_CEILING_USD}`);
  }
  const category = policy.category ? String(policy.category) : null;
  if (category && !CATEGORY_TARIFFS[category]) {
    throw new Error(`Unknown admission category "${category}". Allowed: strict, builder, scout`);
  }
  const role = policy.role ? String(policy.role) : null;
  if (role && !ROLE_TO_CATEGORY[role]) {
    throw new Error(`Unknown admission role "${role}"`);
  }
  const resolvedCategory = category || (role ? ROLE_TO_CATEGORY[role] : "builder");
  const resolvedRole = role || (resolvedCategory === "strict" ? "oracle" : resolvedCategory === "scout" ? "scout" : "fixer");
  return {
    ceiling_usd: ceiling,
    category: resolvedCategory,
    role: resolvedRole,
    selector: policy.selector || policy.model || DEFAULT_MODEL,
    tariff: resolveTariff(resolvedCategory),
    maxRequests: Number(policy.maxRequests ?? policy.max_requests ?? CAPS.workflowRequests),
  };
}

export function validateNativeMessage(message, selector) {
  if (!message || `${message.provider}/${message.model}` !== selector) throw new Error("Exact native model/provider mismatch");
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp <= 0 || message.role !== "assistant" || !Array.isArray(message.content)) throw new Error("Malformed native assistant message");
  if (!["stop", "toolUse", "length", "error", "aborted"].includes(message.stopReason)) throw new Error("Unknown native stop reason");
  const cost = computeTariffCost(message.usage, selector);
  if (!Number.isSafeInteger(message.usage.totalTokens) || message.usage.totalTokens !== message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite) throw new Error("Invalid native totalTokens counter");
  if (message.usage.input + message.usage.cacheRead > CAPS.inputTokens || message.usage.output > CAPS.outputTokens) throw new Error("Native usage exceeded reserved caps");
  const sdkCost = message.usage.cost?.total;
  if (typeof sdkCost !== "number" || !Number.isFinite(sdkCost) || sdkCost < 0 || Math.abs(sdkCost - cost.tariff_usd) > 1e-8) throw new Error("Unknown/inconsistent SDK tariff cost");
  const tariff = FIXED_TARIFFS[selector];
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const nativeCost = message.usage.cost[key];
    if (typeof nativeCost !== "number" || !Number.isFinite(nativeCost) || nativeCost < 0 || Math.abs(nativeCost - message.usage[key] * tariff[key] / 1e6) > 1e-8) throw new Error("Malformed native tariff bucket");
  }
  return cost;
}

export function loadSpendLedger(root) {
  const path = join(root, LEDGER_FILE);
  const ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 2, ceiling_usd: DEFAULT_PROGRAM_CEILING_USD, cumulative_tariff_usd: 0, status: "ok", requests: [] };
  if (ledger.version !== 2 || !Array.isArray(ledger.requests) || !["ok", "blocked_unknown_spend"].includes(ledger.status) || !Number.isFinite(ledger.cumulative_tariff_usd) || ledger.cumulative_tariff_usd < 0 || !Number.isFinite(ledger.ceiling_usd) || ledger.ceiling_usd <= 0 || ledger.ceiling_usd > DEFAULT_PROGRAM_CEILING_USD) throw new Error("Malformed/legacy spend ledger; do not reset prior spending");
  if (ledger.requests.some(r => !r || typeof r.id !== "string" || typeof r.runId !== "string" || !resolveTariff(r.selector) || !["reserved", "settled"].includes(r.status) || r.reserve_usd !== REQUEST_RESERVE_USD) || new Set(ledger.requests.map(r => r.id)).size !== ledger.requests.length) throw new Error("Malformed durable request identity/reservation");
  for (const row of ledger.requests.filter(r => r.status === "settled")) {
    const cost = computeTariffCost(row.usage, row.selector).tariff_usd;
    if (typeof row.sdk_tariff_usd !== "number" || !Number.isFinite(row.sdk_tariff_usd) || Math.abs(cost - row.sdk_tariff_usd) > 1e-8 || Math.abs(cost - row.tariff_usd) > 1e-8) throw new Error("Invalid settled SDK tariff provenance");
  }
  const settled = ledger.requests.filter(r => r.status === "settled");
  if (settled.some(r => !Number.isFinite(r.tariff_usd) || r.tariff_usd < 0) || Math.abs(settled.reduce((n,r) => n + r.tariff_usd, 0) - ledger.cumulative_tariff_usd) > 1e-9) throw new Error("Inconsistent spend ledger");
  return ledger;
}

export function getSpendSummary(root) {
  const ledger = loadSpendLedger(root);
  return {
    cumulative_tariff_usd: ledger.cumulative_tariff_usd,
    ceiling_usd: ledger.ceiling_usd,
    status: ledger.status,
    total_requests: ledger.requests.length,
    settled_requests: ledger.requests.filter(r => r.status === "settled").length,
  };
}

export function saveSpendLedger(root, ledger) {
  const path = join(root, LEDGER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx");
  try { writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform !== "win32") { const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
}

function changeLedger(root, fn) {
  const path = join(root, LEDGER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const fd = openSync(lock, "wx");
  try { const ledger = loadSpendLedger(root); const result = fn(ledger); saveSpendLedger(root, ledger); return result; }
  finally { closeSync(fd); unlinkSync(lock); }
}

export function assertBudgetReady(ledger) {
  if (ledger.status !== "ok" || ledger.requests.some(r => r.status !== "settled")) throw new Error("Budget blocked by unknown/unsettled spend; audit retained requests before further calls");
}

/** Consumer-side StreamFn + physical fetch boundary. Hidden HTTP retries cannot dispatch while usage is unresolved. */
export function createRequestBudget({ root, selector, endpoint, wireModel, runId, maxRequests = 1, ceiling = 1, fetchImpl }) {
  if (!FIXED_TARIFFS[selector] || !Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > CAPS.workflowRequests) throw new Error("Invalid budget configuration");
  const url = new URL(endpoint);
  let active = false, pending = null, requests = 0;
  const begin = () => {
    if (active) throw new Error("Concurrent/auxiliary model request forbidden");
    assertBudgetReady(loadSpendLedger(root));
    if (requests >= maxRequests) throw new Error("Request count cap reached");
    active = true;
  };
  const guardedFetch = async (input, init = {}) => {
    if (!active || pending) throw new Error("Unreserved side call/retry forbidden");
    const request = input instanceof Request ? input : null;
    const target = new URL(request?.url ?? String(input));
    const method = init.method ?? request?.method ?? "GET";
    const body = init.body ?? (request ? await request.clone().text() : undefined);
    if (target.origin !== url.origin || target.pathname !== url.pathname || typeof method !== "string" || method.toUpperCase() !== "POST" || typeof body !== "string" || Buffer.byteLength(body) > CAPS.contextBytes) throw new Error("Unknown/unbounded inference transport");
    const payload = JSON.parse(body);
    const caps = [payload.max_tokens, payload.max_completion_tokens].filter(v => v !== undefined);
    if (payload.model !== wireModel || !caps.length || caps.some(v => !Number.isSafeInteger(v) || v <= 0 || v > CAPS.outputTokens) || payload.n !== undefined && payload.n !== 1) throw new Error("Missing/wrong wire model or output cap");
    if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.some(t => t.type !== "function"))) throw new Error("Unbounded server-side tools forbidden");
    const id = randomUUID();
    changeLedger(root, ledger => {
      assertBudgetReady(ledger);
      ledger.ceiling_usd = Math.min(ledger.ceiling_usd, ceiling);
      if (ledger.cumulative_tariff_usd + REQUEST_RESERVE_USD > ledger.ceiling_usd + 1e-12) throw new Error("Budget ceiling reached before dispatch");
      ledger.requests.push({ id, runId, selector, status: "reserved", reserve_usd: REQUEST_RESERVE_USD, dispatchedAt: new Date().toISOString(), bodyBytes: Buffer.byteLength(body) });
    });
    pending = id; requests++;
    return fetchImpl(input, { ...init, redirect: "error" });
  };
  const settle = message => {
    if (!active || !pending) throw new Error("No durable dispatched request for native result");
    const cost = validateNativeMessage(message, selector);
    if (message.usage.input + message.usage.output + message.usage.cacheRead === 0) throw new Error("Unknown zero native usage");
    changeLedger(root, ledger => {
      const row = ledger.requests.find(r => r.id === pending);
      if (!row || row.status !== "reserved") throw new Error("Missing reservation");
      Object.assign(row, { status: "settled", tariff_usd: cost.tariff_usd, sdk_tariff_usd: message.usage.cost.total, usage: message.usage, stopReason: message.stopReason, settledAt: new Date().toISOString() });
      ledger.cumulative_tariff_usd += cost.tariff_usd;
    });
    pending = null; active = false;
  };
  const fail = () => {
    if (pending) changeLedger(root, ledger => { ledger.status = "blocked_unknown_spend"; ledger.blockReason = "Dispatched request lacks trustworthy native usage"; });
    active = false;
  };
  return { begin, fetch: guardedFetch, settle, fail, get requests() { return requests; } };
}
