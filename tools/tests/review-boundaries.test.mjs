/**
 * tools/tests/review-boundaries.test.mjs — consumer regressions for three review boundaries.
 *
 * (1) A refused admission must not leave a `run-*` directory behind: every refused run
 *     otherwise consumes one of the 256 bounded candidate slots forever.
 * (2) A malformed reviewer finding must be refused on the controlled-HTTP projection path
 *     exactly as the native path refuses it (one report validator, not two).
 * (3) An all-zero-token terminal response is unknown spend, not free: it must refuse at the
 *     transport boundary AND when a retained envelope is re-projected. A known zero COST
 *     with nonzero tokens stays valid.
 *
 * Fixtures only: loopback HTTP, a fake executor that must never run, no provider calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  runReviewRecord,
  computeSourceDigest,
  computeManifestHash,
  computeRolePromptHash,
  computeTestFilesHash,
  computeEventProjectionHash,
} from '../review/evidence.mjs';
import { projectHttpRecord, reprojectHttpExecution } from '../review/http-evidence.mjs';
import {
  admitSession,
  holdReservation,
  PINNED_MAX_OUTPUT_TOKENS,
  PINNED_CONTEXT_TOKENS,
  PINNED_TARIFFS_USD_PER_MILLION,
} from '../review/budget.mjs';
import { runHttpReview } from '../review/http-runtime.mjs';
import { prepareEvidence } from './fixtures/review-execution.mjs';

const EXECUTOR = 'nullform-http-v1';
const MODEL = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const RUNS_DIR = join('.workflow', 'review-runs');

function makeTempDir(prefix = 'review-boundaries-') {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initGitRepo(dir) {
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@localhost']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, '.gitignore'), '.tmp/\n.workflow/\n');
  writeFileSync(join(dir, 'README.md'), '# review boundaries fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
}

function setupProject(root, changeId) {
  const changeDir = join(root, 'openspec', 'changes', changeId);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'manifest.md'), '| R01 | User requirement quote |\n', 'utf8');
  prepareEvidence(root, changeId);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', `init ${changeId}`]);
  return changeDir;
}

function makePolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'openai',
    model: MODEL,
    transport: EXECUTOR,
    endpoint: ENDPOINT,
    ceilingUsd: 1.0,
    maxRequests: 3,
    maxContextBytes: 65536,
    maxResponseBytes: 65536,
    maxOutputTokens: PINNED_MAX_OUTPUT_TOKENS,
    timeoutMs: 30000,
    maxInputTokens: PINNED_CONTEXT_TOKENS,
    tariffsUsdPerMillion: { ...PINNED_TARIFFS_USD_PER_MILLION },
    ...overrides,
  };
}

function withDeadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms: ${label}`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function runDirs(root) {
  const dir = join(root, RUNS_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('run-')) : [];
}

function withCredential(t, value = 'fixture-only-credential') {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
}

/**
 * A controlled-HTTP reviewer envelope, re-derived exactly as the child writes it.
 * `usage` is the terminal provider usage; findings are the reviewer's typed report.
 */
function makeReviewerHttpFixture(root, { findings, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } = {}) {
  const requestedModel = `openai/${MODEL}`;
  const report = JSON.stringify({ findings, overall_correctness: 'correct', overall_explanation: 'Typed fixture findings', overall_confidence_score: 0.9 });
  const body = {
    id: 'chatcmpl-boundary-1', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: report }, finish_reason: 'stop' }],
    usage,
  };
  const raw = JSON.stringify(body);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const responseRelPath = 'provider-response-1.json';
  writeFileSync(join(root, responseRelPath), raw, 'utf8');

  const startedAt = '2026-10-18T10:00:00.000Z';
  const completedAt = '2026-10-18T10:00:05.000Z';
  const executionId = 'exec-boundary-1';
  const provenance = {
    role: 'reviewer',
    requestedModel,
    model: requestedModel,
    sourceDigest: createHash('sha256').update('source').digest('hex'),
    manifestHash: createHash('sha256').update('manifest').digest('hex'),
    rolePromptHash: createHash('sha256').update('role').digest('hex'),
    testFilesHash: createHash('sha256').update('tests').digest('hex'),
    baseRef: 'HEAD',
    promptHash: createHash('sha256').update('prompt').digest('hex'),
    productCommandHash: createHash('sha256').update('cmd').digest('hex'),
  };
  const originalProvenance = { executor: EXECUTOR, evidenceClass: 'transport-fixture', ...provenance };
  const provenanceHash = createHash('sha256').update(JSON.stringify(originalProvenance)).digest('hex');
  const counters = { input: usage.prompt_tokens, output: usage.completion_tokens, cacheRead: 0, cacheWrite: 0, totalTokens: usage.total_tokens };
  const envelope = {
    status: 0,
    executor: EXECUTOR,
    executionId,
    model: MODEL,
    startedAt,
    completedAt,
    usage: { ...counters, costUsd: 0 },
    events: [
      { type: 'execution', executionId, startedAt, provenanceHash, originalProvenance },
      { type: 'provider_response', ordinal: 1, at: '2026-10-18T10:00:02.000Z', status: 200, sha256,
        responseId: 'chatcmpl-boundary-1', usage: { ...counters } },
      { type: 'completion', attempts: 1, at: '2026-10-18T10:00:03.000Z', totals: { ...counters } },
    ],
    providerResponses: [{ path: responseRelPath, sha256, responseId: 'chatcmpl-boundary-1', status: 200 }],
    report,
  };
  return { envelope, provenance, text: JSON.stringify(envelope) };
}

const VALID_FINDINGS = [{ title: 'Boundary finding', body: 'Typed finding body', priority: 1, confidence: 0.8, file_path: 'tools/review/budget.mjs', line_start: 10, line_end: 12 }];
// Same report, missing file_path/line_start/line_end: the native validator already refuses this.
const MALFORMED_FINDINGS = [{ title: 'Boundary finding', body: 'Typed finding body', priority: 1, confidence: 0.8 }];

// --------------------------------------------------------------------------- (1)

test('boundary 1: refused admission leaves no run-* directory and consumes no candidate slot', (t) => {
  const root = makeTempDir('review-boundaries-d1-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);
  const changeId = 'feat-denied-admission';
  setupProject(root, changeId);
  withCredential(t);

  // The reservation is 3 * (128000 * 150 + 256 * 600) nanoUSD; 0.001 USD cannot cover it.
  const policyPath = join(root, '.tmp', 'admission.json');
  mkdirSync(join(root, '.tmp'), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(makePolicy({ ceilingUsd: 0.001, maxRequests: 3, maxOutputTokens: 256 })), 'utf8');

  let executorRuns = 0;
  const fakeExecutor = Object.freeze({
    endpoint: ENDPOINT,
    approveEndpoint: () => true,
    run: () => { executorRuns++; throw new Error('fake executor must never run under a refused admission'); },
  });

  assert.deepEqual(runDirs(root), [], 'fixture starts with no retained runs');
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.throws(
      () => runReviewRecord({
        root, changeId, role: 'reviewer', model: `openai/${MODEL}`, baseRef: 'HEAD',
        httpExecutor: fakeExecutor, admissionPolicy: '.tmp/admission.json',
      }),
      /budget refused|ceiling|held/i,
      `attempt ${attempt} must be refused by the financial authority`
    );
    assert.equal(executorRuns, 0, 'a refused admission must never dispatch the executor');
    assert.deepEqual(runDirs(root), [], `attempt ${attempt} left a run-* directory behind`);
  }

  // A held reservation blocks fresh admission for the same reason: still no directory.
  const held = admitSession({ root, policy: makePolicy({ ceilingUsd: 1000 }) });
  holdReservation({ root, reservationId: held.reservationId, reason: 'fixture unknown outcome' });
  assert.throws(
    () => runReviewRecord({
      root, changeId, role: 'reviewer', model: `openai/${MODEL}`, baseRef: 'HEAD',
      httpExecutor: fakeExecutor, admissionPolicy: '.tmp/admission.json',
    }),
    /budget refused|held/i,
    'a held ledger must refuse fresh admission'
  );
  assert.equal(executorRuns, 0);
  assert.deepEqual(runDirs(root), [], 'a held-ledger refusal must not retain a run directory either');
});

// --------------------------------------------------------------------------- (2)

test('boundary 2: malformed HTTP reviewer findings are refused by the public projection API', (t) => {
  const root = makeTempDir('review-boundaries-d2-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const control = makeReviewerHttpFixture(root, { findings: VALID_FINDINGS });
  const projected = reprojectHttpExecution({ envelope: control.envelope, provenance: control.provenance, role: 'reviewer', executorBranded: false, root });
  assert.equal(projected.verdict.verdict, 'ACCEPT', 'a well-formed typed report must still project');
  assert.doesNotThrow(
    () => projectHttpRecord({ text: control.text, provenance: control.provenance, role: 'reviewer', executorBranded: false, root, endpoint: ENDPOINT }),
    'the control envelope must be structurally valid, so the malformed case fails for its findings only'
  );

  const malformed = makeReviewerHttpFixture(root, { findings: MALFORMED_FINDINGS });
  assert.throws(
    () => reprojectHttpExecution({ envelope: malformed.envelope, provenance: malformed.provenance, role: 'reviewer', executorBranded: false, root }),
    /findings|typed/i,
    'reprojectHttpExecution must refuse a reviewer report whose findings lack file_path/line_start/line_end'
  );
  assert.throws(
    () => projectHttpRecord({ text: malformed.text, provenance: malformed.provenance, role: 'reviewer', executorBranded: false, root, endpoint: ENDPOINT }),
    /findings|typed/i,
    'projectHttpRecord must refuse the same malformed reviewer report'
  );
});

// --------------------------------------------------------------------------- (3)

test('boundary 3: all-zero-token terminal response is refused live and on retained re-projection', async (t) => {
  const root = makeTempDir('review-boundaries-d3-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);
  const changeId = 'feat-zero-usage';
  setupProject(root, changeId);
  withCredential(t);

  // Retained re-projection: an all-zero-token envelope must never project as a valid execution.
  const zero = makeReviewerHttpFixture(root, { findings: VALID_FINDINGS, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  assert.throws(
    () => reprojectHttpExecution({ envelope: zero.envelope, provenance: zero.provenance, role: 'reviewer', executorBranded: false, root }),
    /usage|token|zero|unknown/i,
    'a retained all-zero-token terminal response must be refused, not priced as zero'
  );

  // Known zero COST with nonzero tokens stays valid (the refusal must not be over-broad).
  const priced = makeReviewerHttpFixture(root, { findings: VALID_FINDINGS, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  assert.doesNotThrow(
    () => reprojectHttpExecution({ envelope: priced.envelope, provenance: priced.provenance, role: 'reviewer', executorBranded: false, root }),
    'known-zero cost with nonzero tokens must remain valid'
  );

  // Real loopback: the live transport must refuse the all-zero terminal response.
  const serverScript = String.raw`
const http = require('node:http');
const report = JSON.stringify({ findings: [{ title: 'Loopback finding', body: 'Loopback body', priority: 1, confidence: 0.8, file_path: 'product.cjs', line_start: 1, line_end: 1 }], overall_correctness: 'correct', overall_explanation: 'Loopback zero-usage fixture', overall_confidence_score: 0.9 });
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) { /* drain */ }
  const response = {
    id: 'chatcmpl-zero-1', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: '${MODEL}',
    choices: [{ index: 0, message: { role: 'assistant', content: report }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'zero-1' });
  res.end(JSON.stringify(response));
});
server.listen(0, '127.0.0.1', () => process.send({ endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions' }));
`;
  const server = spawn(process.execPath, ['-e', serverScript], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit');
      server.kill();
      await withDeadline(ended, 5000, 'loopback server kill').catch(() => {});
    }
  });
  const [{ endpoint }] = await once(server, 'message');

  const policy = makePolicy({ maxRequests: 1, maxOutputTokens: 256 });
  const reservation = admitSession({ root, policy });
  const sessionDir = '.workflow/session-zero-usage';
  mkdirSync(join(root, sessionDir), { recursive: true });
  const provenance = {
    role: 'reviewer',
    sourceDigest: computeSourceDigest(root),
    manifestHash: computeManifestHash(root, changeId),
    rolePromptHash: computeRolePromptHash(root, 'reviewer'),
    testFilesHash: computeTestFilesHash(root),
    baseRef: 'HEAD',
    productCommandHash: computeEventProjectionHash(null),
    promptHash: computeEventProjectionHash('zero-usage-prompt'),
    requestedModel: `openai/${MODEL}`,
    model: `openai/${MODEL}`,
  };

  const envelope = await runHttpReview({
    root, role: 'reviewer', changeId, model: `openai/${MODEL}`, prompt: 'zero-usage-prompt',
    provenance, policy, reservationId: reservation.reservationId, sessionDir, endpoint,
  }, { approveEndpoint: (url) => url === endpoint });

  assert.notEqual(envelope.status, 0, 'the live transport must refuse an all-zero-token terminal response');
  assert.match(String(envelope.reason || ''), /usage|token|zero|unknown/i, `refusal must name the unknown zero usage: ${envelope.reason}`);
});
