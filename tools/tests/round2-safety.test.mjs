/**
 * tools/tests/round2-safety.test.mjs — tests for round2 edit safety (R03/R05/R09).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertFactForcing } from '../review/gatekeeper.mjs';
import { observeTrajectory } from '../trajectory.mjs';

test('assertFactForcing accepts when all required caller/consumer reads are present', () => {
  assert.doesNotThrow(() => {
    assertFactForcing('tools/review/gatekeeper.mjs', {
      reads: ['tools/review/budget.mjs', 'tools/tests/spend-safety.test.mjs'],
      required: ['tools/tests/spend-safety.test.mjs'],
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
