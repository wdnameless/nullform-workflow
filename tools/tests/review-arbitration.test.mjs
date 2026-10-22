import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOracleModel } from '../oracle-model.mjs';
import { arbitrate } from '../review/arbitrate.mjs';

// Parent-owned execution: node --test tools/tests/review-arbitration.test.mjs
// Slice A (R01/R02): cross-family oracle selection + findings arbitration.

test('resolveOracleModel: cross-family accept selects first non-conflicting model', () => {
  const res1 = resolveOracleModel({
    builderFamily: 'claude',
    candidates: ['claude-3-5-sonnet', 'openai/gpt-4o', 'gemini-1.5-pro'],
  });
  assert.equal(res1, 'openai/gpt-4o');

  const res2 = resolveOracleModel({
    builderFamily: 'gpt-4o',
    candidates: ['openai/gpt-4o-mini', 'anthropic/claude-3-5-sonnet', 'gemini-pro'],
  });
  assert.equal(res2, 'anthropic/claude-3-5-sonnet');
});

test('resolveOracleModel: same-family rejects and throws naming the conflicting family', () => {
  assert.throws(
    () => {
      resolveOracleModel({
        builderFamily: 'claude',
        candidates: ['claude-3-5-sonnet', 'anthropic/claude-3-7-sonnet'],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /claude/i);
      return true;
    }
  );

  assert.throws(
    () => {
      resolveOracleModel({
        builderFamily: 'gpt',
        candidates: [],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gpt/i);
      return true;
    }
  );
});

test('arbitrate: splits findings into accepted and dropped with machine-readable reason', () => {
  const criteria = ['R01', 'R02'];
  const findings = [
    { id: 'f1', criterion: 'R01', detail: 'finding 1' },
    { id: 'f2', criterion: 'R03', detail: 'finding 2' },
    { id: 'f3', criterion: 'R02', detail: 'finding 3' },
    { id: 'f4', criterion: 'UNKNOWN', detail: 'finding 4' },
  ];

  const result = arbitrate(findings, criteria);
  assert.deepEqual(result.accepted, [
    { id: 'f1', criterion: 'R01', detail: 'finding 1' },
    { id: 'f3', criterion: 'R02', detail: 'finding 3' },
  ]);
  assert.deepEqual(result.dropped, [
    { id: 'f2', criterion: 'R03', detail: 'finding 2', reason: 'no-criterion-match' },
    { id: 'f4', criterion: 'UNKNOWN', detail: 'finding 4', reason: 'no-criterion-match' },
  ]);

  // Empty cases
  assert.deepEqual(arbitrate([], ['R01']), { accepted: [], dropped: [] });
  assert.deepEqual(arbitrate([{ id: 'f1', criterion: 'R01' }], []), {
    accepted: [],
    dropped: [{ id: 'f1', criterion: 'R01', reason: 'no-criterion-match' }],
  });
});
