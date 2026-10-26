/**
 * tools/tests/spend-safety.test.mjs — tests for spend safety ledger and gatekeeper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  admit,
  loadSpendLedger,
  recordReceipt,
  saveSpendLedger,
} from '../review/budget.mjs';

import {
  DANGEROUS_EXEC_TOOLS,
  DANGEROUS_NETWORK_TOOLS,
  DANGEROUS_WRITE_TOOLS,
  authorize,
  configureGatekeeper,
  getAuditLog,
  resetGatekeeper,
} from '../review/gatekeeper.mjs';

function makeTempDir() {
  const dir = join(tmpdir(), `spend-safety-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('receipt recorded twice across reload counts once (idempotent)', () => {
  const dir = makeTempDir();
  try {
    // 1. Initial load from empty directory returns defaults
    let ledger = loadSpendLedger(dir);
    assert.equal(ledger.used.T1, 0);
    assert.equal(ledger.used.T2, 0);
    assert.equal(ledger.used.T3, 0);
    assert.deepEqual(ledger.receipts, []);

    // 2. Record a receipt and persist
    const receipt1 = { id: 'rcpt-uuid-1', tier: 'T1', costNano: 500_000_000 };
    recordReceipt(ledger, receipt1);
    assert.equal(ledger.used.T1, 500_000_000);
    assert.equal(ledger.receipts.length, 1);
    saveSpendLedger(dir, ledger);

    // 3. Reload from disk
    ledger = loadSpendLedger(dir);
    assert.equal(ledger.used.T1, 500_000_000);
    assert.equal(ledger.receipts.length, 1);
    assert.equal(ledger.receipts[0].id, 'rcpt-uuid-1');

    // 4. Record the same receipt again across the reload
    recordReceipt(ledger, receipt1);
    assert.equal(ledger.used.T1, 500_000_000, 'Usage must remain 500_000_000, not double-counted');
    assert.equal(ledger.receipts.length, 1, 'Receipts array must still contain exactly one entry');
    saveSpendLedger(dir, ledger);

    // 5. Reload again and verify state is unchanged
    ledger = loadSpendLedger(dir);
    assert.equal(ledger.used.T1, 500_000_000);
    assert.equal(ledger.receipts.length, 1);

    // 6. Record a distinct receipt
    const receipt2 = { id: 'rcpt-uuid-2', tier: 'T1', costNano: 250_000_000 };
    recordReceipt(ledger, receipt2);
    assert.equal(ledger.used.T1, 750_000_000);
    assert.equal(ledger.receipts.length, 2);
    saveSpendLedger(dir, ledger);

    // 7. Verify distinct receipts across tiers
    const receipt3 = { id: 'rcpt-uuid-3', tier: 'T2', costNano: 1_000_000_000 };
    recordReceipt(ledger, receipt3);
    assert.equal(ledger.used.T1, 750_000_000);
    assert.equal(ledger.used.T2, 1_000_000_000);
    assert.equal(ledger.receipts.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('over-ceiling admit throws while under-ceiling succeeds', () => {
  const ledger = {
    ceilings: {
      T1: 1_000_000_000, // 1 USD in nano-USD
      T2: 5_000_000_000,
      T3: 20_000_000_000,
    },
    used: {
      T1: 800_000_000,
      T2: 0,
      T3: 0,
    },
    receipts: [],
  };

  // Under ceiling: 800M + 200M = 1000M <= 1000M
  assert.equal(admit(ledger, 'T1', 200_000_000), true);

  // Over ceiling: 800M + 200M + 1 > 1000M
  assert.throws(
    () => admit(ledger, 'T1', 200_000_001),
    /ceiling|exceed/i
  );

  // Default costNano is 0: currently used (800M) <= ceiling (1000M)
  assert.equal(admit(ledger, 'T1'), true);

  // If used is already over ceiling, admit throws even with 0 cost
  const exhaustedLedger = {
    ceilings: { T1: 500 },
    used: { T1: 600 },
    receipts: [],
  };
  assert.throws(
    () => admit(exhaustedLedger, 'T1', 0),
    /ceiling|exceed/i
  );

  // Validation on trust boundaries
  assert.throws(() => admit(ledger, 'INVALID_TIER', 100), /tier/i);
  assert.throws(() => admit(ledger, 'T1', -1), /costNano/i);
  assert.throws(() => admit(ledger, 'T1', 1.5), /costNano/i);
  assert.throws(() => admit(null, 'T1', 100), /ledger/i);
});

test('gatekeeper authorizes public tools and denies dangerous tools by default', () => {
  resetGatekeeper();
  configureGatekeeper({ allow: [] });

  // Dangerous exec tools default deny
  for (const execTool of DANGEROUS_EXEC_TOOLS) {
    const res = authorize(execTool, { command: 'id' });
    assert.equal(res.ok, false);
    assert.equal(res.rule, 'default-deny');
  }

  // Dangerous write tools default deny
  for (const writeTool of DANGEROUS_WRITE_TOOLS) {
    const res = authorize(writeTool, { path: 'file.txt' });
    assert.equal(res.ok, false);
    assert.equal(res.rule, 'default-deny');
  }

  // Dangerous network tools default deny
  for (const netTool of DANGEROUS_NETWORK_TOOLS) {
    const res = authorize(netTool, { url: 'https://example.com' });
    assert.equal(res.ok, false);
    assert.equal(res.rule, 'default-deny');
  }

  // Safe tools default to rule "public"
  const safeTools = ['read', 'grep', 'glob', 'lsp', 'ast_grep'];
  for (const safeTool of safeTools) {
    const res = authorize(safeTool, { pattern: 'test' });
    assert.equal(res.ok, true);
    assert.equal(res.rule, 'public');
  }
});

test('gatekeeper respects allow rules and appends audit entries to memory and disk', () => {
  const dir = makeTempDir();
  const auditPath = join(dir, 'audit', 'gatekeeper.log');

  try {
    resetGatekeeper();
    configureGatekeeper({
      allow: [
        { tool: 'bash', rule: 'allow-ci-bash' },
        { tool: 'write', rule: 'allow-temp-write', check: args => args && args.path && args.path.startsWith('/tmp') },
      ],
      auditPath,
    });

    // 1. Allowed dangerous tool with explicit rule
    const res1 = authorize('bash', { command: 'node test.js' });
    assert.equal(res1.ok, true);
    assert.equal(res1.rule, 'allow-ci-bash');

    // 2. Dangerous tool allowed when check predicate passes
    const res2 = authorize('write', { path: '/tmp/test.txt', content: 'abc' });
    assert.equal(res2.ok, true);
    assert.equal(res2.rule, 'allow-temp-write');

    // 3. Dangerous tool denied when check predicate fails
    const res3 = authorize('write', { path: '/etc/passwd', content: 'abc' });
    assert.equal(res3.ok, false);
    assert.equal(res3.rule, 'default-deny');

    // 4. Safe tool passes as public
    const res4 = authorize('read', { path: 'README.md' });
    assert.equal(res4.ok, true);
    assert.equal(res4.rule, 'public');

    // 5. In-memory audit log contains all decisions
    const memoryLog = getAuditLog();
    assert.equal(memoryLog.length, 4);
    assert.equal(memoryLog[0].tool, 'bash');
    assert.equal(memoryLog[0].rule, 'allow-ci-bash');
    assert.equal(memoryLog[0].ok, true);
    assert.ok(memoryLog[0].timestamp);

    assert.equal(memoryLog[1].tool, 'write');
    assert.equal(memoryLog[1].rule, 'allow-temp-write');
    assert.equal(memoryLog[1].ok, true);

    assert.equal(memoryLog[2].tool, 'write');
    assert.equal(memoryLog[2].rule, 'default-deny');
    assert.equal(memoryLog[2].ok, false);

    assert.equal(memoryLog[3].tool, 'read');
    assert.equal(memoryLog[3].rule, 'public');
    assert.equal(memoryLog[3].ok, true);

    // 6. On-disk audit log matches in-memory decisions
    assert.ok(existsSync(auditPath));
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.equal(lines[0].tool, 'bash');
    assert.equal(lines[1].tool, 'write');
    assert.equal(lines[2].ok, false);
    assert.equal(lines[3].rule, 'public');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetGatekeeper();
  }
});
