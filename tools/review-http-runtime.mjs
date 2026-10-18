/**
 * tools/review-http-runtime.mjs — controlled text-only Chat Completions executor.
 *
 * Not an SDK wrapper: one bounded stdlib Node child, one exact verified route, one
 * exact verified model snapshot, integer nano-USD accounting, no hidden retries,
 * redirects, fallbacks or automatic service tiers. Money authority lives in
 * tools/review-budget.mjs and is consumed durably before every physical wire call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { EXECUTOR, PINNED_CONTEXT_TOKENS, PINNED_PROVIDER, recordRequest, redactSecret, validatePolicy, withoutProviderCredential } from './review-budget.mjs';
import { inspectProduct, readProductPage } from './review-native-tools.mjs';
import { isPathInsideRoot, validateRootPath, validatePathWithinScope } from './worktree-snapshot.mjs';
export { validatePolicy };

export { EXECUTOR };
export const PROVIDER_CREDENTIAL_ENV = 'OPENAI_API_KEY';
export const EXECUTION_FILE = 'execution.jsonl';
const USER_AGENT = 'nullform-controlled-review/1';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * One physical wire call. `globalThis.fetch` is NOT usable here: on HTTP 421 Undici
 * recursively retries a replayable body with no POST guard, so one `fetch()` call can
 * become two real provider requests and break the hard cap. This sender opens a single
 * stdlib connection, disables pooling and redirects, writes the body once and never
 * retries. Loopback fixtures use plain http; production uses verified direct TLS.
 */
export function sendOnce(endpoint, { body, headers, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); } catch { reject(new Error('Invalid endpoint URL')); return; }
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') { reject(new Error(`Unsupported endpoint protocol '${url.protocol}'`)); return; }
    const transport = secure ? https : http;
    const payload = Buffer.from(body, 'utf8');
    // The bound is the TOTAL wall-clock deadline for the whole exchange, not an idle
    // socket timeout: a body that trickles forever must still be cut off.
    const deadline = Date.now() + timeoutMs;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { request.destroy(new Error(`Provider request exceeded the total ${timeoutMs}ms deadline`)); }, timeoutMs);
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: 'POST', agent: false, setHost: true,
      ...(secure ? { rejectUnauthorized: true, servername: url.hostname } : {}),
      headers: { ...headers, 'content-length': payload.length, 'accept-encoding': 'identity' },
    }, response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxResponseBytes) { request.destroy(new Error('Provider response exceeded the bounded byte limit')); return; }
        if (Date.now() > deadline) { request.destroy(new Error(`Provider response exceeded the total ${timeoutMs}ms deadline`)); return; }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', error => finish(error));
    request.end(payload);
  });
}

export { withoutProviderCredential };

/**
 * Reject Bun and resolve a verified real Node. The child must be actual Node: Bun
 * executes `--check` and then diverges, so its presence is never accepted as Node.
 */
export function resolveNodeRuntime({ env = process.env } = {}) {
  if (process.versions?.bun) {
    const probe = spawnSync('node', ['--version'], { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
    const version = String(probe.stdout || '').trim();
    if (probe.status !== 0 || !/^v\d+\.\d+\.\d+/.test(version)) throw new Error('Controlled review requires a real Node runtime; Bun is not accepted and no verified node executable was found on PATH');
    return { command: 'node', version };
  }
  const version = String(process.version || '');
  if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error('Controlled review requires a real Node runtime');
  return { command: process.execPath, version };
}

function executionDirectory(root, sessionDir) {
  const canonical = realpathSync(validateRootPath(root));
  const full = resolve(canonical, sessionDir);
  if (!isPathInsideRoot(canonical, full) || !validatePathWithinScope(full, canonical)) throw new Error('Retained HTTP execution escapes the workspace');
  if (!statSync(full).isDirectory() || lstatSync(full).isSymbolicLink()) throw new Error('Retained HTTP execution directory is a link or not a directory');
  return full;
}

function boundedBodyBytes(value, maximum, label) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximum) throw new Error(`${label} exceeds the bounded admission limit (${bytes} > ${maximum} bytes)`);
  return bytes;
}

function openAiTools() {
  return [
    { type: 'function', function: { name: 'inspect_product', description: 'Read product source or inspect git diffs in bounded batches (max 8 requests) with recoverable paging. If nextOffset is not null, request the next page with offset=nextOffset.',
      parameters: { type: 'object', properties: { requests: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, kind: { type: 'string', enum: ['source', 'diff'] }, offset: { type: 'integer', minimum: 0 } } } } }, required: ['requests'] } } },
    { type: 'function', function: { name: 'exercise_product', description: 'Run the fixed operator-authorized command once per session and read its complete UTF-8 JSON output in bounded pages. Start with offset=0; follow nextOffset until null. Continuations never rerun the command.',
      parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 } }, required: ['offset'] } } },
  ];
}

// Details the provider may report that carry NO billing effect. Known names with a zero
// value are standard and must not break a real API response; an unknown name, or a
// nonzero value for a counter we do not price, still holds as unknown spend. Priced
// counters (e.g. prompt_tokens_details.cached_tokens, billed as cacheRead) are validated
// as safe integers but are never forced to zero: they are charged, not unbilled.
const NONBILLABLE_PROMPT_DETAILS = ['audio_tokens'];
const NONBILLABLE_COMPLETION_DETAILS = ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];

function checkDetailBag(bag, allowed, label, priced = []) {
  if (bag === undefined) return;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) throw new Error(`Provider response has an invalid ${label}`);
  for (const [key, value] of Object.entries(bag)) {
    if (!allowed.includes(key)) throw new Error(`Provider response reported unknown ${label} field '${key}'; unknown billing is not zero`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider response has invalid ${label}.${key}`);
    if (!priced.includes(key) && value !== 0) throw new Error(`Provider response reported nonzero unbilled ${label}.${key}; refusing to price it as zero`);
  }
}

function normalizeUsage(usage, maximumOutputTokens) {
  if (!usage || typeof usage !== 'object') throw new Error('Provider response omitted usage; unknown spend is not zero');
  const prompt = usage.prompt_tokens, completion = usage.completion_tokens, total = usage.total_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  for (const [value, name] of [[prompt, 'prompt_tokens'], [completion, 'completion_tokens'], [total, 'total_tokens'], [cached, 'cached_tokens']]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider response has invalid ${name}`);
  }
  if (total !== prompt + completion) throw new Error('Provider response total_tokens disagrees with its counters');
  if (completion > maximumOutputTokens) throw new Error(`Provider response exceeded the authorized output bound (${completion} > ${maximumOutputTokens})`);
  if (cached > prompt) throw new Error('Provider response cached tokens exceed prompt tokens');
  // The full verified window is the hard ceiling; exceeding it holds rather than settles.
  if (prompt > PINNED_CONTEXT_TOKENS) throw new Error(`Provider response reported ${prompt} prompt tokens beyond the verified ${PINNED_CONTEXT_TOKENS} window; refusing to settle an over-reserve charge`);
  checkDetailBag(usage.prompt_tokens_details, ['cached_tokens', ...NONBILLABLE_PROMPT_DETAILS], 'prompt_tokens_details', ['cached_tokens']);
  checkDetailBag(usage.completion_tokens_details, NONBILLABLE_COMPLETION_DETAILS, 'completion_tokens_details');
  const allowedTop = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'];
  if (Object.keys(usage).some(key => !allowedTop.includes(key))) throw new Error('Provider response reported unpriced/unknown usage counters');
  return { input: prompt, output: completion, cacheRead: cached, cacheWrite: 0, totalTokens: total };
}

/**
 * Child-side loop. `invocation.policy` is the normalized admission policy; every
 * physical call consumes durable authority first, and every raw response is bounded,
 * verified, redacted and retained before it is trusted.
 */
export async function runHttpReview(invocation, { approveEndpoint, expectedProvenanceHash = null } = {}) {
  const { root, role, changeId, model, prompt, provenance, productCommand = null, reservationId, sessionDir } = invocation || {};
  const policy = validatePolicy(invocation?.policy);
  // The caller may pass either the exact provider/model selector or the bare snapshot.
  const requestedModel = typeof model === 'string' && model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  if (requestedModel !== policy.model) throw new Error(`Invocation model '${model}' differs from the admitted policy model '${policy.model}'`);
  if (typeof reservationId !== 'string' || !reservationId) throw new Error('Controlled execution requires an admitted reservation');
  // The declared policy route is always the verified official endpoint. The EFFECTIVE
  // route is where bytes actually go; a difference is what brands loopback fixtures.
  const effectiveEndpoint = typeof invocation?.endpoint === 'string' && invocation.endpoint ? invocation.endpoint : policy.endpoint;
  const evidenceClass = effectiveEndpoint === policy.endpoint ? 'provider-direct' : 'transport-fixture';
  if (typeof approveEndpoint !== 'function' || !approveEndpoint(effectiveEndpoint)) throw new Error('Effective transport route is not approved by the supplied executor');
  // The immutable original contract is captured HERE, in the child, BEFORE the first
  // wire call, and is what the log and every later re-projection are bound to.
  const originalProvenance = Object.freeze({ role, changeId, model, prompt, productCommand,
    sourceDigest: provenance?.sourceDigest ?? null, manifestHash: provenance?.manifestHash ?? null,
    rolePromptHash: provenance?.rolePromptHash ?? null, testFilesHash: provenance?.testFilesHash ?? null,
    baseRef: provenance?.baseRef ?? null, promptHash: provenance?.promptHash ?? null,
    productCommandHash: provenance?.productCommandHash ?? null,
    executor: EXECUTOR, declaredEndpoint: policy.endpoint, effectiveEndpoint, evidenceClass });
  const provenanceHash = createHash('sha256').update(JSON.stringify(originalProvenance)).digest('hex');
  if (expectedProvenanceHash !== null && expectedProvenanceHash !== provenanceHash) throw new Error('Execution provenance differs from the parent-authorized contract; refusing to dispatch');
  // One explicit stdlib sender per call; there is no injectable HTTP client to bypass.
  const directory = executionDirectory(root, sessionDir);
  const credential = process.env[PROVIDER_CREDENTIAL_ENV];
  if (typeof credential !== 'string' || !credential) throw new Error(`${PROVIDER_CREDENTIAL_ENV} is required at the dispatch boundary; no credential means no dispatch`);

  const startedAt = new Date().toISOString();
  const executionId = randomUUID();
  const tools = openAiTools();
  const messages = [{ role: 'user', content: prompt }];
  const events = [{ type: 'execution', executionId, executor: EXECUTOR, role, changeId, model, declaredEndpoint: policy.endpoint, effectiveEndpoint, evidenceClass, provenanceHash, originalProvenance, startedAt }];
  const providerResponses = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  const retain = (name, text) => {
    const file = join(directory, name);
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    const fd = openSync(file, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return { path: relative(realpathSync(validateRootPath(root)), file), sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex') };
  };

  // Product execution state is shared with the native path: execute once, then page.
  const productState = {};
  const callTool = (name, args) => {
    if (name === 'inspect_product') return JSON.stringify(inspectProduct({ root, role, changeId, baseRef: provenance?.baseRef, provenance }, args?.requests), null, 2);
    if (name === 'exercise_product') {
      if (!productCommand) throw new Error('No operator consumer command was provided; exercise_product is unavailable');
      const first = !productState.buffer;
      const { page } = readProductPage(productState, { root, productCommand, provenance, offset: args?.offset ?? 0 });
      // One latched event per actual execution, not per page read.
      if (first) events.push({ type: 'product_execution', at: new Date().toISOString(), commandHash: page.commandHash,
        sourceDigest: page.sourceDigest, exitCode: page.exitCode, outputHash: page.contentHash });
      return JSON.stringify(page, null, 2);
    }
    throw new Error(`Unsupported tool '${name}'`);
  };

  try {
    for (let attempt = 1; attempt <= policy.maxRequests; attempt++) {
      const body = JSON.stringify({ model: policy.model, messages, tools, tool_choice: 'auto', n: 1, stream: false, store: false,
        service_tier: 'default', max_completion_tokens: policy.maxOutputTokens });
      boundedBodyBytes(body, policy.maxContextBytes, 'Request body');
      // Durable authority for this physical call, before it is sent.
      recordRequest({ root, reservationId });
      const sentAt = new Date().toISOString();
      const response = await sendOnce(effectiveEndpoint, { body, timeoutMs: policy.timeoutMs, maxResponseBytes: policy.maxResponseBytes,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, 'user-agent': USER_AGENT } });
      if (REDIRECT_STATUSES.has(response.status)) throw new Error(`Provider attempted a redirect (HTTP ${response.status}); redirects are never followed and the reserved authority is kept`);
      if (response.status !== 200) throw new Error(`Provider returned HTTP ${response.status}; the failed request keeps its reserved authority`);
      if (String(response.headers['content-encoding'] || 'identity').toLowerCase() !== 'identity') throw new Error('Provider returned an unsupported content-encoding; refusing to interpret compressed bytes');
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > policy.maxResponseBytes) throw new Error('Provider response declares more bytes than the bounded limit');
      const raw = response.body;
      if (raw.length > policy.maxResponseBytes) throw new Error('Provider response exceeded the bounded byte limit');
      const rawText = redactSecret(raw.toString('utf8'), credential);
      const parsed = JSON.parse(rawText);
      if (parsed?.model !== policy.model) throw new Error(`Provider reported an unapproved model '${parsed?.model}'; refusing the response`);
      if (!Array.isArray(parsed.choices) || parsed.choices.length !== 1) throw new Error('Provider response did not contain exactly one choice');
      const choice = parsed.choices[0];
      const usage = normalizeUsage(parsed.usage, policy.maxOutputTokens);
      for (const key of Object.keys(totals)) totals[key] += usage[key];
      const requestId = response.headers['x-request-id'] || null;
      const retained = retain(`provider-response-${attempt}.json`, rawText);
      providerResponses.push({ ...retained, requestId, status: response.status, bytes: raw.length, model: parsed.model, responseId: parsed.id });
      events.push({ type: 'provider_response', at: new Date().toISOString(), ordinal: attempt, sentAt, requestId,
        status: response.status, bytes: raw.length, sha256: retained.sha256, responseId: parsed.id, finishReason: choice.finish_reason, usage });
      const message = choice.message || {};
      if (choice.finish_reason === 'tool_calls') {
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!calls.length) throw new Error('Provider reported tool_calls without any call');
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          if (call?.type !== 'function' || typeof call?.function?.name !== 'string') throw new Error('Provider returned an unsupported tool call');
          let args;
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error(`Tool call '${call.function.name}' had unparsable arguments`); }
          messages.push({ role: 'tool', tool_call_id: call.id, content: callTool(call.function.name, args) });
        }
        continue;
      }
      if (choice.finish_reason !== 'stop') throw new Error(`Provider finished with unsupported reason '${choice.finish_reason}'`);
      const content = typeof message.content === 'string' ? message.content : '';
      if (!content.trim()) throw new Error('Provider returned an empty final report');
      const completedAt = new Date().toISOString();
      events.push({ type: 'completion', at: completedAt, executionId, attempts: attempt, totals });
      const text = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
      writeFileSync(join(directory, EXECUTION_FILE), text, { flag: 'wx', mode: 0o600 });
      const fd = openSync(join(directory, EXECUTION_FILE), 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return { status: 0, executionId, executor: EXECUTOR, model: parsed.model, provider: PINNED_PROVIDER, evidenceClass,
        startedAt, completedAt, report: content, stopReason: choice.finish_reason, usage: { ...totals, costUsd: 0 }, providerResponses, executionHash: createHash('sha256').update(text, 'utf8').digest('hex'), events };
    }
    throw new Error(`Request limit reached: ${policy.maxRequests} physical request attempt(s) consumed without a terminal report`);
  } catch (error) {
    const reason = redactSecret(String(error?.message || error), credential);
    events.push({ type: 'failure', at: new Date().toISOString(), executionId, reason });
    try { appendFileSync(join(directory, EXECUTION_FILE), `${JSON.stringify(events.at(-1))}\n`); } catch {}
    return { status: 1, executionId, executor: EXECUTOR, reason, usage: { ...totals, costUsd: 0 }, providerResponses, events };
  }
}

// Production executors are branded PRIVATELY. A JS caller can hand us any object with a
// forged `endpoint`, so a public boolean is not evidence: only objects this module
// created itself may ever claim the direct-provider class. This is not cryptographic
// attestation against a malicious same-OS actor; it stops accidental and injected-seam
// forgery, and the structural integrity checks still run for fixtures.
const BRANDED_EXECUTORS = new WeakSet();

export function isBrandedExecutor(executor) { return Boolean(executor) && BRANDED_EXECUTORS.has(executor); }

/** The fixed shipped child, resolved from THIS module, never from the consumer project. */
export function shippedChildPath() { return fileURLToPath(new URL('./review-http-child.mjs', import.meta.url)); }

/** Child environment with proxy/preload/TLS overrides removed before spawn. */
export function sanitizedChildEnv(env = process.env) {
  const dropped = /^(?:https?_proxy|all_proxy|no_proxy|node_options|node_path|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !dropped.test(key)));
}

/**
 * Parent-side executor. Returns a runner-compatible `{ status, stdout }` whose stdout
 * is the child's JSON result envelope. The brand is what separates real provider
 * evidence from a loopback transport fixture.
 */
export function createHttpExecutor({ root, policy, env = process.env, timeoutMs = 120000 }) {
  const normalized = validatePolicy(policy);
  const runtime = resolveNodeRuntime({ env });
  const executor = Object.freeze({
    endpoint: normalized.endpoint,
    approveEndpoint: url => url === normalized.endpoint,
    run(invocation) {
      // The child is SHIPPED with this module, so a normal consumer repo needs no copy.
      const child = shippedChildPath();
      const result = spawnSync(runtime.command, [child], { cwd: root, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        env: sanitizedChildEnv(env), input: JSON.stringify({ invocation }) });
      if (result.error) throw new Error(`Controlled review child failed to start: ${result.error.message}`);
      return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    },
  });
  BRANDED_EXECUTORS.add(executor);
  return executor;
}

/** Release gate: only a privately-branded executor's direct-provider evidence qualifies. */
export function isReleaseEligible(record, executor = null) {
  return Boolean(record) && record.executor === EXECUTOR && isBrandedExecutor(executor)
    && record.context?.evidenceClass === 'provider-direct';
}

export function ensureExecutionDirectory(root, sessionDir) {
  const canonical = realpathSync(validateRootPath(root));
  const full = resolve(canonical, sessionDir);
  if (!isPathInsideRoot(canonical, full) || !validatePathWithinScope(full, canonical)) throw new Error('Retained HTTP execution escapes the workspace');
  if (!existsSync(full)) mkdirSync(full, { recursive: true });
  return executionDirectory(canonical, sessionDir);
}

const REVIEW_RUN_FLAGS = ['root', 'harness', 'user-home', 'change', 'role', 'model', 'base-ref', 'product-command',
  'redo', 'dry-run', 'dryRun', 'admission-policy', 'resume-session'];
const BOOLEAN_FLAGS = ['redo', 'dry-run', 'dryRun'];

/**
 * Reject unknown flags, stray positionals and wrong-valued booleans BEFORE any
 * admission or child. `--dryrun` or `--redo false` must never silently buy a run.
 */
export function assertReviewRunFlags(flags, positionals = 0) {
  if (positionals) throw new Error('review-run accepts no positional arguments');
  for (const key of Object.keys(flags || {})) if (!REVIEW_RUN_FLAGS.includes(key)) throw new Error(`review-run: unknown flag '--${key}'; allowed: ${REVIEW_RUN_FLAGS.map(name => `--${name}`).join(' ')}`);
  for (const key of BOOLEAN_FLAGS) if (flags?.[key] !== undefined && flags[key] !== true) throw new Error(`review-run: '--${key}' is a boolean flag and takes no value`);
  return { redo: flags?.redo === true, dryRun: flags?.['dry-run'] === true || flags?.dryRun === true };
}
