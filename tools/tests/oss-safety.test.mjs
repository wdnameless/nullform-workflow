import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
  rmdirSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import {
  runReviewRecord,
  computeSourceDigest,
  computeManifestHash,
  computeRolePromptHash,
  computeTestFilesHash,
  computeEventProjectionHash,
} from '../review/evidence.mjs';
import { reprojectHttpExecution } from '../review/http-evidence.mjs';
import {
  admitSession,
  recordRequest,
  settleReservation,
  inspectBudget,
  resolveBudgetAuthority,
  PINNED_MAX_OUTPUT_TOKENS,
  PINNED_CONTEXT_TOKENS,
} from '../review/budget.mjs';
import { runHttpReview } from '../review/http-runtime.mjs';
import { runWorkflowCli } from '../workflow.mjs';
import { nativeRunner, prepareEvidence } from './fixtures/review-execution.mjs';

function makeTempDir(prefix = 'oss-safety-test-') {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function nonGitDir(dir) {
  mkdirSync(dir, { recursive: true });
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
  writeFileSync(join(dir, 'README.md'), '# oss safety test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
}

function setupProject(root, changeId = 'feat-test') {
  const changeDir = join(root, 'openspec', 'changes', changeId);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'manifest.md'), '| R01 | User requirement quote |\n', 'utf8');
  prepareEvidence(root, changeId);
  if (existsSync(join(root, '.git'))) {
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', `init ${changeId}`]);
  }
  return changeDir;
}

function makePolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    transport: 'nullform-http-v1',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    ceilingUsd: 1.0,
    maxRequests: 3,
    maxContextBytes: 65536,
    maxResponseBytes: 65536,
    maxOutputTokens: PINNED_MAX_OUTPUT_TOKENS,
    timeoutMs: 30000,
    maxInputTokens: PINNED_CONTEXT_TOKENS,
    tariffsUsdPerMillion: { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 },
    ...overrides,
  };
}

function withDeadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms: ${label}`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeHttpProjectionFixture(root, {
  exitCode = 0,
  verdict = 'ACCEPT',
  productCommandHash,
  sourceDigest,
  commandHashOverride,
  sourceDigestOverride,
  outputHashOverride,
  timestampOverride,
} = {}) {
  const model = 'gpt-4o-mini-2024-07-18';
  const requestedModel = `openai/${model}`;
  const responseBody = {
    id: 'chatcmpl-fixture-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: verdict === 'ACCEPT' ? 'Verdict: ACCEPT\nAll checks passed.' : 'Verdict: REJECT\nFailed checks.',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  const responseRaw = JSON.stringify(responseBody);
  const responseSha = createHash('sha256').update(responseRaw).digest('hex');
  const responseRelPath = 'provider-response-1.json';
  writeFileSync(join(root, responseRelPath), responseRaw, 'utf8');

  const startedAt = '2026-10-18T10:00:00.000Z';
  const completedAt = '2026-10-18T10:00:05.000Z';
  const executionId = 'exec-test-1';

  const origSourceDigest = sourceDigest || createHash('sha256').update('source').digest('hex');
  const origProductCommandHash = productCommandHash || createHash('sha256').update('cmd').digest('hex');
  const provenance = {
    role: 'oracle',
    requestedModel,
    model: requestedModel,
    sourceDigest: origSourceDigest,
    manifestHash: createHash('sha256').update('manifest').digest('hex'),
    rolePromptHash: createHash('sha256').update('role').digest('hex'),
    testFilesHash: createHash('sha256').update('tests').digest('hex'),
    baseRef: 'HEAD',
    promptHash: createHash('sha256').update('prompt').digest('hex'),
    productCommandHash: origProductCommandHash,
  };

  const originalProvenance = {
    executor: 'nullform-http-v1',
    evidenceClass: 'transport-fixture',
    ...provenance,
  };
  const provenanceHash = createHash('sha256').update(JSON.stringify(originalProvenance)).digest('hex');

  const productEvent = {
    type: 'product_execution',
    at: timestampOverride || '2026-10-18T10:00:02.000Z',
    startedAt: '2026-10-18T10:00:01.000Z',
    completedAt: '2026-10-18T10:00:02.000Z',
    commandHash: commandHashOverride !== undefined ? commandHashOverride : origProductCommandHash,
    sourceDigest: sourceDigestOverride !== undefined ? sourceDigestOverride : origSourceDigest,
    exitCode,
    outputHash: outputHashOverride !== undefined ? outputHashOverride : createHash('sha256').update('output').digest('hex'),
  };

  const envelope = {
    status: 0,
    executor: 'nullform-http-v1',
    executionId,
    startedAt,
    completedAt,
    events: [
      {
        type: 'execution',
        executionId,
        startedAt,
        provenanceHash,
        originalProvenance,
      },
      productEvent,
      {
        type: 'provider_response',
        ordinal: 1,
        responseId: 'chatcmpl-fixture-1',
        sha256: responseSha,
        at: '2026-10-18T10:00:03.000Z',
        status: 200,
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      },
      {
        type: 'completion',
        attempts: 1,
        at: '2026-10-18T10:00:04.000Z',
        totals: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      },
    ],
    providerResponses: [
      {
        path: responseRelPath,
        sha256: responseSha,
        responseId: 'chatcmpl-fixture-1',
        status: 200,
      },
    ],
    report: responseBody.choices[0].message.content,
  };

  return { envelope, provenance, root };
}

function startLoopbackServer(t) {
  const serverScript = String.raw`
const http = require('node:http');
let ordinal = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const n = ++ordinal;
  const toolTurn = n === 1;
  const message = toolTurn
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'ex-1', type: 'function', function: { name: 'exercise_product', arguments: JSON.stringify({ offset: 0 }) } }] }
    : { role: 'assistant', content: 'Verdict: ACCEPT\nLoopback accepted.' };
  const response = {
    id: 'chatcmpl-fixture-' + n, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'gpt-4o-mini-2024-07-18',
    choices: [{ index: 0, message, finish_reason: toolTurn ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  };
  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-' + n });
  res.end(JSON.stringify(response));
});
server.listen(0, '127.0.0.1', () => process.send({ endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions' }));
`;
  const server = spawn(process.execPath, ['-e', serverScript], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit');
      server.kill();
      await withDeadline(ended, 5000, 'server kill').catch(() => {});
    }
  });
  return server;
}

function makeNearBoundaryLedger(ledgerPath) {
  const dir = dirname(ledgerPath);
  mkdirSync(dir, { recursive: true });

  const fixedId = (i) => `res-${String(i).padStart(8, '0')}`;
  const rowTemplate = (id) => ({
    reservationId: id,
    status: 'settled',
    reservedNanoUsd: 1000,
    maxRequests: 1,
    requests: [{ ordinal: 1, at: '2026-10-18T00:00:00.000Z' }],
    createdAt: '2026-10-18T00:00:00.000Z',
    settledAt: '2026-10-18T00:00:01.000Z',
    settledNanoUsd: 1000,
    model: 'gpt-4o-mini-2024-07-18',
    tariffsNanoPerToken: { input: 150, output: 600, cacheRead: 75, cacheWrite: 0 },
  });

  const sample1 = JSON.stringify({ settledNanoUsd: 1000, reservations: [rowTemplate(fixedId(0))] }, null, 2);
  const sample2 = JSON.stringify({ settledNanoUsd: 2000, reservations: [rowTemplate(fixedId(0)), rowTemplate(fixedId(1))] }, null, 2);
  const rowBytes = Buffer.byteLength(sample2, 'utf8') - Buffer.byteLength(sample1, 'utf8');
  const baseBytes = Buffer.byteLength(sample1, 'utf8') - rowBytes;

  const MAX_BYTES = 1024 * 1024;
  const targetBytes = MAX_BYTES - 400;
  let count = Math.floor((targetBytes - baseBytes) / rowBytes);

  let reservations = Array.from({ length: count }, (_, i) => rowTemplate(fixedId(i)));
  let totalSettled = count * 1000;
  let formatted = `${JSON.stringify({ settledNanoUsd: totalSettled, reservations }, null, 2)}\n`;
  let currentSize = Buffer.byteLength(formatted, 'utf8');

  if (currentSize > MAX_BYTES) {
    count--;
    reservations.pop();
    totalSettled = count * 1000;
    formatted = `${JSON.stringify({ settledNanoUsd: totalSettled, reservations }, null, 2)}\n`;
    currentSize = Buffer.byteLength(formatted, 'utf8');
  } else if (MAX_BYTES - currentSize > rowBytes) {
    count++;
    reservations.push(rowTemplate(fixedId(count - 1)));
    totalSettled = count * 1000;
    formatted = `${JSON.stringify({ settledNanoUsd: totalSettled, reservations }, null, 2)}\n`;
    currentSize = Buffer.byteLength(formatted, 'utf8');
  }

  writeFileSync(ledgerPath, formatted, 'utf8');
  const finalSize = statSync(ledgerPath).size;
  assert.ok(finalSize <= MAX_BYTES, `Starting ledger size ${finalSize} must be <= MAX_BYTES`);
  assert.ok(MAX_BYTES - finalSize < 600, `Remaining headroom ${MAX_BYTES - finalSize} must be smaller than a full admitted session lifecycle`);
}

test('safety defect 1A: reprojectHttpExecution refuses ACCEPT on failed product execution (exit 23)', () => {
  const root = makeTempDir('oss-safety-d1a-');
  try {
    const { envelope, provenance } = makeHttpProjectionFixture(root, { exitCode: 23, verdict: 'ACCEPT' });
    assert.throws(
      () => reprojectHttpExecution({ envelope, provenance, role: 'oracle', executorBranded: false, root }),
      /ACCEPT despite failed product execution|failed product/i,
      'Oracle ACCEPT must be refused when product execution exited non-zero'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 1B: reprojectHttpExecution refuses invalid product execution provenance (command, source, hash, time)', () => {
  const root = makeTempDir('oss-safety-d1b-');
  try {
    const f1 = makeHttpProjectionFixture(root, { exitCode: 0, verdict: 'ACCEPT', commandHashOverride: '0000000000000000000000000000000000000000000000000000000000000000' });
    assert.throws(
      () => reprojectHttpExecution({ envelope: f1.envelope, provenance: f1.provenance, role: 'oracle', executorBranded: false, root }),
      /provenance|commandHash/i
    );

    const f2 = makeHttpProjectionFixture(root, { exitCode: 0, verdict: 'ACCEPT', sourceDigestOverride: '1111111111111111111111111111111111111111111111111111111111111111' });
    assert.throws(
      () => reprojectHttpExecution({ envelope: f2.envelope, provenance: f2.provenance, role: 'oracle', executorBranded: false, root }),
      /provenance|sourceDigest/i
    );

    const f3 = makeHttpProjectionFixture(root, { exitCode: 0, verdict: 'ACCEPT', outputHashOverride: 'not-a-valid-hex-hash' });
    assert.throws(
      () => reprojectHttpExecution({ envelope: f3.envelope, provenance: f3.provenance, role: 'oracle', executorBranded: false, root }),
      /outputHash|provenance/i
    );

    const f4 = makeHttpProjectionFixture(root, { exitCode: 0, verdict: 'ACCEPT', timestampOverride: '2026-10-18T10:10:00.000Z' });
    assert.throws(
      () => reprojectHttpExecution({ envelope: f4.envelope, provenance: f4.provenance, role: 'oracle', executorBranded: false, root }),
      /clock window|timestamp|outside/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 1C: reprojectHttpExecution permits valid REJECT on failed product execution (exit 23) with known accounting', () => {
  const root = makeTempDir('oss-safety-d1c-');
  try {
    const { envelope, provenance } = makeHttpProjectionFixture(root, { exitCode: 23, verdict: 'REJECT' });
    const projected = reprojectHttpExecution({ envelope, provenance, role: 'oracle', executorBranded: false, root });
    assert.equal(projected.verdict.verdict, 'REJECT');
    assert.equal(projected.products.length, 1);
    assert.equal(projected.products[0].exitCode, 23);
    assert.equal(typeof projected.usage.costUsd, 'number');
    assert.ok(projected.usage.costUsd > 0, 'Accounting cost must be calculated and preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 1D: loopback tool execution of product.cjs exit 23 + model ACCEPT refuses ACCEPT', async t => {
  const root = makeTempDir('oss-safety-d1d-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);
  const changeId = 'feat-http-exit23';
  setupProject(root, changeId);
  writeFileSync(join(root, 'product.cjs'), 'process.exit(23);\n');

  const sessionDir = '.workflow/session-loopback';
  mkdirSync(join(root, sessionDir), { recursive: true });

  const server = startLoopbackServer(t);
  const [{ endpoint }] = await once(server, 'message');

  const policy = makePolicy({ endpoint: 'https://api.openai.com/v1/chat/completions', maxRequests: 3 });
  const reservation = admitSession({ root, policy });
  const productCommand = [process.execPath, 'product.cjs'];

  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-loopback-credential';
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });

  const modelSelector = `openai/${policy.model}`;
  const provenance = {
    role: 'oracle',
    sourceDigest: computeSourceDigest(root),
    manifestHash: computeManifestHash(root, changeId),
    rolePromptHash: computeRolePromptHash(root, 'oracle'),
    testFilesHash: computeTestFilesHash(root),
    baseRef: 'HEAD',
    productCommandHash: computeEventProjectionHash(productCommand),
    promptHash: computeEventProjectionHash('test-prompt'),
    requestedModel: modelSelector,
    model: modelSelector,
  };

  const invocation = {
    root,
    role: 'oracle',
    changeId,
    model: modelSelector,
    prompt: 'test-prompt',
    provenance,
    productCommand,
    policy,
    reservationId: reservation.reservationId,
    sessionDir,
    endpoint,
  };

  const envelope = await runHttpReview(invocation, { approveEndpoint: url => url === endpoint });
  assert.equal(envelope.status, 0, envelope.reason);
  const prodEvent = envelope.events.find(e => e.type === 'product_execution');
  assert.ok(prodEvent, 'Product execution event must be latched');
  assert.equal(prodEvent.exitCode, 23, 'Product exitCode must be 23');

  assert.throws(
    () => reprojectHttpExecution({ envelope, provenance, role: 'oracle', executorBranded: false, root }),
    /ACCEPT despite failed product execution|failed product/i,
    'Reprojecting loopback oracle execution with exit 23 and model ACCEPT must refuse ACCEPT'
  );
});

test('safety defect 2: candidate scan overflow (>256 dirs) refuses before invoking runner', () => {
  const root = makeTempDir('oss-safety-d2-');
  try {
    initGitRepo(root);
    const changeId = 'feat-overflow';
    setupProject(root, changeId);
    const evidencePath = join(root, 'openspec', 'changes', changeId, 'review-evidence.json');

    let runnerCalls = 0;
    const countingRunner = (...args) => {
      runnerCalls++;
      const res = nativeRunner()(...args);
      if (runnerCalls === 1) {
        const invocationChangeId = args[0]?.changeId || changeId;
        mkdirSync(join(root, 'openspec', 'changes', invocationChangeId, 'review-evidence.json'));
      }
      return res;
    };

    assert.throws(() => runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', ompRunner: countingRunner,
    }), /retained session/);
    assert.equal(runnerCalls, 1, 'Initial run executed once and retained');

    rmdirSync(evidencePath);

    const runsDir = join(root, '.workflow', 'review-runs');
    for (let i = 0; i < 257; i++) {
      mkdirSync(join(runsDir, `run-padding-${String(i).padStart(4, '0')}`));
    }

    assert.throws(() => runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', ompRunner: countingRunner,
    }), /256|retained|overflow|uninspectable/i);
    assert.equal(runnerCalls, 1, 'Ordinary retry MUST refuse before new runner dispatch; runner calls must remain 1');
    const runsAfter = readdirSync(runsDir).filter(name => name.startsWith('run-'));
    assert.equal(runsAfter.length, 258, 'Refused run must NOT leave empty run directories on disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 3: ledger near 1 MiB limit never authorizes dispatch if accounting cannot remain writable/readable through settlement', () => {
  const root = makeTempDir('oss-safety-d3-');
  try {
    nonGitDir(root);
    const auth = resolveBudgetAuthority(root);
    makeNearBoundaryLedger(auth.ledgerPath);

    assert.doesNotThrow(() => inspectBudget({ root, policy: makePolicy({ ceilingUsd: 1000 }) }));

    const policy = makePolicy({ ceilingUsd: 1000, maxRequests: 3 });

    let admitted;
    try {
      admitted = admitSession({ root, policy });
    } catch (err) {
      assert.match(err.message, /headroom|bound|limit|persistence|capacity|exceed/i, 'Refusal must be due to persistence headroom');
      return;
    }

    for (let r = 0; r < policy.maxRequests; r++) {
      recordRequest({ root, reservationId: admitted.reservationId });
    }

    settleReservation({
      root,
      reservationId: admitted.reservationId,
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    });

    const finalSize = statSync(auth.ledgerPath).size;
    assert.ok(finalSize <= 1024 * 1024, `Final ledger size ${finalSize} must remain <= 1 MiB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 4: distinct transitions for ordinary retry, explicit resume, and explicit redo', () => {
  const root = makeTempDir('oss-safety-d4-');
  try {
    initGitRepo(root);
    const changeId = 'feat-transitions';
    setupProject(root, changeId);
    const runsDir = join(root, '.workflow', 'review-runs');

    let runnerCalls = 0;
    let blockOnNextCall = false;
    const countingRunner = (...args) => {
      runnerCalls++;
      const res = nativeRunner()(...args);
      if (blockOnNextCall) {
        const invocationChangeId = args[0]?.changeId || changeId;
        mkdirSync(join(root, 'openspec', 'changes', invocationChangeId, 'review-evidence.json'));
        blockOnNextCall = false;
      }
      return res;
    };

    blockOnNextCall = true;
    assert.throws(() => runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', ompRunner: countingRunner,
    }), /retained session/);
    assert.equal(runnerCalls, 1, 'Initial run invoked runner once');

    const runDirs1 = readdirSync(runsDir).filter(name => name.startsWith('run-'));
    assert.equal(runDirs1.length, 1);
    const run1Dir = relative(root, join(runsDir, runDirs1[0]));
    const run1JsonPath = join(root, run1Dir, 'run.json');
    const run1BytesBefore = readFileSync(run1JsonPath, 'utf8');
    const run1 = JSON.parse(run1BytesBefore);
    assert.equal(run1.status, 'completed');
    assert.equal(run1.changeId, changeId);

    rmdirSync(join(root, 'openspec', 'changes', changeId, 'review-evidence.json'));
    assert.throws(() => runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', ompRunner: countingRunner,
    }), /refusing to buy another identical run.*--resume-session.*--redo/i);
    assert.equal(runnerCalls, 1, 'Ordinary retry must refuse without calling runner');

    assert.throws(() => runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', redo: true, resumeSessionDir: run1Dir, ompRunner: countingRunner,
    }), /resume is not --redo/i);
    assert.equal(runnerCalls, 1, 'Redo + resume combination must be rejected');

    const resRedo = runReviewRecord({
      root, changeId, role: 'reviewer', baseRef: 'HEAD', redo: true, ompRunner: countingRunner,
    });
    assert.equal(resRedo.ok, true, 'Explicit redo must succeed');
    assert.equal(runnerCalls, 2, 'Explicit redo must invoke runner for new cycle');
    assert.notEqual(resRedo.sessionDir, run1Dir, 'Redo must create a distinct session directory');
    assert.equal(readFileSync(run1JsonPath, 'utf8'), run1BytesBefore, 'Old run.json bytes must be preserved');

    const changeId2 = 'feat-resume-test';
    setupProject(root, changeId2);

    const runsBefore = new Set(readdirSync(runsDir).filter(name => name.startsWith('run-')));
    blockOnNextCall = true;
    assert.throws(() => runReviewRecord({
      root, changeId: changeId2, role: 'reviewer', baseRef: 'HEAD', ompRunner: countingRunner,
    }), /retained session/);
    assert.equal(runnerCalls, 3);

    const runsAfter = readdirSync(runsDir).filter(name => name.startsWith('run-'));
    const newRunName = runsAfter.find(name => !runsBefore.has(name));
    assert.ok(newRunName, 'Must find newly created run directory');
    const run2Dir = relative(root, join(runsDir, newRunName));

    rmdirSync(join(root, 'openspec', 'changes', changeId2, 'review-evidence.json'));
    const resResume = runReviewRecord({
      root, changeId: changeId2, role: 'reviewer', baseRef: 'HEAD', resumeSessionDir: run2Dir, ompRunner: countingRunner,
    });
    assert.equal(resResume.ok, true, 'Resume must succeed');
    assert.equal(runnerCalls, 3, 'Resume must import without calling runner');
    assert.equal(existsSync(join(root, 'openspec', 'changes', changeId2, 'review-evidence.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 5: dry-run without admissionPolicy reports prerequisites without throwing schema error', () => {
  const root = makeTempDir('oss-safety-d5-');
  try {
    initGitRepo(root);
    const changeId = 'feat-dryrun';
    setupProject(root, changeId);

    const res = runReviewRecord({
      root,
      changeId,
      role: 'reviewer',
      model: 'openai/gpt-4o-mini-2024-07-18',
      baseRef: 'HEAD',
      dryRun: true,
    });

    assert.equal(res.ok, true, 'Dry-run must succeed');
    assert.equal(res.dryRun, true, 'Result must indicate dryRun');
    assert.equal(res.admission?.supported, false);
    assert.match(res.admission?.reason, /No model spending authority: supply --admission-policy/i);

    assert.equal(existsSync(join(root, '.workflow')), false, 'Entire .workflow directory must not exist');
    const auth = resolveBudgetAuthority(root);
    assert.equal(existsSync(auth.ledgerPath), false, 'Budget ledger must not exist');

    const badPolicyPath = join(root, 'invalid-policy.json');
    writeFileSync(badPolicyPath, JSON.stringify({ schemaVersion: 1, provider: 'openai', ceilingUsd: -5 }));

    assert.throws(() => runReviewRecord({
      root,
      changeId,
      role: 'reviewer',
      model: 'openai/gpt-4o-mini-2024-07-18',
      baseRef: 'HEAD',
      admissionPolicy: 'invalid-policy.json',
      dryRun: true,
    }));
    assert.equal(existsSync(join(root, '.workflow')), false, 'Invalid dry-run must not create .workflow');
    assert.equal(existsSync(auth.ledgerPath), false, 'Invalid dry-run must not create budget ledger');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety defect 6: CLI review-run rejects unexpected positional arguments before authority or child dispatch', () => {
  const root = makeTempDir('oss-safety-d6-');
  try {
    initGitRepo(root);
    const changeId = 'feat-cli-pos';
    setupProject(root, changeId);

    const policyPath = 'admission.json';
    writeFileSync(join(root, policyPath), JSON.stringify(makePolicy({ ceilingUsd: 1.0 })));

    const codeExtra = runWorkflowCli([
      'review-run',
      'UNEXPECTED-EXTRA-POSITIONAL',
      '--change', changeId,
      '--role', 'reviewer',
      '--model', 'openai/gpt-4o-mini-2024-07-18',
      '--base-ref', 'HEAD',
      '--admission-policy', policyPath,
      '--dry-run',
    ], { cwd: root });

    assert.notEqual(codeExtra, 0, 'CLI review-run must return non-zero for unexpected positional argument');

    const codeValid = runWorkflowCli([
      'review-run',
      '--change', changeId,
      '--role', 'reviewer',
      '--model', 'openai/gpt-4o-mini-2024-07-18',
      '--base-ref', 'HEAD',
      '--admission-policy', policyPath,
      '--dry-run',
    ], { cwd: root });

    assert.equal(codeValid, 0, 'CLI review-run without extra positionals must succeed with exit code 0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
