import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSnapshot, checkAlerts, DEFAULT_COST_TIERS } from '../cost-snapshot.mjs';
import { emitHudStatus, validateHudStatus, HUD_SCHEMA } from '../hud-status.mjs';
import { checkTripwire, verifyGolden, TIER_CEILINGS } from '../tripwire.mjs';

test('cost-snapshot: writeSnapshot writes snapshot.json atomically and round-trips', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r2-ops-snapshot-'));
  try {
    const costs = { total: 12.34, inputTokens: 1000, outputTokens: 500 };
    const filePath = writeSnapshot(tmp, costs);
    assert.equal(filePath, join(tmp, 'snapshot.json'));

    const readBack = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(readBack, costs);

    // Overwriting atomically in O(1)
    const updated = { total: 15.0, inputTokens: 1200, outputTokens: 600 };
    writeSnapshot(tmp, updated);
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), updated);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cost-snapshot: checkAlerts fires once per tier and refires only after clear', () => {
  const tiers = { notice: 10, warning: 50, critical: 100 };
  const state = { fired: new Set() };

  // Initial: below notice
  let alerts = checkAlerts(state, { total: 5 }, { tiers });
  assert.deepEqual(alerts, []);
  assert.equal(state.fired.size, 0);

  // Cross notice
  alerts = checkAlerts(state, { total: 15 }, { tiers });
  assert.deepEqual(alerts, ['notice']);
  assert.ok(state.fired.has('notice'));

  // Cross notice again without clearing: deduped
  alerts = checkAlerts(state, { total: 20 }, { tiers });
  assert.deepEqual(alerts, []);
  assert.ok(state.fired.has('notice'));

  // Cross warning
  alerts = checkAlerts(state, { total: 60 }, { tiers });
  assert.deepEqual(alerts, ['warning']);
  assert.ok(state.fired.has('notice'));
  assert.ok(state.fired.has('warning'));

  // Clear warning (drops below 50, but stays above 10)
  alerts = checkAlerts(state, { total: 30 }, { tiers });
  assert.deepEqual(alerts, []);
  assert.ok(state.fired.has('notice'));
  assert.ok(!state.fired.has('warning'));

  // Warning refires after clear
  alerts = checkAlerts(state, { total: 55 }, { tiers });
  assert.deepEqual(alerts, ['warning']);
  assert.ok(state.fired.has('warning'));

  // Clear all (drops below 10)
  alerts = checkAlerts(state, { total: 2 }, { tiers });
  assert.deepEqual(alerts, []);
  assert.equal(state.fired.size, 0);

  // Jump straight to critical: fires all tiers that crossed
  alerts = checkAlerts(state, { total: 120 }, { tiers });
  assert.deepEqual(alerts, ['notice', 'warning', 'critical']);
  assert.ok(state.fired.has('notice'));
  assert.ok(state.fired.has('warning'));
  assert.ok(state.fired.has('critical'));
});

test('cost-snapshot: checkAlerts works with default tiers', () => {
  assert.ok(DEFAULT_COST_TIERS.notice !== undefined);
  assert.ok(DEFAULT_COST_TIERS.warning !== undefined);
  assert.ok(DEFAULT_COST_TIERS.critical !== undefined);

  const state = { fired: new Set() };
  const alerts = checkAlerts(state, { total: DEFAULT_COST_TIERS.notice + 0.1 });
  assert.deepEqual(alerts, ['notice']);
});

test('hud-status: emitHudStatus produces valid hud-status.v1 payloads for working|blocked|idle', () => {
  assert.equal(HUD_SCHEMA, 'hud-status.v1');

  for (const state of ['working', 'blocked', 'idle']) {
    const payload = emitHudStatus({
      state,
      waits: ['gate-review'],
      costs: { total: 3.25 },
    });
    assert.equal(payload.schema, 'hud-status.v1');
    assert.equal(payload.state, state);
    assert.deepEqual(payload.waits, ['gate-review']);
    assert.deepEqual(payload.costs, { total: 3.25 });
    assert.equal(validateHudStatus(payload), true);
  }
});

test('hud-status: emitHudStatus and validateHudStatus reject off-schema payloads with informative errors', () => {
  // Invalid state in emitHudStatus
  assert.throws(
    () => emitHudStatus({ state: 'sleeping' }),
    /Invalid state 'sleeping'/
  );

  // Missing schema
  assert.throws(
    () => validateHudStatus({ state: 'working', waits: [], costs: {} }),
    /Missing required field 'schema'/
  );

  // Wrong schema version
  assert.throws(
    () => validateHudStatus({ schema: 'hud-status.v0', state: 'working', waits: [], costs: {} }),
    /Invalid schema: expected 'hud-status\.v1'/
  );

  // Missing state
  assert.throws(
    () => validateHudStatus({ schema: 'hud-status.v1', waits: [], costs: {} }),
    /Missing required field 'state'/
  );

  // Invalid state
  assert.throws(
    () => validateHudStatus({ schema: 'hud-status.v1', state: 'halted', waits: [], costs: {} }),
    /Invalid state 'halted'/
  );

  // Missing waits
  assert.throws(
    () => validateHudStatus({ schema: 'hud-status.v1', state: 'working', costs: {} }),
    /Missing required field 'waits'/
  );

  // Missing costs
  assert.throws(
    () => validateHudStatus({ schema: 'hud-status.v1', state: 'working', waits: [] }),
    /Missing required field 'costs'/
  );

  // Non-object
  assert.throws(() => validateHudStatus(null), /non-null object/);
  assert.throws(() => validateHudStatus('string'), /non-null object/);
});

test('tripwire: checkTripwire enforces tier ceilings and throws naming tier/ceiling/actual on excess', () => {
  assert.deepEqual(TIER_CEILINGS, { T0: 200, T1: 500, T2: 2000, T3: 8000 });

  // Under / equal ceiling passes
  assert.equal(checkTripwire({ added: 100, deleted: 100 }, 'T0'), true); // 200 == 200
  assert.equal(checkTripwire({ added: 300, deleted: 200 }, 'T1'), true); // 500 == 500
  assert.equal(checkTripwire({ added: 1500, deleted: 500 }, 'T2'), true); // 2000 == 2000
  assert.equal(checkTripwire({ added: 5000, deleted: 3000 }, 'T3'), true); // 8000 == 8000

  // Oversize diff throws naming tier, ceiling, and actual lines
  assert.throws(
    () => checkTripwire({ added: 300, deleted: 250 }, 'T1'), // 550 > 500
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /T1/);
      assert.match(err.message, /500/);
      assert.match(err.message, /550/);
      return true;
    }
  );

  // T0 oversize throws naming tier, ceiling, actual
  assert.throws(
    () => checkTripwire({ added: 150, deleted: 60 }, 'T0'), // 210 > 200
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /T0/);
      assert.match(err.message, /200/);
      assert.match(err.message, /210/);
      return true;
    }
  );

  // Unknown tier throws
  assert.throws(() => checkTripwire({ added: 10, deleted: 10 }, 'T99'), /Unknown tier/);
});

test('tripwire: verifyGolden verifies declared fixture.fields byte-exactly via deepEqual', () => {
  // Array format of fixture.fields
  const fixture = {
    fields: ['input', 'output'],
    input: { model: 'gpt-4', prompt: 'test' },
    output: { text: 'ok', tokens: 10 },
    ignoredMetadata: 'does not matter',
  };

  const actualMatching = {
    input: { model: 'gpt-4', prompt: 'test' },
    output: { text: 'ok', tokens: 10 },
    extraRuntimeField: 12345,
  };

  assert.equal(verifyGolden(fixture, actualMatching), true);

  // Mismatch in output
  const actualMismatch = {
    input: { model: 'gpt-4', prompt: 'test' },
    output: { text: 'different', tokens: 10 },
  };

  assert.throws(() => verifyGolden(fixture, actualMismatch));

  // Object format of fixture.fields
  const fixtureObj = {
    fields: {
      status: 'ok',
      payload: { count: 42 },
    },
  };

  assert.equal(verifyGolden(fixtureObj, { status: 'ok', payload: { count: 42 } }), true);
  assert.throws(() => verifyGolden(fixtureObj, { status: 'error', payload: { count: 42 } }));
});
