import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, mkdtempSync, rmSync, realpathSync, lstatSync, openSync, closeSync, fstatSync, readSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { hashFile, sourceDigest, testFilesHash, scanWorktree, isAcceptancePath, isAcceptanceArtifactFilename, isStructuralExcludedPath, isSecretOrCredentialPath, isRealPathInsideRoot, isPathInsideRoot, validateRootPath, validatePathWithinScope, cleanGitEnv } from '../worktree-snapshot.mjs';
import { sanitizeError } from '../installation/state.mjs';
import { admitSession, holdReservation, inspectAdmission, nanoUsdToUsd, PINNED_CONTEXT_TOKENS, settleReservation, validatePolicy, EXECUTOR, redactSecret } from './budget.mjs';
import * as budgetModule from './budget.mjs';
import * as httpEvidence from './http-evidence.mjs';
const inspectBudget = budgetModule.inspectBudget;
const { projectHttpRecord, validateHttpRecord } = httpEvidence;
import { isBrandedExecutor } from './http-runtime.mjs';
import { assertProductExecutionInvariant } from './native-tools.mjs';

export const EVIDENCE_FILE = 'review-evidence.json';
export const POSITIVE_VERDICT_RE = /(?:^|\r?\n)\s*(?:(?:#+\s*)?(?:\*{0,2}Verdict:?\*{0,2}:?\s*)?\*{0,2}ACCEPT\*{0,2}(?::|\s|$|[.,])|\|\s*\*{0,2}Verdict:?\*{0,2}:?\s*\|\s*\*{0,2}ACCEPT\*{0,2}\b)/im;
export const NEGATIVE_VERDICT_RE = /(?:^|\r?\n)[ \t]*(?:(?:#+[ \t]*)?\*{0,2}Verdict:?\*{0,2}:?[ \t]*\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}(?::|[ \t]|$|[.,])|\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}(?::|[ \t]*[.,]?[ \t]*\r?$))|\|[ \t]*\*{0,2}Verdict:?\*{0,2}:?[ \t]*\|[ \t]*\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)[ \t]+ACCEPT(?:ED)?)\*{0,2}\b/im;
export { isAcceptanceArtifactFilename, isStructuralExcludedPath, isSecretOrCredentialPath };
export const computeFileHash = hashFile;
export const computeSourceDigest = sourceDigest;
export const computeTestFilesHash = testFilesHash;
export function computeEventProjectionHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function isPositiveOracleVerdict(text) { return typeof text === 'string' && POSITIVE_VERDICT_RE.test(text) && !NEGATIVE_VERDICT_RE.test(text); }
export function isNegativeOracleVerdict(text) { return typeof text === 'string' && NEGATIVE_VERDICT_RE.test(text); }
export function isOracleEvidenceFilename(path) { return /^oracle(-+[a-z0-9]+)*\.md$/i.test(basename(String(path || ''))) || basename(String(path || '')).toLowerCase() === 'acceptance.md'; }
export function computeManifestHash(root, changeId) { return hashFile(join(changeDirectory(root, changeId), 'manifest.md'), true); }

/**
 * Resolve the role definition for a review in ANY consumer repo.
 *
 * A project that ships its own `agent/agents/<role>.md` tree owns that convention:
 * a missing, linked or escaping role there is a hard failure, never a silent fallback.
 * Only when the project has no role-definition tree at all does the shipped package
 * role become the real default. No personal ~/.omp role is ever read.
 */
export function resolveRoleDefinition(root, role) {
  const projectRoles = join(root, 'agent', 'agents');
  if (existsSync(projectRoles)) {
    const entry = join(projectRoles, `${role}.md`);
    if (lstatSync(projectRoles).isSymbolicLink()) throw new Error('Project role-definition tree is a link/junction; refusing to read roles through it');
    if (!existsSync(entry)) throw new Error(`Project defines its own role tree but '${role}' is missing: restore agent/agents/${role}.md or remove the tree to use the shipped default`);
    return safeFile(root, join('agent', 'agents', `${role}.md`));
  }
  const shipped = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'agents', `${role}.md`);
  if (!existsSync(shipped)) throw new Error(`Shipped role definition '${role}' is missing from the installation`);
  return shipped;
}

export function computeRolePromptHash(root, role) { return hashFile(resolveRoleDefinition(root, role), true); }
export function getPorcelainStatusRaw(root) {
  try { return git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '-uall', '--', '.']); } catch { return null; }
}
function git(root, args) { return execFileSync('git', args, { cwd: root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
function safeFile(root, path) {
  if (!isRealPathInsideRoot(root, path)) throw new Error(`Path resolves outside project root or is missing: ${path}`);
  return resolve(root, path);
}
function changeDirectory(root, changeId) {
  if (typeof changeId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(changeId)) throw new Error('Invalid --change slug');
  return safeFile(root, join('openspec', 'changes', changeId));
}
export function loadReviewEvidence(changeDir) {
  const path = join(changeDir, EVIDENCE_FILE);
  if (!existsSync(path)) return null;
  if (!isRealPathInsideRoot(changeDir, EVIDENCE_FILE)) throw new Error('Evidence file escapes change directory');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
export function saveReviewEvidence(changeDir, data) {
  if (existsSync(join(changeDir, EVIDENCE_FILE)) && !isRealPathInsideRoot(changeDir, EVIDENCE_FILE)) throw new Error('Evidence file escapes change directory');
  atomicJson(join(changeDir, EVIDENCE_FILE), data, join(changeDir, `review-evidence-${randomUUID()}.json`));
}
export function isFlashOrFallback(model, provider, fallback) { return Boolean(fallback) || /flash|haiku|mini|nano|lite|fallback/i.test(`${provider} ${model}`); }
function resolveBase(root, baseRef) {
  if (!baseRef || typeof baseRef !== 'string' || baseRef.startsWith('-')) throw new Error('review-run: explicit --base-ref or recorded cycle baseline required');
  return git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
}

/**
 * Read and validate the project-relative spending authority. A caller can never
 * relocate the ledger, re-price the snapshot, or lower the reserve through policy.
 */
function readAdmissionPolicy(root, policyPath) {
  if (typeof policyPath !== 'string' || !policyPath) throw new Error('No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON');
  if (isAbsolute(policyPath) || !isRealPathInsideRoot(root, policyPath)) throw new Error('Admission policy must be an existing project-relative file inside the workspace');
  const file = resolve(root, policyPath);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Admission policy must be a JSON file of at most 16 KiB');
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Admission policy is not valid JSON'); }
  if (parsed && typeof parsed === 'object' && typeof parsed.provider === 'string' && /openrouter|nullform-gateway/i.test(parsed.provider)) {
    throw new Error('OpenRouter and opaque nullform-gateway providers are forbidden providers');
  }
  return validatePolicy(parsed);
}
export function countSourceChanges(root, baseRef) {
  try {
    const base = resolveBase(root, baseRef);
    const rows = git(root, ['diff', '--numstat', '-z', base, '--', '.']).split('\0').filter(Boolean);
    let changedFilesCount = 0, changedLinesCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const [added, deleted, path] = rows[i].split('\t');
      if (!path || added === '-' || deleted === '-') throw new Error('Unproven binary/rename diff');
      if (isStructuralExcludedPath(path) || isAcceptancePath(path)) continue;
      changedFilesCount++;
      changedLinesCount += Number(added) + Number(deleted);
    }
    // Untracked source has no git diff; it cannot establish a lite allowance.
    const snapshot = scanWorktree(root);
    if (Object.keys(snapshot.untracked || {}).some(p => !isAcceptancePath(p))) throw new Error('Untracked source is not in diff');
    return { isOracleLite: changedFilesCount <= 2 && changedLinesCount <= 80, changedFilesCount, changedLinesCount };
  } catch { return { isOracleLite: false, changedFilesCount: null, changedLinesCount: null }; }
}
function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Missing native timestamp');
  const time = new Date(value).getTime();
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid native timestamp');
  if ((typeof value === 'string' && value !== new Date(time).toISOString()) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('Invalid native timestamp format');
  return new Date(time).toISOString();
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid native token usage ${name}: safe nonnegative integer required`);
  return value;
}
function nativeEvents(text) {
  const events = text.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s));
  const retained = [];
  for (const ev of events) {
    if (ev.type === 'session') retained.push({ type: 'session', id: ev.id, timestamp: ev.timestamp });
    if (ev.type === 'model_change') {
      const selector = typeof ev.model === 'string' ? ev.model : '';
      const slash = selector.indexOf('/');
      retained.push({ type: 'model_change', model: slash > 0 ? selector.slice(slash + 1) : selector, provider: slash > 0 ? selector.slice(0, slash) : ev.provider, isFallback: ev.role === 'fallback' || Boolean(ev.isFallback || ev.resolvedModelIsFallback), timestamp: ev.timestamp });
    }
    if (ev.type === 'custom' && ['workflow-review-context', 'workflow-product-execution'].includes(ev.customType)) retained.push({ type: 'custom', customType: ev.customType, timestamp: ev.timestamp, data: ev.data });
    if (ev.type === 'message' && ev.message?.role === 'assistant') {
      const m = ev.message;
      const u = m.usage || {};
      const usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: { total: u.cost?.total } };
      retained.push({ type: 'message', timestamp: ev.timestamp, message: { role: m.role, provider: m.provider, model: m.model, timestamp: m.timestamp, stopReason: m.stopReason, usage, content: (m.content || []).filter(p => ['text', 'toolCall'].includes(p.type)).map(p => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'toolCall', id: p.id, name: p.name }) } });
    }
  }
  return retained;
}
/**
 * The reviewer/oracle terminal verdict. The reviewer's typed findings schema is validated by
 * the ONE shared validator in review/http-evidence.mjs (used by both transports), so the
 * native and controlled-HTTP paths cannot diverge on what a valid report is.
 */
function extractVerdict(role, text) {
  if (role === 'reviewer') return httpEvidence.extractVerdict(role, text);
  if (isNegativeOracleVerdict(text)) return { verdict: 'REJECT', nativeVerdict: 'REJECT' };
  if (isPositiveOracleVerdict(text)) return { verdict: 'ACCEPT', nativeVerdict: 'ACCEPT' };
  throw new Error('Oracle final report lacks an explicit terminal verdict');
}
function projectNative(events, role) {
  if (!Array.isArray(events) || !events.length) throw new Error('Missing retained native events');
  const sessions = events.filter(e => e.type === 'session');
  if (sessions.length !== 1 || typeof sessions[0].id !== 'string' || !sessions[0].id.trim()) throw new Error('Missing/ambiguous native session ID');
  const startedAt = timestamp(sessions[0].timestamp);
  let previous = startedAt;
  for (const event of events) {
    const at = timestamp(event.timestamp);
    if (at < previous) throw new Error('Native timestamp inversion');
    previous = at;
  }
  const contexts = events.filter(e => e.type === 'custom' && e.customType === 'workflow-review-context');
  if (contexts.length !== 1 || contexts[0].data?.role !== role) throw new Error('Missing/ambiguous native review context');
  const context = contexts[0].data;
  const messages = events.filter(e => e.type === 'message' && e.message?.role === 'assistant');
  const last = messages.at(-1);
  if (!last) throw new Error('empty/final report missing');
  const final = last.message;
  const report = (final.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
  if (!report) throw new Error('empty/final report missing');
  if (final.stopReason !== 'stop') throw new Error(`abnormal stop reason '${final.stopReason}'`);
  if ((final.content || []).some(p => p.type === 'toolCall')) throw new Error('Final report has unresolved tool calls');
  if (!events.some(e => e.type === 'model_change')) throw new Error('Missing native effective model selection');
  for (const event of events.filter(e => e.type === 'model_change')) if (event.model !== final.model || event.provider !== final.provider) throw new Error('Native effective model selection changed');
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens = 0, costUsd = 0;
  for (const ev of messages) {
    const m = ev.message;
    if (m.model !== final.model || m.provider !== final.provider) throw new Error('Mixed effective model/provider in native session');
    if (!['stop', 'toolUse'].includes(m.stopReason)) throw new Error(`abnormal stop reason '${m.stopReason}'`);
    const u = m.usage || {};
    const a = integer(u.input, 'input'), b = integer(u.output, 'output'), c = integer(u.cacheRead ?? 0, 'cacheRead'), d = integer(u.cacheWrite ?? 0, 'cacheWrite');
    const total = integer(u.totalTokens, 'totalTokens');
    if (total !== a + b + c + d) throw new Error('Native totalTokens inconsistent with token counters');
    if (typeof u.cost?.total !== 'number' || !Number.isFinite(u.cost.total) || u.cost.total < 0) throw new Error('Unknown or nonfinite native fixed-tariff cost');
    input += a; output += b; cacheRead += c; cacheWrite += d; totalTokens += total; costUsd += u.cost.total;
    if (timestamp(m.timestamp) < startedAt || timestamp(m.timestamp) > timestamp(ev.timestamp)) throw new Error('Invalid native assistant timestamp');
  }
  integer(totalTokens, 'aggregate');
  if (!totalTokens) throw new Error('zero token usage');
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('Unknown or nonfinite aggregate native fixed-tariff cost');
  if (typeof final.provider !== 'string' || !final.provider || typeof final.model !== 'string' || !final.model) throw new Error('Missing effective model/provider');
  const completedAt = timestamp(last.timestamp ?? final.timestamp);
  if (completedAt < startedAt) throw new Error('Native timestamp inversion');
  const productExecutions = events.filter(e => e.type === 'custom' && e.customType === 'workflow-product-execution').map(e => e.data);
  if (role === 'oracle' && !productExecutions.length) throw new Error('Oracle lacks actual native product execution');
  for (const execution of productExecutions) {
    assertProductExecutionInvariant({
      execution,
      productCommandHash: context.productCommandHash,
      sourceDigest: context.sourceDigest,
      startedAt,
      completedAt,
      verdict: extractVerdict(role, report).verdict,
    });
  }
  return { context, productExecutions, sessionId: sessions[0].id, provider: final.provider, model: final.model, isFallback: events.some(e => e.type === 'model_change' && e.isFallback), usage: { input, output, cacheRead, cacheWrite, totalTokens, costUsd, costSource: 'native-fixed-tariff' }, report, stopReason: final.stopReason, startedAt, completedAt, ...extractVerdict(role, report) };
}
function buildPrompt(root, changeId, role, baseRef, productCommand) {
  const roleBody = readFileSync(resolveRoleDefinition(root, role), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const manifest = readFileSync(safeFile(root, join('openspec', 'changes', changeId, 'manifest.md')), 'utf8');
  let context = '';
  if (role === 'reviewer') {
    const snapshot = scanWorktree(root);
    const paths = Object.keys(snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files).filter(p => !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p));
    const changed = baseRef ? git(root, ['diff', '--name-only', '-z', baseRef, '--', '.']).split('\0').filter(p => p && !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p)) : [];
    const untracked = Object.keys(snapshot.untracked || {}).filter(p => !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p));
    const relevant = baseRef ? [...new Set([...changed, ...untracked])] : paths;
    context = `\n## Baseline revision\n${baseRef || 'Non-git or working tree root'}\n## Changed source paths (${relevant.length} files)\n${relevant.sort().join('\n')}\n## Available product paths (${paths.length} files)\nQuery full path catalogue on demand via inspect_product with [{path:'', kind:'source', offset:0}].\nUse inspect_product with batch requests: [{path, kind:'diff'|'source', offset:0}]. When nextOffset is not null, follow continuations to inspect the complete content before reaching your verdict.`;
  }
  const exerciseInstruction = productCommand
    ? `Use exercise_product with {offset:0} to run the operator-authorized consumer command once: ${JSON.stringify(productCommand)}. Read its bounded product-output pages by calling exercise_product with {offset:nextOffset} until nextOffset is null; continuations never rerun the command. Concatenate page text in byte-offset order to recover the complete JSON containing cwd, exitCode, stdout and stderr; contentHash binds all output bytes to the native execution event. Follow product-output pages, not artifact URIs. Incomplete or failed execution evidence is not PASS.`
    : 'No operator consumer command was provided; do not invoke exercise_product.';
  const terminalContract = role === 'reviewer'
    ? 'Your ENTIRE final assistant response MUST be a single valid JSON object (no Markdown headings, prose, or text before or after the JSON) containing findings, overall_correctness ("correct" or "incorrect"), overall_explanation (non-empty string including all R## requirement results and lean/simplification observations), and overall_confidence_score (0..1).'
    : 'Report all requirement results, preserve negative findings, and finish with an explicit Verdict: ACCEPT or Verdict: REJECT.';
  return `${roleBody}\n\n# ${role === 'oracle' ? 'Blind product acceptance' : 'Implementation review'}\nChange: ${changeId}\n## Original manifest\n${manifest}${context}\nUse inspect_product to read relevant implementation and consumer files in bounded batches; follow all page continuations until complete. Oracle planning documents are inaccessible. ${exerciseInstruction} ${terminalContract}`;
}
function atomicJson(file, data, temporary = `${file}.${randomUUID()}.tmp`) {
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temporary, { force: true }); }
}
function saveRun(file, run) {
  // Raw native bytes plus the original projection hash are sufficient; do not duplicate reports.
  const metadata = { ...run };
  delete metadata.record;
  if (Buffer.byteLength(JSON.stringify(metadata)) > 128 * 1024) throw new Error('Retained run metadata exceeds 128 KiB');
  atomicJson(file, metadata);
}
function statePath(root, path) {
  validateRootPath(root);
  const full = resolve(root, path), scope = resolve(root);
  if (!isPathInsideRoot(scope, full) || !validatePathWithinScope(full, scope)) throw new Error('Retained review state escapes workspace');
  for (let current = full; current !== scope; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Retained review state cannot use a link/junction'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
function readBounded(file, maximum) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid/oversized retained review file');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size !== stat.size) throw new Error('Retained review file changed while reading');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
function loadRun(root, sessionDir, changeId) {
  const runs = statePath(root, '.workflow/review-runs');
  const directory = statePath(root, sessionDir);
  if (dirname(directory) !== runs) throw new Error('Resume requires an original .workflow/review-runs/run-* directory');
  const run = JSON.parse(readBounded(statePath(root, join(directory, 'run.json')), 128 * 1024));
  if (run.schemaVersion !== 1 || run.runId !== basename(directory) || run.workspace !== realpathSync(root) || run.changeId !== changeId || !run.provenance) throw new Error('Retained run identity/workspace mismatch');
  return { directory, run };
}
function reviewIdentity(options, previous) {
  const { root, changeId, role, productCommand = null, ompRunner, dryRun, redo, resumeSessionDir } = options;
  const dir = changeDirectory(root, changeId), data = loadReviewEvidence(dir);
  if (!data && existsSync(join(dir, EVIDENCE_FILE))) throw new Error('Malformed review evidence: hold for operator reconciliation');
  const evidence = data || { version: 2, changeId, reviewer: null, stageB: null, oracles: [], history: [] };
  if (evidence.version !== 2 || evidence.changeId !== changeId || !Array.isArray(evidence.oracles) || !Array.isArray(evidence.history || [])) throw new Error('Malformed review evidence: hold for operator reconciliation');
  evidence.history ||= [];
  const errors = [];
  let baseRef = options.baseRef || previous?.provenance.baseRef || evidence.reviewer?.baseRef;
  try { if (baseRef || (!ompRunner && !resumeSessionDir)) baseRef = resolveBase(root, baseRef); }
  catch (error) { if (!dryRun) throw error; errors.push(error.message); baseRef = null; }
  const source = sourceDigest(root), tests = testFilesHash(root);
  if (role === 'oracle' && (!evidence.stageB || evidence.stageB.sourceDigestAfter !== source || !evidence.stageB.executedAt)) errors.push('earlier reviewer record is stale or completed Stage-B outcome required');
  if (role === 'reviewer' && evidence.reviewer && !redo && !resumeSessionDir) errors.push('Existing review cycle requires intentional reviewer --redo');
  const prompt = buildPrompt(root, changeId, role, baseRef, productCommand);
  const provenance = { role, sourceDigest: source, manifestHash: computeManifestHash(root, changeId), rolePromptHash: computeRolePromptHash(root, role), testFilesHash: tests, baseRef: baseRef || null, requestedModel: options.model || null, promptHash: computeEventProjectionHash(prompt), productCommandHash: computeEventProjectionHash(productCommand) };
  return { dir, data: evidence, errors, prompt, provenance };
}
function projectRecord(text, provenance, role) {
  const retained = nativeEvents(text), parsed = projectNative(retained, role);
  const requestedModel = provenance.requestedModel || `${parsed.provider}/${parsed.model}`;
  if (requestedModel !== `${parsed.provider}/${parsed.model}`) throw new Error(`effective model mismatch: requested '${requestedModel}', got '${parsed.provider}/${parsed.model}'`);
  if (computeEventProjectionHash(parsed.context) !== computeEventProjectionHash(provenance)) throw new Error('Native review context differs from dispatched request');
  const nativeProjection = { role, ...parsed, requestedModel, sourceDigest: provenance.sourceDigest, manifestHash: provenance.manifestHash, rolePromptHash: provenance.rolePromptHash, testFilesHash: provenance.testFilesHash, baseRef: provenance.baseRef, exitCode: 0 };
  return { ...nativeProjection, nativeProjection, nativeEvents: retained, nativeEventsHash: computeEventProjectionHash(retained), eventProjectionHash: computeEventProjectionHash(nativeProjection) };
}
/** Controlled-HTTP projection lives in review/http-evidence.mjs (strong re-projection). */
function completeRun(options, identity) {
  const { root, changeId, role, model, productCommand = null, ompRunner, httpExecutor = null, policy = null } = options;
  // Injected runners are parser/consumer fixtures, never an admitted transport.
  if (typeof ompRunner !== 'function' && !httpExecutor) throw new Error('Unsupported native execution boundary; no model dispatch');
  // Check retained candidate scan and matching completed work BEFORE allocating directories.
  const candidates = retainedCandidates(root, changeId, identity.provenance);
  if (!options.resumeSessionDir && candidates.some(row => row.status === 'held' && !row.sessionDir)) {
    throw new Error('More than 256 retained runs; select an explicit --resume-session directory for bounded inspection');
  }
  const retained = candidates.filter(row => row.status === 'completed' && row.identityMatches);
  if (retained.length && !options.resumeSessionDir && !options.redo) {
    throw new Error(`A completed retained run already matches this exact review contract (${retained.map(row => row.sessionDir).join(', ')}). Refusing to buy another identical run: re-run with explicit --resume-session DIR to publish the retained evidence, or --redo with fresh financial authority to start a new cycle.`);
  }
  const runs = statePath(root, '.workflow/review-runs');
  mkdirSync(runs, { recursive: true });
  const directory = mkdtempSync(join(runs, 'run-'));
  const file = join(directory, 'run.json'), transcript = join(directory, 'native.jsonl');
  const run = { schemaVersion: 1, runId: basename(directory), workspace: realpathSync(root), changeId, provenance: identity.provenance, productCommand, status: 'running', exitCode: null };
  saveRun(file, run);
  let reservationId = null;
  try {
    const runner = httpExecutor ? invocation => httpExecutor.run(invocation) : ompRunner;
    if (httpExecutor) {
      const admitted = admitSession({ root, policy });
      reservationId = admitted.reservationId;
    }
    const result = runner({ root, role, prompt: identity.prompt, model, sessionDir: directory, provenance: identity.provenance, changeId, productCommand, policy, reservationId, endpoint: httpExecutor?.endpoint || null });
    if (httpExecutor) {
      // Retained run metadata carries the engine identity so resume imports the SAME execution.
      run.executor = EXECUTOR;
      // The brand is recorded so a resumed run re-projects with the SAME eligibility.
      run.executorBranded = isBrandedExecutor(httpExecutor);
      run.endpoint = httpExecutor.endpoint;
      try { run.executionId = JSON.parse(result.stdout || '{}').executionId || null; } catch { run.executionId = null; }
      saveRun(file, run);
    }
    run.exitCode = Number.isSafeInteger(result?.status) ? result.status : null;
    if (run.exitCode !== 0) {
      // Surface the child's own refusal reason (redacted) instead of a bare exit code.
      let reason = '';
      try { reason = String(JSON.parse(result.stdout || '{}').reason || ''); } catch { reason = ''; }
      throw new Error(`runner exited with code ${run.exitCode}${reason ? `: ${redactSecret(reason, process.env.OPENAI_API_KEY)}` : ''}`);
    }
    const text = result.stdout || result.transcriptText || '';
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Missing/oversized native transcript');
    if (existsSync(transcript)) {
      if (readBounded(statePath(root, transcript), 32 * 1024 * 1024) !== text) throw new Error('Native transcript differs from completed runner output');
    } else writeFileSync(transcript, text, { flag: 'wx', mode: 0o600 });
    const fd = openSync(transcript, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    run.transcriptHash = createHash('sha256').update(text).digest('hex');
    if (sourceDigest(root) !== identity.provenance.sourceDigest) throw new Error('source tree was mutated during review session (read-only execution violated)');
    run.record = httpExecutor ? projectHttpRecord({ text, provenance: identity.provenance, role, executorBranded: isBrandedExecutor(httpExecutor), root, endpoint: httpExecutor.endpoint }) : projectRecord(text, identity.provenance, role);
    run.recordHash = computeEventProjectionHash(run.record);
    run.status = 'completed';
    saveRun(file, run);
    // Settle only trustworthy observed usage, priced at the reservation's captured tariff.
    if (reservationId) {
      const usage = run.record.usage;
      const settled = settleReservation({ root, reservationId, usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } });
      run.settledNanoUsd = settled.settledNanoUsd;
      saveRun(file, run);
    }
    return { directory, run };
  } catch (error) {
    // Unknown, failed or cancelled spend stays held and blocks fresh admission.
    if (reservationId) {
      try { holdReservation({ root, reservationId, reason: error.message }); }
      catch { /* the reservation is already settled or held; never rewrite known state */ }
    } else if (httpExecutor) {
      // No reservation was ever obtained and no runner was dispatched, so this run directory is
      // fresh, empty and ours: removing it keeps a refused admission from consuming one of the
      // bounded candidate slots forever. A paid or historical run always carries a reservationId
      // on this path and is never reached here. If removal fails the run is retained below.
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* retained for operator inspection */ }
      if (!existsSync(directory)) {
        throw new Error(`${sanitizeError(redactSecret(error.message, process.env.OPENAI_API_KEY))} [no session retained: admission was refused before dispatch]`);
      }
    }
    run.status = 'failed'; run.reason = sanitizeError(redactSecret(error.message, process.env.OPENAI_API_KEY));
    saveRun(file, run);
    throw new Error(`${run.reason} [retained session: ${directory}]`);
  }
}
function resumeRun(root, pending, identity, role) {
  const { directory, run } = pending;
  if (run.status === 'published') throw new Error('duplicate session: retained run already published');
  if (run.status !== 'completed' || run.exitCode !== 0 || typeof run.recordHash !== 'string') throw new Error('Cannot resume running, failed or incomplete native execution');
  if (computeEventProjectionHash(run.provenance) !== computeEventProjectionHash(identity.provenance)) throw new Error('Retained execution contract/context mismatch: source/tests/manifest/role/model/prompt/command changed');
  const path = statePath(root, join(directory, 'native.jsonl'));
  const text = readBounded(path, 32 * 1024 * 1024);
  if (createHash('sha256').update(text).digest('hex') !== run.transcriptHash) throw new Error('Retained transcript hash/integrity mismatch');
  // Re-project with the SAME projector that created the record, never a different one.
  const record = run.executor === EXECUTOR ? projectHttpRecord({ text, provenance: run.provenance, role, executorBranded: run.executorBranded === true, root, endpoint: run.endpoint }) : projectRecord(text, run.provenance, role);
  if (computeEventProjectionHash(record) !== run.recordHash) throw new Error('Retained native record hash/integrity mismatch');
  run.record = record;
  return pending;
}
function retainedCandidates(root, changeId, provenance) {
  const runs = statePath(root, '.workflow/review-runs');
  if (!existsSync(runs)) return [];
  const names = readdirSync(runs).filter(name => name.startsWith('run-'));
  if (names.length > 256) return [{ status: 'held', reason: 'More than 256 retained runs; select an explicit --resume-session directory for bounded inspection' }];
  return names.map(name => {
    const sessionDir = relative(resolve(root), join(runs, name));
    try {
      const { run } = loadRun(root, sessionDir, changeId);
      return { sessionDir, status: run.status, identityMatches: computeEventProjectionHash(run.provenance) === computeEventProjectionHash(provenance), requires: 'Explicit resume revalidates completion, transcript integrity and duplicate publication' };
    } catch (error) { return { sessionDir, status: 'held', reason: sanitizeError(error.message) }; }
  });
}
// A controlled-HTTP record has an executionId and no sessionId; either identifies one run.
function recordKey(record) { return record?.sessionId ?? record?.executionId ?? null; }
function historySessions(data) { return [...(data.history || []).flatMap(c => [c.reviewer, ...(c.oracles || [])]), data.reviewer, ...(data.oracles || [])].filter(Boolean).map(recordKey); }
export function runReviewRecord(options) {
  const { root = '.', changeId, role, model, ompRunner = null, dryRun = false, redo = false, productCommand = null, resumeSessionDir = null, httpExecutor = null } = options;
  if (!['reviewer', 'oracle'].includes(role)) throw new Error('--role must be reviewer or oracle');
  if (options.prompt !== undefined) throw new Error('--prompt bypass is forbidden; roles and manifest are mandatory');
  if (!ompRunner && !httpExecutor && (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model))) throw new Error('Exact --model provider/model selector required');
  if (productCommand !== null && (!Array.isArray(productCommand) || !productCommand.length || productCommand.some(p => typeof p !== 'string' || p.includes('\0')) || !productCommand[0].trim())) throw new Error('product-command must be a JSON argv array');
  if (role === 'oracle' && !ompRunner && !productCommand) throw new Error('Oracle requires --product-command JSON argv to exercise product');
  if (resumeSessionDir !== null && (typeof resumeSessionDir !== 'string' || !resumeSessionDir || redo)) throw new Error('Explicit resume-session directory required; resume is not --redo');
  // Resuming already-paid work reuses the original captured contract and needs no key.
  // Spending authority is validated for every dispatch path. A dry run READS the policy
  // and the existing ledger read-only so the operator sees the real reserve, route and
  // remaining headroom; it funds nothing, locks nothing and writes nothing.
  let policy = null;
  if (httpExecutor || (dryRun && options.admissionPolicy)) {
    policy = readAdmissionPolicy(root, options.admissionPolicy);
    if (httpExecutor) {
      // The policy fixes the verified official route; the executor declares where bytes
      // actually go and approves its own effective route (a loopback seam is explicit).
      if (typeof httpExecutor.approveEndpoint !== 'function' || !httpExecutor.approveEndpoint(httpExecutor.endpoint)) throw new Error('Effective transport route is not approved by the supplied executor');
      if (model !== `${policy.provider}/${policy.model}`) throw new Error(`Requested model '${model}' is not the admitted pinned snapshot '${policy.provider}/${policy.model}'`);
      if (!resumeSessionDir && typeof process.env.OPENAI_API_KEY !== 'string') throw new Error('OPENAI_API_KEY is required at the dispatch boundary; no credential means no dispatch');
    }
  }
  const normalized = { ...options, root, productCommand, resumeSessionDir, httpExecutor, policy };
  if (dryRun) {
    const pending = resumeSessionDir ? loadRun(root, resumeSessionDir, changeId) : null;
    const identity = reviewIdentity(normalized, pending?.run);
    let resumeCompatible = false;
    if (pending) {
      try { resumeRun(root, pending, identity, role); resumeCompatible = true; }
      catch (error) { identity.errors.push(error.message); }
    }
    return { ok: true, dryRun: true,
      admission: { ...inspectAdmission({ policy, policyPath: options.admissionPolicy, root }),
        ...(policy ? { reserveNanoUsd: policy.reserveNanoUsd, reserveUsd: nanoUsdToUsd(policy.reserveNanoUsd),
          ceilingNanoUsd: policy.ceilingNanoUsd, maxRequests: policy.maxRequests, model: policy.model,
          contextWindowTokens: PINNED_CONTEXT_TOKENS, maxOutputTokens: policy.maxOutputTokens } : {}) },
      budget: inspectBudget({ root, policy }),
      provenance: identity.provenance, prerequisites: identity.errors,
      releaseGate: validateReviewEvidence({ root, changeId, tier: 'T2' }), resumeCompatible,
      retainedRuns: retainedCandidates(root, changeId, identity.provenance),
      obligations: 'Dry-run only: no child and no provider request. Resume imports original matching completed evidence; it never reruns, retags or overrides a verdict.' };
  }
  const lock = statePath(root, '.workflow/review-record.lock');
  mkdirSync(dirname(lock), { recursive: true });
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const pending = resumeSessionDir ? loadRun(root, resumeSessionDir, changeId) : null;
    const identity = reviewIdentity(normalized, pending?.run);
    if (identity.errors.length) throw new Error(identity.errors.join('; '));
    const completed = pending ? resumeRun(root, pending, identity, role) : completeRun(normalized, identity);
    const record = completed.run.record, data = identity.data;
    if (historySessions(data).includes(recordKey(record))) throw new Error('duplicate session ID across review records');
    if (role === 'reviewer') {
      if (data.reviewer) data.history.push({ reviewer: data.reviewer, stageB: data.stageB, oracles: data.oracles });
      data.reviewer = record; data.stageB = null; data.oracles = [];
      if (redo) data.supersededArtifacts = readdirSync(identity.dir).filter(isOracleEvidenceFilename).map(p => ({ path: p, hash: hashFile(safeFile(identity.dir, p)) }));
    } else data.oracles.push(record);
    try { saveReviewEvidence(identity.dir, data); }
    catch (error) { throw new Error(`${sanitizeError(error.message)} [retained session: ${completed.directory}; use explicit --resume-session after resolving publication]`); }
    completed.run.status = 'published';
    saveRun(join(completed.directory, 'run.json'), completed.run);
    return { ok: true, record, sessionDir: completed.directory };
  } finally { closeSync(fd); unlinkSync(lock); }
}
function resolveTestTimeoutMs(options = {}) {
  const rawMs = options.testTimeoutMs;
  if (rawMs === undefined || rawMs === null) return 120000;
  if (typeof rawMs !== 'number' || !Number.isSafeInteger(rawMs) || rawMs < 1 || rawMs > 3600000) {
    throw new Error('Stage-B testTimeoutMs (--test-timeout 1..3600s) must be a safe integer between 1 and 3600000ms');
  }
  return rawMs;
}
function executeTests(root, testCmd, testRunner, timeoutMs = 120000) {
  const startedMs = Date.now();
  const result = testRunner ? testRunner(testCmd, { timeoutMs }) : spawnSync(testCmd, { cwd: root, encoding: 'utf8', shell: true, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const elapsedMs = Date.now() - startedMs;
  if (result.error || result.status !== 0) {
    const combinedOut = sanitizeError(`${result.stdout || ''}${result.stderr || ''}`);
    let logPath = null;
    try {
      const logDir = join(resolve(root), '.tmp');
      mkdirSync(logDir, { recursive: true });
      logPath = join(logDir, `stage-b-failed-${Date.now()}-${process.pid}.log`);
      writeFileSync(logPath, combinedOut, 'utf8');
    } catch {}
    const errCode = result.error?.code || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
    const err = new Error(`Stage-B frozen test suite failed with exit code ${result.status} (${errCode}, elapsed ${elapsedMs}ms, deadline ${timeoutMs}ms)${logPath ? ` [retained output: ${logPath}]` : ''}`);
    err.exitCode = result.status;
    err.errorCode = result.error?.code || null;
    err.signal = result.signal || null;
    err.elapsedMs = elapsedMs;
    err.timeoutMs = timeoutMs;
    err.logPath = logPath;
    throw err;
  }
  return { exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, elapsedMs, timeoutMs };
}
export function recordStageB(options) {
  const { root = '.', changeId, phase = 'after', disposition = 'lean-already', testCmd, summary = '', testRunner = null } = options;
  if (!testCmd || !['before', 'after'].includes(phase) || !['lean-already', 'simplified'].includes(disposition)) throw new Error('Stage-B requires before|after, test-cmd, and lean-already|simplified disposition');
  const timeoutMs = resolveTestTimeoutMs(options);
  const dir = changeDirectory(root, changeId), data = loadReviewEvidence(dir);
  if (data?.reviewer?.verdict !== 'ACCEPT') throw new Error('implementation reviewer ACCEPT record required before Stage-B');
  if (data.oracles?.some(o => o.verdict === 'REJECT')) throw new Error('Negative oracle evidence requires intentional reviewer --redo before Stage-B');
  const reviewer = data.reviewer, source = sourceDigest(root), tests = testFilesHash(root);
  if (tests !== reviewer.testFilesHash) throw new Error('frozen test files were modified since Stage-A/reviewer');
  if (phase === 'before' && source !== reviewer.sourceDigest) throw new Error('Stage-B before must run on reviewer source A');
  if (phase === 'after' && !data.stageB?.before && (disposition !== 'lean-already' || source !== reviewer.sourceDigest)) throw new Error('Stage-B before execution on A is required before simplification');
  if (phase === 'after' && !data.stageB?.before) {
    recordStageB({ ...options, phase: 'before', testTimeoutMs: timeoutMs });
    return recordStageB({ ...options, testTimeoutMs: timeoutMs });
  }
  const startedAt = new Date().toISOString();
  const result = executeTests(root, testCmd, testRunner, timeoutMs);
  if (testFilesHash(root) !== tests) throw new Error('frozen test files were modified during Stage-B run');
  if (sourceDigest(root) !== source) throw new Error('Test execution mutated product source');
  const execution = { sourceDigest: source, testFilesHash: tests, testCmd, startedAt, completedAt: new Date().toISOString(), ...result };
  if (data.oracles?.length) data.history.push({ reviewer: null, stageB: data.stageB, oracles: data.oracles });
  data.oracles = [];
  // Stage-B binds to the reviewer's explicit identity: HTTP records have an executionId
  // and no sessionId, so an undefined-vs-undefined comparison must never pass.
  const reviewerKey = recordKey(reviewer);
  if (!reviewerKey) throw new Error('Reviewer record has no session/execution identity to bind Stage-B to');
  if (phase === 'before') data.stageB = { reviewerSessionId: reviewerKey, before: execution };
  else {
    const before = data.stageB.before;
    if (before.testCmd !== testCmd || before.testFilesHash !== tests || before.sourceDigest !== reviewer.sourceDigest) throw new Error('Stage-B frozen before/after command or source mismatch');
    if ((disposition === 'lean-already') !== (source === reviewer.sourceDigest)) throw new Error('Stage-B disposition does not match actual source change');
    data.stageB = { reviewerSessionId: reviewerKey, before, after: execution, disposition, testCmd, exitCode: 0, testFilesHashBefore: tests, testFilesHashAfter: tests, sourceDigestBefore: before.sourceDigest, sourceDigestAfter: source, executedAt: execution.completedAt, summary };
  }
  saveReviewEvidence(dir, data);
  return { ok: true, stageB: data.stageB };
}

/**
 * The retained execution log for a record, so controlled-HTTP integrity is re-derived
 * from original bytes rather than from the record's own outer claims. Native records
 * carry their events inline and need no lookup.
 */
function retainedTranscript(root, record) {
  if (!record || record.executor !== EXECUTOR) return null;
  const runs = statePath(root, '.workflow/review-runs');
  if (!existsSync(runs)) return null;
  for (const name of readdirSync(runs)) {
    const candidate = join(runs, name, 'run.json');
    if (!existsSync(candidate)) continue;
    try {
      const run = JSON.parse(readBounded(candidate, 128 * 1024));
      if (run.executionId === record.executionId && typeof run.transcriptHash === 'string') {
        const text = readBounded(join(runs, name, 'native.jsonl'), 32 * 1024 * 1024);
        if (createHash('sha256').update(text).digest('hex') !== run.transcriptHash) return null;
        return text;
      }
    } catch { /* unreadable retained run cannot vouch for a record */ }
  }
  return null;
}
function validateRecord(record, role, current, errors, root, text = null) {
  if (record?.executor === EXECUTOR) return validateHttpRecord({ record, role, current, errors, root, text });
  try {
    if (!record || record.role !== role || record.exitCode !== 0) throw new Error('Missing or failed role execution');
    if (!record.nativeProjection || record.eventProjectionHash !== computeEventProjectionHash(record.nativeProjection) || record.nativeEventsHash !== computeEventProjectionHash(record.nativeEvents)) throw new Error('Native projection/events integrity mismatch');
    const parsed = projectNative(record.nativeEvents, role);
    const expected = { role, ...parsed, requestedModel: record.requestedModel, sourceDigest: record.sourceDigest, manifestHash: record.manifestHash, rolePromptHash: record.rolePromptHash, testFilesHash: record.testFilesHash, baseRef: record.baseRef, exitCode: record.exitCode };
    const context = parsed.context;
    for (const key of ['role', 'sourceDigest', 'manifestHash', 'rolePromptHash', 'testFilesHash', 'baseRef']) if (record[key] !== context[key]) throw new Error(`Native context ${key} mismatch`);
    if (context.requestedModel !== null && context.requestedModel !== record.requestedModel) throw new Error('Native requested model mismatch');
    if (computeEventProjectionHash(expected) !== record.eventProjectionHash) throw new Error('Native re-projection mismatch');
    for (const key of Object.keys(expected)) if (JSON.stringify(record[key]) !== JSON.stringify(expected[key])) throw new Error(`Outer acceptance field ${key} differs from native projection`);
    if (record.requestedModel !== `${parsed.provider}/${parsed.model}`) throw new Error('effective model mismatch');
    if (record.verdict !== 'ACCEPT') throw new Error(`REJECT verdict in ${record.sessionId}`);
    if (record.manifestHash !== current.manifestHash) throw new Error('manifest hash mismatch');
    if (record.rolePromptHash !== current[`${role}PromptHash`]) throw new Error('role prompt hash mismatch');
    if (record.testFilesHash !== current.tests) throw new Error('Frozen Stage-A tests mismatch');
  } catch (error) { errors.push(`review-evidence: ${role}: ${error.message}`); }
}
export function validateReviewEvidence({ root = '.', changeId, tier, baseRef = null }) {
  if (!['T2', 'T3'].includes(tier)) return { ok: true, errors: [] };
  const errors = [];
  try {
    const dir = changeDirectory(root, changeId), data = loadReviewEvidence(dir);
    if (!data) return { ok: false, errors: ['missing review execution evidence (static ACCEPT markdown alone is not accepted)'] };
    if (data.version !== 2 || data.changeId !== changeId) errors.push('Invalid evidence schema or changeId');
    const current = { manifestHash: computeManifestHash(root, changeId), reviewerPromptHash: computeRolePromptHash(root, 'reviewer'), oraclePromptHash: computeRolePromptHash(root, 'oracle'), source: sourceDigest(root), tests: testFilesHash(root), model: null };
    // The pinned snapshot is a single verified model, so any recorded execution must match it.
    current.model = data.reviewer?.model ?? data.reviewer?.requestedModel?.split('/').slice(1).join('/') ?? null;
    validateRecord(data.reviewer, 'reviewer', current, errors, root, retainedTranscript(root, data.reviewer));
    const sb = data.stageB, reviewer = data.reviewer;
    // Bind Stage-B to the reviewer's explicit identity; HTTP records have an executionId
    // and no sessionId, and `undefined === undefined` must never pass this check.
    if (!sb?.before || !sb?.after || !sb.executedAt || !sb.testCmd || sb.exitCode !== 0 || !recordKey(reviewer) || sb.reviewerSessionId !== recordKey(reviewer)) errors.push('Missing or invalid Stage-B disposition execution');
    else {
      for (const e of [sb.before, sb.after]) {
        if (e.exitCode !== 0 || e.testCmd !== sb.testCmd || e.testFilesHash !== current.tests || timestamp(e.completedAt) < timestamp(e.startedAt)) errors.push('Invalid frozen Stage-B execution');
      }
      if (sb.before.sourceDigest !== reviewer.sourceDigest || sb.sourceDigestBefore !== reviewer.sourceDigest || sb.after.sourceDigest !== current.source || sb.sourceDigestAfter !== current.source) errors.push('Source digest chain reviewer -> Stage-B -> current is broken');
      if (sb.testFilesHashBefore !== current.tests || sb.testFilesHashAfter !== current.tests) errors.push('Stage-B frozen tests modified');
      if (!['lean-already', 'simplified'].includes(sb.disposition) || (sb.disposition === 'lean-already') !== (sb.sourceDigestBefore === sb.sourceDigestAfter)) errors.push('Invalid Stage-B source disposition');
      if (timestamp(sb.before.startedAt) < timestamp(reviewer.completedAt) || timestamp(sb.after.startedAt) < timestamp(sb.before.completedAt) || timestamp(sb.executedAt) !== timestamp(sb.after.completedAt)) errors.push('Stage-B timestamp inversion');
    }
    const oracles = data.oracles || [];
    if (!Array.isArray(oracles) || !oracles.length) errors.push('Missing independent oracle acceptance record(s)');
    const historical = (data.history || []).flatMap(c => [c.reviewer, ...(c.oracles || [])]).filter(Boolean);
    const sessions = new Set(historical.map(recordKey));
    if (sessions.has(recordKey(reviewer))) errors.push('duplicate reviewer session ID reused from prior cycle');
    sessions.add(recordKey(reviewer));
    for (const oracle of oracles) {
      validateRecord(oracle, 'oracle', current, errors, root, retainedTranscript(root, oracle));
      if (sessions.has(recordKey(oracle))) errors.push('duplicate session ID across review records');
      sessions.add(recordKey(oracle));
      if (oracle.sourceDigest !== current.source) errors.push('Oracle source digest is stale');
      if (oracle.baseRef !== reviewer?.baseRef) errors.push('Oracle review baseline mismatch');
    }
    const lite = countSourceChanges(root, baseRef || reviewer?.baseRef).isOracleLite;
    if (oracles.some(o => isFlashOrFallback(o.model, o.provider, o.isFallback)) && !lite && oracles.length < 2) errors.push('flash/fallback oracle requires at least 2 distinct independent sessions beyond proven Oracle-lite');
  } catch (error) { errors.push(`review-evidence: ${error.message}`); }
  return { ok: !errors.length, errors };
}
export function isSupersededOracleArtifact(changeDir, path) {
  const data = loadReviewEvidence(changeDir);
  return data?.supersededArtifacts?.some(a => a.path === basename(path) && a.hash === hashFile(path)) || false;
}
export function toRootRelative(root, path) {
  return relative(resolve(root), resolve(path)).replace(/\\/g, "/");
}
export function validateOracleArtifact(root, artifact, state, invalid) {
  if (!isPositiveOracleVerdict(artifact.detail)) invalid.push('oracle: expected explicit ACCEPT verdict');
  const rel = state.artifacts?.openspec?.path;
  if (!rel || !isRealPathInsideRoot(root, rel)) { invalid.push('oracle: missing rooted change'); return; }
  const dir = join(root, rel);
  const resolvedDir = resolve(dir);
  const resolvedArtifact = artifact.path ? resolve(root, artifact.path) : null;
  if (resolvedArtifact && relative(resolvedDir, resolvedArtifact).startsWith('..')) invalid.push('oracle: explicit evidence path belongs to another change');
  const paths = readdirSync(resolvedDir).filter(isOracleEvidenceFilename).map(p => resolve(resolvedDir, p));
  if (resolvedArtifact && !paths.includes(resolvedArtifact)) paths.push(resolvedArtifact);
  let positive = false;
  for (const path of paths) {
    const displayPath = toRootRelative(root, path);
    if (!isRealPathInsideRoot(root, path) || !statSync(path).isFile()) { invalid.push(`oracle: file '${displayPath}' resolves outside project root or is not a file`); continue; }
    const text = readFileSync(path, 'utf8');
    if (isNegativeOracleVerdict(text) && !isSupersededOracleArtifact(resolvedDir, path)) invalid.push(`oracle: verdict in '${displayPath}' is REJECT`);
    if (isPositiveOracleVerdict(text) && dirname(resolve(path)) === resolvedDir) positive = true;
  }
  const native = loadReviewEvidence(resolvedDir);
  if (!positive && !native?.oracles?.length) invalid.push('oracle: missing oracle evidence file (oracle*.md or acceptance.md)');
}
