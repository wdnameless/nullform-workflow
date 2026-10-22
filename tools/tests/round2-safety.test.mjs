/**
 * tools/tests/round2-safety.test.mjs — tests for round2 edit safety (R03/R05/R09).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertFactForcing } from '../review/gatekeeper.mjs';
import {
  clearPlanTokens,
  executeDestructive,
  planDestructive,
} from '../two-phase.mjs';
import { observeTrajectory } from '../trajectory.mjs';

test('assertFactForcing accepts when all required caller/consumer reads are present', () => {
  assert.doesNotThrow(() => {
    assertFactForcing('tools/review/gatekeeper.mjs', {
      reads: ['tools/review/budget.mjs', 'tools/tests/spend-safety.test.mjs'],
      required: ['tools/tests/spend-safety.test.mjs'],
    });
  });

  assert.doesNotThrow(() => {
    assertFactForcing('tools/two-phase.mjs', {
      reads: [],
      required: [],
    });
  });

  assert.doesNotThrow(() => {
    assertFactForcing('tools/trajectory.mjs');
  });
});

test('assertFactForcing refuses and names missing required reads when caller/consumer is not read', () => {
  assert.throws(
    () => {
      assertFactForcing('tools/review/gatekeeper.mjs', {
        reads: ['tools/review/budget.mjs'],
        required: [
          'tools/review/budget.mjs',
          'tools/tests/spend-safety.test.mjs',
          'tools/another-consumer.mjs',
        ],
      });
    },
    (err) => {
      assert.match(err.message, /missing required reads/i);
      assert.match(err.message, /tools\/tests\/spend-safety\.test\.mjs/);
      assert.match(err.message, /tools\/another-consumer\.mjs/);
      return true;
    }
  );

  assert.throws(
    () => {
      assertFactForcing('tools/review/gatekeeper.mjs', {
        required: ['tools/caller.mjs'],
      });
    },
    (err) => {
      assert.match(err.message, /tools\/caller\.mjs/);
      return true;
    }
  );
});

test('two-phase: planDestructive produces token and executeDestructive executes verified plan', () => {
  clearPlanTokens();
  const edit = {
    target: 'tools/two-phase.mjs',
    operation: 'delete-block',
    range: [10, 20],
  };

  const { planToken, hash } = planDestructive(edit);
  assert.equal(typeof planToken, 'string');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);

  let executed = false;
  const result = executeDestructive(planToken, edit, (payload) => {
    executed = true;
    return `applied:${payload.target}`;
  });

  assert.equal(executed, true);
  assert.equal(result, 'applied:tools/two-phase.mjs');
});

test('two-phase: refuses unknown or mismatched token and executes only verified plans', () => {
  clearPlanTokens();
  const edit = { file: 'secret.txt', action: 'truncate' };
  const { planToken } = planDestructive(edit);

  let executed = false;
  const applyFn = () => {
    executed = true;
  };

  // Unknown token refusal
  assert.throws(
    () => {
      executeDestructive('unknown-deadbeef-token', edit, applyFn);
    },
    (err) => {
      assert.match(err.message, /unknown plan token/i);
      return true;
    }
  );
  assert.equal(executed, false);

  // Mismatched edit refusal
  const tamperedEdit = { file: 'secret.txt', action: 'delete-all' };
  assert.throws(
    () => {
      executeDestructive(planToken, tamperedEdit, applyFn);
    },
    (err) => {
      assert.match(err.message, /mismatched plan token/i);
      return true;
    }
  );
  assert.equal(executed, false);
});

test('two-phase: plan token is single-use and invalidated after execution', () => {
  clearPlanTokens();
  const edit = { path: 'config.json', op: 'overwrite', content: '{}' };
  const { planToken } = planDestructive(edit);

  let runCount = 0;
  executeDestructive(planToken, edit, () => {
    runCount += 1;
  });
  assert.equal(runCount, 1);

  // Second execution must fail because token was invalidated
  assert.throws(
    () => {
      executeDestructive(planToken, edit, () => {
        runCount += 1;
      });
    },
    (err) => {
      assert.match(err.message, /unknown plan token/i);
      return true;
    }
  );
  assert.equal(runCount, 1);
});

test('trajectory: returns empty loops for non-repeating tool trajectories', () => {
  const events = [
    { tool: 'read', args: { path: 'a.js' } },
    { tool: 'grep', args: { pattern: 'foo' } },
    { tool: 'edit', args: { path: 'a.js' } },
    { tool: 'read', args: { path: 'b.js' } },
  ];
  const { loops } = observeTrajectory(events);
  assert.deepEqual(loops, []);
});

test('trajectory: flags consecutive identical tool calls as a loop', () => {
  const events = [
    { tool: 'read', args: { path: 'a.js' } },
    { tool: 'bash', args: { command: 'git status' } },
    { tool: 'bash', args: { command: 'git status' } },
  ];
  const { loops } = observeTrajectory(events);
  assert.deepEqual(loops, ['bash']);
});

test('trajectory: flags repeated identical calls inside loopWindow but ignores calls beyond loopWindow', () => {
  // Inside loopWindow = 3: alternating loop A, B, A repeats A with distance 2
  const cycling = [
    { tool: 'fetch', args: { url: 'https://example.com' } },
    { tool: 'sleep', args: { ms: 100 } },
    { tool: 'fetch', args: { url: 'https://example.com' } },
  ];
  const cycleResult = observeTrajectory(cycling, { loopWindow: 3 });
  assert.deepEqual(cycleResult.loops, ['fetch']);

  // Outside loopWindow = 2: distance between read calls is 3 (indices 0 and 3)
  const spaced = [
    { tool: 'read', args: { path: 'foo.txt' } },
    { tool: 'bash', args: { command: 'npm test' } },
    { tool: 'grep', args: { pattern: 'bar' } },
    { tool: 'read', args: { path: 'foo.txt' } },
  ];
  const spacedResult = observeTrajectory(spaced, { loopWindow: 2 });
  assert.deepEqual(spacedResult.loops, []);

  // Different args to same tool is NOT a loop
  const diffArgs = [
    { tool: 'read', args: { path: 'a.txt' } },
    { tool: 'read', args: { path: 'b.txt' } },
  ];
  const diffResult = observeTrajectory(diffArgs);
  assert.deepEqual(diffResult.loops, []);
});

test('trajectory: throws when events length exceeds maxSteps', () => {
  const events = Array.from({ length: 11 }, (_, i) => ({
    tool: `tool-${i}`,
    args: { step: i },
  }));

  assert.doesNotThrow(() => {
    observeTrajectory(events.slice(0, 10), { maxSteps: 10 });
  });

  assert.throws(
    () => {
      observeTrajectory(events, { maxSteps: 10 });
    },
    (err) => {
      assert.match(err.message, /step limit exceeded/i);
      assert.match(err.message, /11/);
      assert.match(err.message, /10/);
      return true;
    }
  );
});
