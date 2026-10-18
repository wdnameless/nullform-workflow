/**
 * tools/tests/review-budget.test.mjs — focused regressions for financial integrity holes.
 * Real FS, temp Git repos, symlinks. Sufficient-ceiling fixtures; one-invariant mutations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as budget from '../review-budget.mjs';

const {
  BUDGET_LEDGER_DIR,
  BUDGET_LEDGER_FILE,
  PINNED_CONTEXT_TOKENS,
  PINNED_MAX_OUTPUT_TOKENS,
  PINNED_TARIFFS_USD_PER_MILLION,
  admitSession,
  holdReservation,
  pinnedTariffsNanoPerToken,
  recordRequest,
  resolveBudgetAuthority,
  settleReservation,
  usageCostNanoUsd,
  validatePolicy,
} = budget;

const SUFFICIENT_CEILING_USD = 1.0;
const BYTE_BOUND = 1024 * 1024; // 1 MiB documented bound

function makeTempDir() {
  const dir = join(tmpdir(), `review-budget-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
}

function initGitRepo(dir) {
  const r1 = git(dir, ['init', '--quiet']);
  assert.equal(r1.status, 0, `git init failed: ${r1.stderr}`);
  const r2 = git(dir, ['config', 'user.email', 'test@localhost']);
  assert.equal(r2.status, 0, `git config email failed: ${r2.stderr}`);
  const r3 = git(dir, ['config', 'user.name', 'Test']);
  assert.equal(r3.status, 0, `git config name failed: ${r3.stderr}`);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  const r4 = git(dir, ['add', '.']);
  assert.equal(r4.status, 0, `git add failed: ${r4.stderr}`);
  const r5 = git(dir, ['commit', '--quiet', '-m', 'init']);
  assert.equal(r5.status, 0, `git commit failed: ${r5.stderr}`);
}

function nonGitDir(dir) { mkdirSync(dir, { recursive: true }); }

function makePolicy(overrides = {}) {
  return {
    schemaVersion: 1, provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
    transport: 'nullform-http-v1', endpoint: 'https://api.openai.com/v1/chat/completions',
    ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 3, maxContextBytes: 100000, maxResponseBytes: 10000,
    maxOutputTokens: PINNED_MAX_OUTPUT_TOKENS, timeoutMs: 30000, maxInputTokens: PINNED_CONTEXT_TOKENS,
    tariffsUsdPerMillion: { ...PINNED_TARIFFS_USD_PER_MILLION },
    ...overrides,
  };
}

function readLedgerFromDisk(root) {
  const auth = resolveBudgetAuthority(root);
  return JSON.parse(readFileSync(auth.ledgerPath, 'utf8'));
}

test('non-Git root resolves to .workflow fallback', () => {
  const dir = makeTempDir();
  try { nonGitDir(dir); const a = resolveBudgetAuthority(dir);
    assert.equal(a.kind, 'root');
    assert.equal(a.stateDir, join(dir, BUDGET_LEDGER_DIR));
    assert.equal(a.ledgerPath, join(dir, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('.git marker + failed discovery = hard fail, no second ceiling', () => {
  const dir = makeTempDir();
  try { nonGitDir(dir); mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.throws(() => resolveBudgetAuthority(dir));
    assert.equal(existsSync(join(dir, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symlinked .git + non-Git root must NOT use fallback', () => {
  const dir = makeTempDir(); const realGit = makeTempDir();
  try { nonGitDir(dir); initGitRepo(realGit);
    symlinkSync(join(realGit, '.git'), join(dir, '.git'), 'junction');
    assert.throws(() => resolveBudgetAuthority(dir));
    assert.equal(existsSync(join(dir, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE)), false);
  } finally { rmSync(realGit, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('symlinked .workflow parent must be rejected', () => {
  const dir = makeTempDir(); const target = makeTempDir();
  try { nonGitDir(dir); nonGitDir(target);
    symlinkSync(join(target, '.workflow'), join(dir, '.workflow'), 'junction');
    assert.throws(() => resolveBudgetAuthority(dir));
    assert.equal(existsSync(join(target, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE)), false);
  } finally { rmSync(target, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('oversize ledger rejected with specific semantic error', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    recordRequest({ root: dir, reservationId: res.reservationId });
    settleReservation({ root: dir, reservationId: res.reservationId, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const auth = resolveBudgetAuthority(dir);
    const valid = JSON.parse(readFileSync(auth.ledgerPath, 'utf8'));
    const baseRow = valid.reservations[0];
    // Clone as settled rows with UUID-shaped unique IDs, no requests
    const baseRowJson = JSON.stringify({ ...baseRow, reservationId: 'clone-0', requests: [] });
    const rowBytes = Buffer.byteLength(baseRowJson, 'utf8');
    const cloneCount = Math.ceil(BYTE_BOUND / rowBytes) + 1;
    const settledSum = baseRow.settledNanoUsd * (cloneCount + 1);
    const oversize = {
      settledNanoUsd: settledSum,
      reservations: [...valid.reservations, ...Array.from({ length: cloneCount }, (_, i) => ({ ...baseRow, reservationId: `clone-${i.toString(16).padStart(8, '0')}-${Date.now().toString(16)}-${i}`, requests: [], settledNanoUsd: baseRow.settledNanoUsd }))],
    };
    const serialized = JSON.stringify(oversize, null, 2);
    assert.ok(Buffer.byteLength(serialized, 'utf8') > BYTE_BOUND, `serialized bytes ${Buffer.byteLength(serialized)} must exceed bound ${BYTE_BOUND}`);
    writeFileSync(auth.ledgerPath, serialized);
    assert.throws(() => admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) }),
      /bound|limit|exceed|too (large|many)/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settlement uses captured tariffs even if caller mutates policy afterwards', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const policy = makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 2 });
    const res = admitSession({ root: dir, policy });
    recordRequest({ root: dir, reservationId: res.reservationId });
    policy.tariffsUsdPerMillion.input = 99.99;
    policy.tariffsUsdPerMillion.output = 99.99;
    const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
    const capturedTariffs = validatePolicy(makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 2 })).tariffsNanoPerToken;
    const expectedCost = usageCostNanoUsd(usage, capturedTariffs);
    const result = settleReservation({ root: dir, reservationId: res.reservationId, usage });
    assert.equal(result.settledNanoUsd, expectedCost);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordRequests cannot exceed originally captured maxRequests', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 2 }) });
    recordRequest({ root: dir, reservationId: res.reservationId });
    recordRequest({ root: dir, reservationId: res.reservationId });
    res.maxRequests = 99;
    assert.throws(() => recordRequest({ root: dir, reservationId: res.reservationId }), /exhausted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordRequest rejects when maxRequests exhausted', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 2 }) });
    recordRequest({ root: dir, reservationId: res.reservationId });
    recordRequest({ root: dir, reservationId: res.reservationId });
    assert.throws(() => recordRequest({ root: dir, reservationId: res.reservationId }), /exhausted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settleReservation rejects unsafe integer overflow', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD }) });
    assert.throws(() => settleReservation({ root: dir, reservationId: res.reservationId,
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settleReservation rejects cost exceeding reserved', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    settleReservation({ root: dir, reservationId: res.reservationId, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    assert.throws(() => settleReservation({ root: dir, reservationId: res.reservationId,
      usage: { input: 100000, output: 100000, cacheRead: 0, cacheWrite: 0 } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('held reservation blocks fresh admission even after ceiling raise', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    holdReservation({ root: dir, reservationId: res.reservationId, reason: 'unknown' });
    assert.throws(() => admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('usageCostNanoUsd prices aggregate across multiple requests without per-window cap', () => {
  const tariffs = pinnedTariffsNanoPerToken();
  const perRequest = { input: 80000, output: 1000, cacheRead: 0, cacheWrite: 0 };
  const aggregate = { input: 160000, output: 2000, cacheRead: 0, cacheWrite: 0 };
  const costPer = usageCostNanoUsd(perRequest, tariffs);
  const costAgg = usageCostNanoUsd(aggregate, tariffs);
  assert.equal(costAgg, costPer * 2);
});

test('usageCostNanoUsd rejects cacheRead > input', () => {
  const t = pinnedTariffsNanoPerToken();
  assert.throws(() => usageCostNanoUsd({ input: 100, output: 0, cacheRead: 200, cacheWrite: 0 }, t), /cached tokens exceed/);
});

test('readLedger rejects non-contiguous ordinals', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 3 }) });
    recordRequest({ root: dir, reservationId: res.reservationId });
    recordRequest({ root: dir, reservationId: res.reservationId });
    const auth = resolveBudgetAuthority(dir);
    const ledger = JSON.parse(readFileSync(auth.ledgerPath, 'utf8'));
    ledger.reservations[0].requests[1].ordinal = 3;
    writeFileSync(auth.ledgerPath, JSON.stringify(ledger, null, 2));
    assert.throws(() => admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) }),
      /contiguous/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLedger rejects duplicate reservation IDs', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    const auth = resolveBudgetAuthority(dir);
    const ledger = JSON.parse(readFileSync(auth.ledgerPath, 'utf8'));
    ledger.reservations.push({ ...ledger.reservations[0] });
    writeFileSync(auth.ledgerPath, JSON.stringify(ledger, null, 2));
    assert.throws(() => admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLedger rejects settled rollup mismatch', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    settleReservation({ root: dir, reservationId: res.reservationId, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const auth = resolveBudgetAuthority(dir);
    const ledger = JSON.parse(readFileSync(auth.ledgerPath, 'utf8'));
    ledger.settledNanoUsd = 999;
    writeFileSync(auth.ledgerPath, JSON.stringify(ledger, null, 2));
    assert.throws(() => admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) }),
      /disagrees/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Git-managed root resolves to .git authority', () => {
  const dir = makeTempDir();
  try { initGitRepo(dir); const a = resolveBudgetAuthority(dir);
    assert.equal(a.kind, 'git-common');
    assert.equal(a.ledgerPath, join(a.authority, BUDGET_LEDGER_FILE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing fallback ledger + new Git repo = hard fail', () => {
  const dir = makeTempDir();
  try { nonGitDir(dir);
    mkdirSync(join(dir, BUDGET_LEDGER_DIR), { recursive: true });
    writeFileSync(join(dir, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE), JSON.stringify({ settledNanoUsd: 500, reservations: [] }));
    git(dir, ['init', '--quiet']);
    git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'f.txt'), 'c'); git(dir, ['add', '.']); git(dir, ['commit', '--quiet', '-m', 'i']);
    assert.throws(() => resolveBudgetAuthority(dir), /Refusing to start a second/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operator policy increase does not reset settled history', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    settleReservation({ root: dir, reservationId: res.reservationId, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const before = readLedgerFromDisk(dir);
    const settledBefore = before.settledNanoUsd;
    admitSession({ root: dir, policy: makePolicy({ ceilingUsd: 10.0, maxRequests: 1 }) });
    const after = readLedgerFromDisk(dir);
    assert.equal(after.settledNanoUsd, settledBefore);
    assert.equal(after.reservations.find(r => r.reservationId === res.reservationId).status, 'settled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectBudget returns totals without creating files or lock', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const res = admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    recordRequest({ root: dir, reservationId: res.reservationId });
    const auth = resolveBudgetAuthority(dir);
    const beforeBytes = readFileSync(auth.ledgerPath, 'utf8');
    const snap = budget.inspectBudget({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD }) });
    assert.ok(snap);
    assert.equal(typeof snap.totalSettledNanoUsd, 'number');
    assert.equal(typeof snap.requiredReserveNanoUsd, 'number');
    assert.equal(snap.totalSettledNanoUsd, JSON.parse(beforeBytes).settledNanoUsd);
    assert.equal(existsSync(join(dirname(auth.ledgerPath), 'nullform-review-budget.lock')), false);
    const afterBytes = readFileSync(auth.ledgerPath, 'utf8');
    assert.equal(afterBytes, beforeBytes, 'inspectBudget must not mutate ledger bytes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectBudget on fresh root creates no files', () => {
  const dir = makeTempDir();
  try {
    nonGitDir(dir);
    const snap = budget.inspectBudget({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD }) });
    assert.equal(snap.totalSettledNanoUsd, 0);
    assert.equal(snap.reservationCount, 0);
    assert.equal(snap.kind, 'root');
    const auth = resolveBudgetAuthority(dir);
    assert.equal(existsSync(auth.ledgerPath), false, 'inspectBudget must not create ledger');
    assert.equal(existsSync(auth.stateDir), false, 'inspectBudget must not create state dir');
    assert.equal(existsSync(join(dirname(auth.ledgerPath), 'nullform-review-budget.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectBudget refuses ledger leaf symlink', (t) => {
  const dir = makeTempDir();
  const external = join(makeTempDir(), 'external.json');
  t.after(() => { try { rmSync(external, { recursive: true, force: true }); } catch {} });
  try {
    nonGitDir(dir);
    admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    const auth = resolveBudgetAuthority(dir);
    writeFileSync(external, JSON.stringify({ settledNanoUsd: 0, reservations: [] }));
    rmSync(auth.ledgerPath);
    try { symlinkSync(external, auth.ledgerPath, 'file'); }
    catch (err) { if (err.code === 'EPERM' || err.code === 'EACCES') return; throw err; }
    assert.throws(() => budget.inspectBudget({ root: dir, policy: makePolicy() }));
    assert.equal(readFileSync(external, 'utf8'), JSON.stringify({ settledNanoUsd: 0, reservations: [] }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inspectBudget refuses state dir symlink (clobber-free)', (t) => {
  const dir = makeTempDir();
  const external = join(makeTempDir(), 'external-state');
  t.after(() => { try { rmSync(external, { recursive: true, force: true }); } catch {} });
  try {
    nonGitDir(dir);
    admitSession({ root: dir, policy: makePolicy({ ceilingUsd: SUFFICIENT_CEILING_USD, maxRequests: 1 }) });
    const auth = resolveBudgetAuthority(dir);
    mkdirSync(external, { recursive: true });
    const externalLedger = join(external, BUDGET_LEDGER_FILE);
    writeFileSync(externalLedger, JSON.stringify({ settledNanoUsd: 0, reservations: [] }));
    rmSync(auth.stateDir, { recursive: true });
    symlinkSync(external, auth.stateDir, 'junction');
    assert.throws(() => budget.inspectBudget({ root: dir, policy: makePolicy() }));
    assert.deepEqual(JSON.parse(readFileSync(externalLedger, 'utf8')), { settledNanoUsd: 0, reservations: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
