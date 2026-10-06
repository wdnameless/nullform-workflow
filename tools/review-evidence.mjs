import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashFile, sourceDigest, testFilesHash, scanWorktree, isAcceptancePath, isAcceptanceArtifactFilename, isStructuralExcludedPath, isSecretOrCredentialPath, isRealPathInsideRoot } from './worktree-snapshot.mjs';

export const EVIDENCE_FILE = 'review-evidence.json';
export const POSITIVE_VERDICT_RE = /(?:^|\r?\n)\s*(?:(?:#+\s*)?(?:\*{0,2}Verdict:?\*{0,2}:?\s*)?\*{0,2}ACCEPT\*{0,2}(?::|\s|$)|\|\s*\*{0,2}Verdict:?\*{0,2}:?\s*\|\s*\*{0,2}ACCEPT\*{0,2}\b)/im;
export const NEGATIVE_VERDICT_RE = /(?:^|\r?\n)\s*(?:(?:#+\s*)?(?:\*{0,2}Verdict:?\*{0,2}:?\s*)?\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)\s+ACCEPT(?:ED)?)\*{0,2}(?::|\s|$)|\|\s*\*{0,2}Verdict:?\*{0,2}:?\s*\|\s*\*{0,2}(?:REJECT(?:ED)?|(?:NOT|NON|UN|CANNOT|NEVER|NO)\s+ACCEPT(?:ED)?)\*{0,2}\b)/im;
export { isAcceptanceArtifactFilename, isStructuralExcludedPath, isSecretOrCredentialPath };
export const computeFileHash = hashFile;
export const computeSourceDigest = sourceDigest;
export const computeTestFilesHash = testFilesHash;
export function computeEventProjectionHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function isPositiveOracleVerdict(text) { return typeof text === 'string' && POSITIVE_VERDICT_RE.test(text) && !NEGATIVE_VERDICT_RE.test(text); }
export function isNegativeOracleVerdict(text) { return typeof text === 'string' && NEGATIVE_VERDICT_RE.test(text); }
export function isOracleEvidenceFilename(path) { return /^oracle(-+[a-z0-9]+)*\.md$/i.test(basename(String(path || ''))) || basename(String(path || '')).toLowerCase() === 'acceptance.md'; }
export function computeManifestHash(root, changeId) { return hashFile(join(changeDirectory(root, changeId), 'manifest.md')); }
export function computeRolePromptHash(root, role) { return hashFile(safeFile(root, join('agent', 'agents', `${role}.md`))); }
export function getPorcelainStatusRaw(root) {
  try { return git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '-uall', '--', '.']); } catch { return null; }
}
function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
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
  writeFileSync(join(changeDir, EVIDENCE_FILE), JSON.stringify(data, null, 2) + '\n');
}
export function isFlashOrFallback(model, provider, fallback) { return Boolean(fallback) || /flash|haiku|mini|nano|lite|fallback/i.test(`${provider} ${model}`); }
function resolveBase(root, baseRef) {
  if (!baseRef || typeof baseRef !== 'string' || baseRef.startsWith('-')) throw new Error('review-run: explicit --base-ref or recorded cycle baseline required');
  return git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim();
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
function extractVerdict(role, text) {
  if (role === 'reviewer') {
    let report;
    try { report = JSON.parse(text.replace(/^```json\s*\n([\s\S]*?)\n```\s*$/i, '$1')); } catch { throw new Error('Reviewer final report must be complete typed JSON'); }
    if (!report || !Array.isArray(report.findings) || !['correct', 'incorrect'].includes(report.overall_correctness) || typeof report.overall_explanation !== 'string' || !report.overall_explanation.trim() || !Number.isFinite(report.overall_confidence_score) || report.overall_confidence_score < 0 || report.overall_confidence_score > 1) throw new Error('Reviewer final report has invalid findings/correctness schema');
    if (report.findings.some(f => !f || typeof f.title !== 'string' || !f.title.trim() || typeof f.body !== 'string' || !f.body.trim()
      || !Number.isInteger(f.priority) || f.priority < 0 || f.priority > 3 || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1
      || typeof f.file_path !== 'string' || !f.file_path.trim() || !Number.isSafeInteger(f.line_start) || f.line_start < 1 || !Number.isSafeInteger(f.line_end) || f.line_end < f.line_start)) throw new Error('Reviewer final report has invalid typed findings');
    return { verdict: report.overall_correctness === 'correct' ? 'ACCEPT' : 'REJECT', nativeVerdict: report.overall_correctness };
  }
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
  if (!Number.isFinite(costUsd) || costUsd <= 0) throw new Error('Unknown or nonfinite aggregate native fixed-tariff cost');
  if (typeof final.provider !== 'string' || !final.provider || typeof final.model !== 'string' || !final.model) throw new Error('Missing effective model/provider');
  const completedAt = timestamp(last.timestamp ?? final.timestamp);
  if (completedAt < startedAt) throw new Error('Native timestamp inversion');
  const productExecutions = events.filter(e => e.type === 'custom' && e.customType === 'workflow-product-execution').map(e => e.data);
  if (role === 'oracle' && !productExecutions.length) throw new Error('Oracle lacks actual native product execution');
  for (const execution of productExecutions) {
    if (execution.commandHash !== context.productCommandHash || execution.sourceDigest !== context.sourceDigest || !Number.isSafeInteger(execution.exitCode) || execution.exitCode < 0 || typeof execution.outputHash !== 'string' || !/^[a-f0-9]{64}$/.test(execution.outputHash) || timestamp(execution.startedAt) < startedAt || timestamp(execution.completedAt) < timestamp(execution.startedAt) || timestamp(execution.completedAt) > completedAt) throw new Error('Invalid native product execution provenance');
    if (execution.exitCode !== 0 && extractVerdict(role, report).verdict === 'ACCEPT') throw new Error('ACCEPT despite failed product execution');
  }
  return { context, productExecutions, sessionId: sessions[0].id, provider: final.provider, model: final.model, isFallback: events.some(e => e.type === 'model_change' && e.isFallback), usage: { input, output, cacheRead, cacheWrite, totalTokens, costUsd, costSource: 'native-fixed-tariff' }, report, stopReason: final.stopReason, startedAt, completedAt, ...extractVerdict(role, report) };
}
function buildPrompt(root, changeId, role, baseRef, productCommand) {
  const roleBody = readFileSync(safeFile(root, join('agent', 'agents', `${role}.md`)), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const manifest = readFileSync(safeFile(root, join('openspec', 'changes', changeId, 'manifest.md')), 'utf8');
  let context = '';
  if (role === 'reviewer') {
    const snapshot = scanWorktree(root);
    const paths = Object.keys(snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files).filter(p => !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p));
    const changed = baseRef ? git(root, ['diff', '--name-only', '-z', baseRef, '--', '.']).split('\0').filter(p => p && !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p)) : [];
    const untracked = Object.keys(snapshot.untracked || {}).filter(p => !isStructuralExcludedPath(p) && !isSecretOrCredentialPath(p) && !isAcceptancePath(p));
    const relevant = baseRef ? [...new Set([...changed, ...untracked])] : paths;
    context = `\n## Baseline revision\n${baseRef || 'Non-git or working tree root'}\n## Changed source paths (${relevant.length} files)\n${relevant.sort().join('\n')}\n## Available product paths (${paths.length} files)\n${paths.sort().join('\n')}\nUse inspect_product with batch requests: [{path, kind:'diff'|'source', offset:0}]. When nextOffset is not null, follow continuations to inspect the complete content before reaching your verdict.`;
  }
  return `${roleBody}\n\n# ${role === 'oracle' ? 'Blind product acceptance' : 'Implementation review'}\nChange: ${changeId}\n## Original manifest\n${manifest}${context}\nUse inspect_product to read relevant implementation and consumer files in bounded batches; follow all page continuations until complete. Oracle planning documents are inaccessible. Use exercise_product to run the operator-authorized consumer command: ${JSON.stringify(productCommand)}. Report all requirement results, preserve negative findings, and finish with ${role === 'reviewer' ? 'complete JSON containing findings, overall_correctness (correct or incorrect), overall_explanation, and overall_confidence_score (0..1)' : 'an explicit Verdict: ACCEPT or Verdict: REJECT'}.`;
}
function isRunnableCli(file) {
  if (!file || typeof file !== 'string' || !existsSync(file)) return false;
  const scopedDir = dirname(dirname(dirname(file)));
  if (basename(scopedDir) === '@oh-my-pi' && !existsSync(join(scopedDir, 'pi-natives'))) return false;
  return true;
}
function cliPath() {
  const explicit = process.env.OMP_CLI_PATH;
  if (explicit) {
    if (!isRunnableCli(explicit)) throw new Error(`OMP_CLI_PATH points to invalid or incomplete CLI: ${explicit}`);
    return realpathSync(explicit);
  }
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const ompDirs = dirs.filter(p => ['omp', 'omp.cmd', 'omp.exe'].some(b => existsSync(join(p, b))));
  const orderedDirs = [...new Set([...ompDirs, ...dirs])];
  const candidates = orderedDirs.flatMap(p => [join(p, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'), join(p, '..', 'lib', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js')]);
  const found = candidates.find(isRunnableCli);
  if (!found) throw new Error('Installed OMP CLI not found; set OMP_CLI_PATH to dist/cli.js');
  return realpathSync(found);
}
function redactSensitive(text, maxLen = 4000) {
  if (!text || typeof text !== 'string') return '';
  const redacted = text
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._~+/-]*/g, '[REDACTED_JWT]')
    .replace(/(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/-----BEGIN[ A-Z_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z_-]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/(?:sk-[A-Za-z0-9_-]{8,})/gi, 'sk-[REDACTED]')
    .replace(/(?:ghp_[A-Za-z0-9]{20,})/gi, 'ghp_[REDACTED]')
    .replace(/(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URI]')
    .replace(/((?:key|token|auth|password|secret|credential|api_key|apikey)[=:]\s*["']?)[A-Za-z0-9._~+/-]{8,}(["']?)/gi, '$1[REDACTED]$2');
  const trimmed = redacted.trim();
  return trimmed.length > maxLen ? trimmed.slice(-maxLen) : trimmed;
}
function invokeNative(root, prompt, model, sessionDir, options, runner) {
  if (runner) {
    const result = runner({ root, prompt, model, sessionDir, provenance: options.provenance, changeId: options.changeId, productCommand: options.productCommand });
    if (result.status !== 0) throw new Error(`runner exited with code ${result.status}`);
    return result.stdout || result.transcriptText || '';
  }
  const extension = fileURLToPath(new URL('./review-native-tools.mjs', import.meta.url));
  // Bounded 10-minute allowance accommodates multi-turn on-demand product inspection roundtrips.
  const args = [cliPath(), '--mode', 'json', '--print', '--session-dir', sessionDir, '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--trusted-extension', extension, '--tools', 'inspect_product,exercise_product', '--model', model, '--max-time', '600'];
  const result = spawnSync('bun', args, { cwd: root, input: prompt, encoding: 'utf8', shell: false, windowsHide: true, timeout: 610000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, WORKFLOW_REVIEW_OPTIONS: JSON.stringify(options) } });
  if (result.error || result.status !== 0) {
    const code = result.error?.code || result.error?.message || (result.status !== null ? `exit ${result.status}` : 'unknown');
    const stderrSnippet = redactSensitive(result.stderr);
    const detail = stderrSnippet || (result.status !== 0 ? `child process exited with status ${result.status}` : 'no diagnostic error output');
    throw new Error(`Native OMP failed (${code}, status ${result.status}): ${detail} [retained session: ${sessionDir}]`);
  }
  const files = readdirSync(sessionDir).filter(p => p.endsWith('.jsonl'));
  if (files.length !== 1 || !isRealPathInsideRoot(sessionDir, files[0])) throw new Error('Expected exactly one retained native session');
  return readFileSync(join(sessionDir, files[0]), 'utf8');
}
function historySessions(data) { return [...(data.history || []).flatMap(c => [c.reviewer, ...(c.oracles || [])]), data.reviewer, ...(data.oracles || [])].filter(Boolean).map(r => r.sessionId); }
export function runReviewRecord(options) {
  const { root = '.', changeId, role, model, ompRunner = null, dryRun = false, redo = false, productCommand = null } = options;
  if (!['reviewer', 'oracle'].includes(role)) throw new Error('--role must be reviewer or oracle');
  if (options.prompt !== undefined) throw new Error('--prompt bypass is forbidden; roles and manifest are mandatory');
  if (!ompRunner && (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model))) throw new Error('Exact --model provider/model selector required');
  if (productCommand !== null && (!Array.isArray(productCommand) || !productCommand.length || productCommand.some(p => typeof p !== 'string' || p.includes('\0')) || !productCommand[0].trim())) throw new Error('product-command must be a JSON argv array');
  if (role === 'oracle' && !ompRunner && !productCommand) throw new Error('Oracle requires --product-command JSON argv to exercise product');
  const dir = changeDirectory(root, changeId);
  const manifestHash = hashFile(safeFile(root, join('openspec', 'changes', changeId, 'manifest.md')));
  const rolePromptHash = computeRolePromptHash(root, role);
  const source = sourceDigest(root), tests = testFilesHash(root);
  const data = loadReviewEvidence(dir) || { version: 2, changeId, reviewer: null, stageB: null, oracles: [], history: [] };
  data.history ||= [];
  let baseRef = options.baseRef || data.reviewer?.baseRef;
  if (baseRef) baseRef = resolveBase(root, baseRef);
  else if (!ompRunner) baseRef = resolveBase(root, baseRef);
  if (role === 'oracle' && (!data.stageB || data.stageB.sourceDigestAfter !== source || !data.stageB.executedAt)) throw new Error('earlier reviewer record is stale or completed Stage-B outcome required');
  if (role === 'reviewer' && data.reviewer && !redo) throw new Error('Existing review cycle requires intentional reviewer --redo');
  const prompt = buildPrompt(root, changeId, role, baseRef, productCommand);
  if (dryRun) return { ok: true, dryRun: true };
  const sessionDir = mkdtempSync(join(tmpdir(), 'omp-review-'));
  let retained;
  const provenance = { role, sourceDigest: source, manifestHash, rolePromptHash, testFilesHash: tests, baseRef: baseRef || null, requestedModel: model || null, promptHash: computeEventProjectionHash(prompt), productCommandHash: computeEventProjectionHash(productCommand) };
  let succeeded = false;
  try {
    retained = nativeEvents(invokeNative(root, prompt, model, sessionDir, { root: resolve(root), role, changeId, productCommand, provenance, baseRef: baseRef || null }, ompRunner));
    succeeded = true;
  }
  finally { if (succeeded) rmSync(sessionDir, { recursive: true, force: true }); }
  if (sourceDigest(root) !== source) throw new Error('source tree was mutated during review session (read-only execution violated)');
  const parsed = projectNative(retained, role);
  const requestedModel = model || `${parsed.provider}/${parsed.model}`;
  if (requestedModel !== `${parsed.provider}/${parsed.model}`) throw new Error(`effective model mismatch: requested '${requestedModel}', got '${parsed.provider}/${parsed.model}'`);
  if (computeEventProjectionHash(parsed.context) !== computeEventProjectionHash(provenance)) throw new Error('Native review context differs from dispatched request');
  const nativeProjection = { role, ...parsed, requestedModel, sourceDigest: source, manifestHash, rolePromptHash, testFilesHash: tests, baseRef: baseRef || null, exitCode: 0 };
  const record = { ...nativeProjection, nativeProjection, nativeEvents: retained, nativeEventsHash: computeEventProjectionHash(retained), eventProjectionHash: computeEventProjectionHash(nativeProjection) };
  if (historySessions(data).includes(record.sessionId)) throw new Error('duplicate session ID across review records');
  if (role === 'reviewer') {
    if (data.reviewer) data.history.push({ reviewer: data.reviewer, stageB: data.stageB, oracles: data.oracles });
    data.reviewer = record; data.stageB = null; data.oracles = [];
    if (redo) data.supersededArtifacts = readdirSync(dir).filter(isOracleEvidenceFilename).map(p => ({ path: p, hash: hashFile(safeFile(dir, p)) }));
  } else data.oracles.push(record);
  data.version = 2;
  saveReviewEvidence(dir, data);
  return { ok: true, record };
}
function executeTests(root, testCmd, testRunner) {
  const result = testRunner ? testRunner(testCmd) : spawnSync(testCmd, { cwd: root, encoding: 'utf8', shell: true, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Stage-B frozen test suite failed with exit code ${result.status}`);
  return { exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}
export function recordStageB(options) {
  const { root = '.', changeId, phase = 'after', disposition = 'lean-already', testCmd, summary = '', testRunner = null } = options;
  if (!testCmd || !['before', 'after'].includes(phase) || !['lean-already', 'simplified'].includes(disposition)) throw new Error('Stage-B requires before|after, test-cmd, and lean-already|simplified disposition');
  const dir = changeDirectory(root, changeId), data = loadReviewEvidence(dir);
  if (data?.reviewer?.verdict !== 'ACCEPT') throw new Error('implementation reviewer ACCEPT record required before Stage-B');
  if (data.oracles?.some(o => o.verdict === 'REJECT')) throw new Error('Negative oracle evidence requires intentional reviewer --redo before Stage-B');
  const reviewer = data.reviewer, source = sourceDigest(root), tests = testFilesHash(root);
  if (tests !== reviewer.testFilesHash) throw new Error('frozen test files were modified since Stage-A/reviewer');
  if (phase === 'before' && source !== reviewer.sourceDigest) throw new Error('Stage-B before must run on reviewer source A');
  if (phase === 'after' && !data.stageB?.before && (disposition !== 'lean-already' || source !== reviewer.sourceDigest)) throw new Error('Stage-B before execution on A is required before simplification');
  if (phase === 'after' && !data.stageB?.before) {
    recordStageB({ ...options, phase: 'before' });
    return recordStageB(options);
  }
  const startedAt = new Date().toISOString();
  const result = executeTests(root, testCmd, testRunner);
  if (testFilesHash(root) !== tests) throw new Error('frozen test files were modified during Stage-B run');
  if (sourceDigest(root) !== source) throw new Error('Test execution mutated product source');
  const execution = { sourceDigest: source, testFilesHash: tests, testCmd, startedAt, completedAt: new Date().toISOString(), ...result };
  if (data.oracles?.length) data.history.push({ reviewer: null, stageB: data.stageB, oracles: data.oracles });
  data.oracles = [];
  if (phase === 'before') data.stageB = { reviewerSessionId: reviewer.sessionId, before: execution };
  else {
    const before = data.stageB.before;
    if (before.testCmd !== testCmd || before.testFilesHash !== tests || before.sourceDigest !== reviewer.sourceDigest) throw new Error('Stage-B frozen before/after command or source mismatch');
    if ((disposition === 'lean-already') !== (source === reviewer.sourceDigest)) throw new Error('Stage-B disposition does not match actual source change');
    data.stageB = { reviewerSessionId: reviewer.sessionId, before, after: execution, disposition, testCmd, exitCode: 0, testFilesHashBefore: tests, testFilesHashAfter: tests, sourceDigestBefore: before.sourceDigest, sourceDigestAfter: source, executedAt: execution.completedAt, summary };
  }
  saveReviewEvidence(dir, data);
  return { ok: true, stageB: data.stageB };
}
function validateRecord(record, role, current, errors) {
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
    const current = { manifestHash: computeManifestHash(root, changeId), reviewerPromptHash: computeRolePromptHash(root, 'reviewer'), oraclePromptHash: computeRolePromptHash(root, 'oracle'), source: sourceDigest(root), tests: testFilesHash(root) };
    validateRecord(data.reviewer, 'reviewer', current, errors);
    const sb = data.stageB, reviewer = data.reviewer;
    if (!sb?.before || !sb?.after || !sb.executedAt || !sb.testCmd || sb.exitCode !== 0 || sb.reviewerSessionId !== reviewer?.sessionId) errors.push('Missing or invalid Stage-B disposition execution');
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
    const sessions = new Set(historical.map(r => r.sessionId));
    if (sessions.has(reviewer?.sessionId)) errors.push('duplicate reviewer session ID reused from prior cycle');
    sessions.add(reviewer?.sessionId);
    for (const oracle of oracles) {
      validateRecord(oracle, 'oracle', current, errors);
      if (sessions.has(oracle.sessionId)) errors.push('duplicate session ID across review records');
      sessions.add(oracle.sessionId);
      if (oracle.sourceDigest !== current.source) errors.push('Oracle source digest is stale');
      if (timestamp(oracle.startedAt) < timestamp(sb?.executedAt)) errors.push('Oracle must execute after Stage-B');
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
export function validateOracleArtifact(root, artifact, state, invalid) {
  if (!isPositiveOracleVerdict(artifact.detail)) invalid.push('oracle: expected explicit ACCEPT verdict');
  const rel = state.artifacts?.openspec?.path;
  if (!rel || !isRealPathInsideRoot(root, rel)) { invalid.push('oracle: missing rooted change'); return; }
  const dir = join(root, rel);
  if (artifact.path && dirname(resolve(root, artifact.path)) !== resolve(dir)) invalid.push('oracle: explicit evidence path belongs to another change');
  const paths = readdirSync(dir).filter(isOracleEvidenceFilename).map(p => join(dir, p));
  if (artifact.path && !paths.includes(resolve(root, artifact.path))) paths.push(resolve(root, artifact.path));
  let positive = false;
  for (const path of paths) {
    if (!isRealPathInsideRoot(root, path) || !statSync(path).isFile()) { invalid.push('oracle: file resolves outside project root or is not a file'); continue; }
    const text = readFileSync(path, 'utf8');
    if (isNegativeOracleVerdict(text) && !isSupersededOracleArtifact(dir, path)) invalid.push(`oracle: verdict in '${path}' is REJECT`);
    if (isPositiveOracleVerdict(text) && dirname(path) === resolve(dir)) positive = true;
  }
  const native = loadReviewEvidence(dir);
  if (!positive && !native?.oracles?.length) invalid.push('oracle: missing oracle evidence file (oracle*.md or acceptance.md)');
}
