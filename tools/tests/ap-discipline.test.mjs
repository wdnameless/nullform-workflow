import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReturnContract } from '../return-contract.mjs';
import {
  DEPTH_DIMENSIONS,
  ADVERSARIAL_QUESTIONS,
  depthChecklist,
  adversarialPass,
} from '../checklists.mjs';
import {
  scoreReview,
  consolidateF1,
  repairBudget,
} from '../review/arbitrate.mjs';

test('contract valid: accepts a compliant report with mandatory sections', () => {
  const validReport = [
    'STATUS: DONE',
    'FILES: tools/return-contract.mjs, tools/checklists.mjs',
    'TESTS: было 6 → стало 6',
    'INTERFACES: validateReturnContract, depthChecklist, adversarialPass',
    'REQUIREMENTS: R04, R08, R09',
    'CONCERNS: none',
  ].join('\n');
  const res = validateReturnContract(validReport);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test('contract invalid: rejects missing sections, prose FILES and non-numeric TESTS', () => {
  const missing = ['STATUS: DONE', 'CONCERNS: none'].join('\n');
  const res1 = validateReturnContract(missing);
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.some((e) => /FILES|TESTS|INTERFACES|REQUIREMENTS/i.test(e)));

  // The deleted worker-contract copy accepted this: prose in FILES and a free-text
  // TESTS value passed its section-only check.
  const weak = [
    'STATUS: DONE',
    'FILES: some prose describing things',
    'TESTS: whatever',
    'INTERFACES: none',
    'REQUIREMENTS: R01',
    'CONCERNS: none',
  ].join('\n');
  const res2 = validateReturnContract(weak);
  assert.equal(res2.valid, false, 'prose FILES must be refused');
  assert.ok(res2.errors.some((e) => /FILES/i.test(e)));
  assert.ok(res2.errors.some((e) => /TESTS/i.test(e)));
});

test('contract oversize: rejects reports exceeding 25 lines', () => {
  const lines = [
    'STATUS: DONE',
    'FILES: tools/return-contract.mjs',
    'TESTS: было 1 → стало 2',
    'INTERFACES: validateReturnContract',
    'REQUIREMENTS: R04',
    'CONCERNS: none',
  ];
  for (let i = 1; i <= 20; i++) lines.push(`Extra line ${i}`);
  const res = validateReturnContract(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /25|строк/i.test(e)));
});
test('depth missing names: reports missing depth dimensions keyword-anchored', () => {
  assert.equal(DEPTH_DIMENSIONS.length, 8);

  const partialSpec = `
    # Spec
    Covers first-run experience.
    Handles empty state when no items exist.
    Also handles boundaries between modules.
  `;

  const missing = depthChecklist(partialSpec);
  assert.ok(!missing.includes('first-run'));
  assert.ok(!missing.includes('empty'));
  assert.ok(!missing.includes('boundaries'));
  assert.ok(missing.includes('wrong-input'));
  assert.ok(missing.includes('failure'));
  assert.ok(missing.includes('interruption'));
  assert.ok(missing.includes('growth'));
  assert.ok(missing.includes('aftermath'));

  const emptySpecMissing = depthChecklist('');
  assert.deepEqual(emptySpecMissing, DEPTH_DIMENSIONS);

  const fullSpec = `
    first-run setup
    empty collections
    wrong-input validation
    failure recovery
    interruption graceful stop
    growth scaling
    boundaries between layers
    aftermath cleanup
  `;
  assert.deepEqual(depthChecklist(fullSpec), []);
});

test('adversarial returns 7: returns static documented question prompts', () => {
  assert.equal(ADVERSARIAL_QUESTIONS.length, 7);
  const questions = adversarialPass('Some brief text');
  assert.equal(questions.length, 7);
  for (const q of questions) {
    assert.equal(typeof q, 'string');
    assert.ok(q.trim().length > 0);
  }
});

test('axes scored independently: scores blocker findings per axis, ignores minor', () => {
  const findings = [
    { axis: 'manifest', severity: 'blocker', text: 'R04 missing' },
    { axis: 'manifest', severity: 'blocker', text: 'R08 missing' },
    { axis: 'manifest', severity: 'minor', text: 'typo in manifest' },
    { axis: 'spec', severity: 'blocker', text: 'missing boundary scenario' },
    { axis: 'spec', severity: 'minor', text: 'formatting note' },
    { axis: 'craft', severity: 'blocker', text: 'unhandled promise rejection' },
    { axis: 'craft', severity: 'minor', text: 'variable naming' },
  ];

  const scores = scoreReview(findings);
  assert.deepEqual(scores, {
    manifest: 2,
    spec: 1,
    craft: 1,
  });

  assert.deepEqual(scoreReview([]), { manifest: 0, spec: 0, craft: 0 });
});

test('F1 merges: consolidates branch blockers into single F1 ticket', () => {
  const blockers = [
    { axis: 'manifest', severity: 'blocker', text: 'missing R04' },
    { axis: 'craft', severity: 'blocker', text: 'failing test' },
  ];

  const ticket = consolidateF1(blockers);
  assert.equal(ticket.id, 'F1');
  assert.deepEqual(ticket.items, blockers);

  const mixed = [
    { axis: 'spec', severity: 'blocker', text: 'spec gap' },
    { axis: 'spec', severity: 'minor', text: 'style hint' },
  ];
  const ticket2 = consolidateF1(mixed);
  assert.equal(ticket2.id, 'F1');
  assert.deepEqual(ticket2.items, [
    { axis: 'spec', severity: 'blocker', text: 'spec gap' },
  ]);
});

test('budget allows/refuses: allows within budget, throws when repairs>2, retries>2, reReviews>2', () => {
  // Allow cases
  const allowance0 = repairBudget({ repairs: 0, retries: 0, reReviews: 0 });
  assert.deepEqual(allowance0, { repairs: 2, retries: 2, reReviews: 2 });

  const allowanceMax = repairBudget({ repairs: 2, retries: 2, reReviews: 2 });
  assert.deepEqual(allowanceMax, { repairs: 0, retries: 0, reReviews: 0 });

  const allowancePartial = repairBudget({ repairs: 1, retries: 1, reReviews: 1 });
  assert.deepEqual(allowancePartial, { repairs: 1, retries: 1, reReviews: 1 });

  // Default empty state
  assert.deepEqual(repairBudget(), { repairs: 2, retries: 2, reReviews: 2 });

  // Refuse cases: repairs > 2
  assert.throws(
    () => repairBudget({ repairs: 3, retries: 0, reReviews: 0 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /repair/i);
      assert.match(err.message, /2/);
      return true;
    }
  );

  // Refuse cases: retries > 2
  assert.throws(
    () => repairBudget({ repairs: 0, retries: 3, reReviews: 0 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /retr/i);
      assert.match(err.message, /2/);
      return true;
    }
  );

  // Refuse cases: reReviews > 2 (CONTEXT.md: one initial review + at most two re-reviews)
  assert.throws(
    () => repairBudget({ repairs: 0, retries: 0, reReviews: 3 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /reReview/i);
      assert.match(err.message, /2/);
      return true;
    }
  );
});
