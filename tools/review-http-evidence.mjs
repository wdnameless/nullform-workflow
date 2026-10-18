/**
 * tools/review-http-evidence.mjs — controlled-HTTP evidence projection and integrity.
 *
 * The HTTP executor must be as strong as the native path: nothing is taken from the
 * parent's outer claims. Everything is RE-PROJECTED from the child's retained execution
 * log plus the raw provider response files, and the immutable original provenance is
 * captured in the child before the first wire call and re-hashed here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRealPathInsideRoot } from './worktree-snapshot.mjs';
import { EXECUTOR, PINNED_PROVIDER, EVIDENCE_CLASSES, nanoUsdToUsd, pinnedTariffsNanoPerToken, usageCostNanoUsd, redactSecret } from './review-budget.mjs';
import { assertProductExecutionInvariant } from './review-native-tools.mjs';

const POSITIVE_VERDICT_RE = /(?:^|\r?\n)\s*(?:(?:#+\s*)?(?:\*{0,2}Verdict:?\*{0,2}:?\s*)?\*{0,2}ACCEPT\*{0,2}(?::|\s|$|[.,])|\|\s*\*{0,2}Verdict:?\*{0,2}:?\s*\|\s*\*{0,2}ACCEPT\*{0,2}\b)/im;
const NEGATIVE_VERDICT_RE = /(?:^|\r?\n)[ \t]*(?:(?:#+[ \t]*)?\*{0,2}Verdict:?\*{0,2}:?[ \t]*\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}(?::|[ \t]|$|[.,])|\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}(?::|[ \t]*[.,]?[ \t]*\r?$))|\|[ \t]*\*{0,2}Verdict:?\*{0,2}:?[ \t]*\|[ \t]*\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}\b/im;
const isPositiveOracleVerdict = text => typeof text === 'string' && POSITIVE_VERDICT_RE.test(text) && !NEGATIVE_VERDICT_RE.test(text);
const isNegativeOracleVerdict = text => typeof text === 'string' && NEGATIVE_VERDICT_RE.test(text);
const computeEventProjectionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CLOCK_TOLERANCE_MS = 2000;

function timestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`Missing ${label} timestamp`);
  const time = new Date(value).getTime();
  if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString() !== value) throw new Error(`Invalid ${label} timestamp`);
  return time;
}

/** The reviewer's typed JSON report; re-derived from the verified report text. */
function extractVerdict(role, text) {
  if (role === 'reviewer') {
    let report;
    try { report = JSON.parse(String(text).replace(/^```json\s*\n([\s\S]*?)\n```\s*$/i, '$1')); } catch { throw new Error('Reviewer final report must be complete typed JSON'); }
    if (!report || !Array.isArray(report.findings) || !['correct', 'incorrect'].includes(report.overall_correctness)
      || typeof report.overall_explanation !== 'string' || !report.overall_explanation.trim()
      || !Number.isFinite(report.overall_confidence_score) || report.overall_confidence_score < 0 || report.overall_confidence_score > 1) {
      throw new Error('Reviewer final report has invalid findings/correctness schema');
    }
    return { verdict: report.overall_correctness === 'correct' ? 'ACCEPT' : 'REJECT', nativeVerdict: report.overall_correctness };
  }
  if (isNegativeOracleVerdict(text)) return { verdict: 'REJECT', nativeVerdict: 'REJECT' };
  if (isPositiveOracleVerdict(text)) return { verdict: 'ACCEPT', nativeVerdict: 'ACCEPT' };
  throw new Error('Oracle final report lacks an explicit terminal verdict');
}

function parseEnvelope(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error('Controlled execution envelope is not valid JSON'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Controlled execution returned an invalid envelope');
  return envelope;
}

/**
 * Re-derive the full execution from the retained log and raw provider responses.
 * Returns the projected parts; the caller wraps them with the identity fields.
 */
export function reprojectHttpExecution({ envelope, provenance, role, executorBranded, root }) {
  if (envelope.status !== 0) throw new Error(redactSecret(String(envelope.reason || 'Controlled execution did not complete successfully'), process.env.OPENAI_API_KEY));
  if (envelope.executor !== EXECUTOR) throw new Error(`Unexpected controlled executor '${envelope.executor}'`);
  if (!Array.isArray(envelope.events) || !envelope.events.length) throw new Error('Controlled execution retained no engine events');

  const startedAt = timestamp(envelope.startedAt, 'execution start');
  const completedAt = timestamp(envelope.completedAt, 'execution completion');
  if (completedAt < startedAt) throw new Error('Controlled execution clock inversion');

  const executions = envelope.events.filter(event => event.type === 'execution');
  if (executions.length !== 1) throw new Error('Controlled execution must record exactly one startup event');
  const startup = executions[0];
  if (typeof startup.executionId !== 'string' || !startup.executionId) throw new Error('Controlled execution lacks an engine executionId');
  if (startup.executionId !== envelope.executionId) throw new Error('Controlled executionId differs from its own startup event');

  // The immutable original contract must be present, self-consistent and match the
  // parent's identity — an outer claim alone is never accepted.
  const original = startup.originalProvenance;
  if (!original || typeof original !== 'object') throw new Error('Controlled execution did not capture its original provenance before dispatch');
  const recomputed = createHash('sha256').update(JSON.stringify(original)).digest('hex');
  if (recomputed !== startup.provenanceHash) throw new Error('Controlled execution provenance hash does not match its captured original contract');
  if (original.executor !== EXECUTOR) throw new Error('Controlled execution original provenance has a foreign executor');
  for (const key of ['role', 'model', 'sourceDigest', 'manifestHash', 'rolePromptHash', 'testFilesHash', 'baseRef', 'promptHash', 'productCommandHash']) {
    // The parent provenance carries the requested provider/model SELECTOR, not the bare
    // snapshot, so the 'model' key maps to it (falling back to a plain model field).
    const parent = key === 'role' ? role : key === 'model' ? provenance?.requestedModel ?? provenance?.model ?? null : provenance?.[key];
    if (JSON.stringify(original[key] ?? null) !== JSON.stringify(parent ?? null)) throw new Error(`Controlled execution original ${key} differs from the dispatched contract`);
  }
  // A JS-injected seam can never claim the direct-provider class, whatever it reports.
  const evidenceClass = executorBranded ? original.evidenceClass : 'transport-fixture';
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) throw new Error(`Unknown evidence class '${evidenceClass}'`);

  // The provider echoes the BARE model snapshot ('gpt-4o-mini-2024-07-18'); the dispatched
  // contract carries the provider/model SELECTOR ('openai/<snapshot>'). There is no
  // separate response field for the provider id, so only the snapshot part of the single
  // approved selector may match — no additional tolerance is introduced.
  const approvedModel = typeof original.model === 'string' && original.model.includes('/')
    ? original.model.slice(original.model.indexOf('/') + 1) : original.model;
  // Provider responses are re-verified against the RAW retained bytes.
  const responseEvents = envelope.events.filter(event => event.type === 'provider_response');
  if (!responseEvents.length) throw new Error('Controlled execution retained no provider responses');
  const providerResponses = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let lastContent = null;
  for (const [index, event] of responseEvents.entries()) {
    if (event.ordinal !== index + 1) throw new Error('Controlled execution provider responses are not contiguous');
    const declared = envelope.providerResponses?.[index];
    if (!declared || typeof declared.path !== 'string' || !isRealPathInsideRoot(root, declared.path)) throw new Error('Retained provider response escapes the workspace');
    const raw = readFileSync(resolve(root, declared.path));
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sha256 !== declared.sha256 || sha256 !== event.sha256) throw new Error('Retained provider response bytes do not match their recorded hash');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Retained provider response is not valid JSON'); }
    if (body.model !== approvedModel) throw new Error('Provider response reported an unapproved model');
    if (body.id !== declared.responseId || body.id !== event.responseId) throw new Error('Provider response id does not match its retained bytes');
    if (event.status !== 200 || declared.status !== 200) throw new Error('Provider response is not a successful direct response');
    if (body.usage?.prompt_tokens !== event.usage.input || body.usage?.completion_tokens !== event.usage.output) throw new Error('Provider response usage does not match its retained bytes');
    for (const key of Object.keys(totals)) totals[key] += event.usage[key];
    const choice = body.choices?.[0];
    if (body.choices?.length !== 1 || !choice) throw new Error('Provider response did not contain exactly one choice');
    if (typeof choice.message?.content === 'string' && choice.finish_reason === 'stop') lastContent = choice.message.content;
    providerResponses.push({ path: declared.path, sha256, requestId: declared.requestId ?? null, status: 200, bytes: raw.length, model: body.model, responseId: body.id });
  }
  if (typeof lastContent !== 'string' || !lastContent.trim()) throw new Error('Controlled execution retained no terminal report content');
  if (lastContent !== envelope.report) throw new Error('Controlled execution report differs from the retained terminal provider response');

  const completions = envelope.events.filter(event => event.type === 'completion');
  if (completions.length !== 1) throw new Error('Controlled execution must record exactly one completion event');
  if (completions[0].attempts !== responseEvents.length) throw new Error('Controlled execution completion does not account for every provider response');
  for (const key of Object.keys(totals)) if (completions[0].totals?.[key] !== totals[key]) throw new Error(`Controlled execution completion ${key} disagrees with its provider responses`);

  // Every event must lie inside the declared execution window.
  for (const event of envelope.events) {
    const at = timestamp(event.at ?? event.startedAt, `${event.type} event`);
    if (at < startedAt - CLOCK_TOLERANCE_MS || at > completedAt + CLOCK_TOLERANCE_MS) throw new Error(`${event.type} event falls outside the execution clock window`);
  }
  const products = envelope.events.filter(event => event.type === 'product_execution');
  if (role === 'oracle' && !products.length) throw new Error('Oracle lacks an actual product execution');
  if (products.length > 1) throw new Error('Controlled execution must latch at most one product execution event');

  const usage = { ...totals, costUsd: nanoUsdToUsd(usageCostNanoUsd(totals, pinnedTariffsNanoPerToken())), costSource: 'controlled-http-usage' };
  const verdict = extractVerdict(role, lastContent);

  for (const execution of products) {
    assertProductExecutionInvariant({
      execution,
      productCommandHash: original.productCommandHash,
      sourceDigest: original.sourceDigest,
      startedAt,
      completedAt,
      verdict: verdict.verdict,
      clockToleranceMs: CLOCK_TOLERANCE_MS,
    });
  }

  return { executionId: startup.executionId, evidenceClass, provenanceHash: startup.provenanceHash, originalProvenance: original,
    providerResponses, events: envelope.events, usage, report: lastContent, stopReason: 'stop', verdict, products,
    startedAt: envelope.startedAt, completedAt: envelope.completedAt };
}

/** Project a controlled-HTTP envelope into the common evidence shape. */
export function projectHttpRecord({ text, provenance, role, executorBranded, root, endpoint }) {
  const envelope = parseEnvelope(text);
  const parts = reprojectHttpExecution({ envelope, provenance, role, executorBranded, root });
  if (envelope.usage?.costUsd !== 0) throw new Error('Controlled execution reported an unexpected cost field');
  const nativeProjection = { role, provider: PINNED_PROVIDER, model: envelope.model, requestedModel: provenance.requestedModel,
    sourceDigest: provenance.sourceDigest, manifestHash: provenance.manifestHash, rolePromptHash: provenance.rolePromptHash,
    testFilesHash: provenance.testFilesHash, baseRef: provenance.baseRef, exitCode: 0 };
  const context = { role, executor: EXECUTOR, evidenceClass: parts.evidenceClass, executionId: parts.executionId, endpoint,
    provenanceHash: parts.provenanceHash, sourceDigest: provenance.sourceDigest, manifestHash: provenance.manifestHash,
    rolePromptHash: provenance.rolePromptHash, testFilesHash: provenance.testFilesHash, baseRef: provenance.baseRef,
    requestedModel: provenance.requestedModel, promptHash: provenance.promptHash, productCommandHash: provenance.productCommandHash };
  return { ...nativeProjection, executor: EXECUTOR, context, executionId: parts.executionId, evidenceClass: parts.evidenceClass,
    provenanceHash: parts.provenanceHash, providerResponses: parts.providerResponses, events: parts.events,
    report: parts.report, stopReason: parts.stopReason, usage: parts.usage, startedAt: parts.startedAt, completedAt: parts.completedAt,
    ...parts.verdict, eventProjectionHash: computeEventProjectionHash(nativeProjection) };
}

/**
 * Release-gate validation. The structural integrity checks run for EVERY controlled
 * record, including fixtures, so tamper regressions are provable; the fixture class is
 * then rejected for release eligibility.
 */
export function validateHttpRecord({ record, role, current, errors, root, text }) {
  try {
    if (!record || record.role !== role || record.exitCode !== 0) throw new Error('Missing or failed role execution');
    if (record.executor !== EXECUTOR) throw new Error(`Unexpected executor '${record.executor}'`);
    if (record.sessionId !== undefined || record.nativeProjection !== undefined) throw new Error('Controlled HTTP evidence must not fake native OMP provenance');
    if (typeof record.executionId !== 'string' || !record.executionId) throw new Error('Missing engine executionId');
    const envelope = parseEnvelope(text);
    const parts = reprojectHttpExecution({ envelope, provenance: { ...record, requestedModel: record.requestedModel, promptHash: record.context?.promptHash ?? record.promptHash ?? null, productCommandHash: record.context?.productCommandHash ?? record.productCommandHash ?? null }, role, executorBranded: record.evidenceClass === 'provider-direct', root });
    for (const key of ['executionId', 'evidenceClass', 'provenanceHash', 'report', 'stopReason', 'startedAt', 'completedAt']) {
      if (JSON.stringify(record[key]) !== JSON.stringify(parts[key])) throw new Error(`Controlled record ${key} differs from its re-projected execution`);
    }
    if (JSON.stringify(record.usage) !== JSON.stringify(parts.usage)) throw new Error('Controlled record usage differs from its re-projected provider responses');
    if (JSON.stringify(record.providerResponses) !== JSON.stringify(parts.providerResponses)) throw new Error('Controlled record provider responses differ from their retained bytes');
    if (JSON.stringify(record.events) !== JSON.stringify(parts.events)) throw new Error('Controlled record events differ from the retained execution log');
    if (JSON.stringify(record.context) !== JSON.stringify({ ...record.context, provenanceHash: parts.provenanceHash, evidenceClass: parts.evidenceClass, executionId: parts.executionId })) throw new Error('Controlled context provenance is not bound to the execution');
    for (const key of ['role', 'sourceDigest', 'manifestHash', 'rolePromptHash', 'testFilesHash', 'baseRef']) if (record[key] !== record.context?.[key]) throw new Error(`Controlled context ${key} mismatch`);
    if (record.sourceDigest !== current.source) throw new Error('Controlled source digest is stale');
    if (record.manifestHash !== current.manifestHash) throw new Error('manifest hash mismatch');
    if (record.rolePromptHash !== current[`${role}PromptHash`]) throw new Error('role prompt hash mismatch');
    if (record.testFilesHash !== current.tests) throw new Error('Frozen Stage-A tests mismatch');
    if (record.model !== current.model) throw new Error('Controlled execution model mismatch');
    if (record.verdict !== 'ACCEPT') throw new Error(`REJECT verdict in ${record.executionId}`);
    // Only a privately-branded direct transport may satisfy the release gate.
    if (record.context.evidenceClass !== 'provider-direct') throw new Error('transport-fixture receipt cannot satisfy the release gate: it proves the transport, not a paid provider execution');
  } catch (error) { errors.push(`review-evidence: ${role}: ${error.message}`); }
}
