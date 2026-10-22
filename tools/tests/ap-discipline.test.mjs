import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkerReport } from '../worker-contract.mjs';
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

test('contract valid: accepts compliant report with REDPROOF and mandatory sections', () => {
  const validReport = [
    'STATUS: DONE',
    'FILES: tools/worker-contract.mjs, tools/checklists.mjs',
    'TESTS: node --test tools/tests/ap-discipline.test.mjs -> было 0 -> стало 6',
    'INTERFACES: validateWorkerReport, depthChecklist, adversarialPass, scoreReview, consolidateF1, repairBudget',
    'REQUIREMENTS: R04, R08, R09',
    'CONCERNS: none',
    'REDPROOF: node --test tools/tests/ap-discipline.test.mjs failed with ERR_MODULE_NOT_FOUND',
  ].join('\n');

  const res = validateWorkerReport(validReport);
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('contract invalid: rejects missing REDPROOF line and missing sections naming violations', () => {
  const missingRedproof = [
    'STATUS: DONE',
    'FILES: tools/worker-contract.mjs',
    'TESTS: node --test',
    'INTERFACES: validateWorkerReport',
    'REQUIREMENTS: R04',
    'CONCERNS: none',
  ].join('\n');

  const res1 = validateWorkerReport(missingRedproof);
  assert.equal(res1.ok, false);
  assert.ok(res1.violations.some(v => /REDPROOF/i.test(v)));

  const missingSections = [
    'STATUS: DONE',
    'FILES: tools/worker-contract.mjs',
    'REDPROOF: test failed as expected',
  ].join('\n');

  const res2 = validateWorkerReport(missingSections);
  assert.equal(res2.ok, false);
  assert.ok(res2.violations.some(v => /TESTS/i.test(v)));
  assert.ok(res2.violations.some(v => /INTERFACES/i.test(v)));
  assert.ok(res2.violations.some(v => /REQUIREMENTS/i.test(v)));
  assert.ok(res2.violations.some(v => /CONCERNS/i.test(v)));

  const nonString = validateWorkerReport(null);
  assert.equal(nonString.ok, false);
  assert.ok(nonString.violations.length > 0);
});

test('contract oversize: rejects reports exceeding 25 non-empty lines naming violation', () => {
  const lines = [
    'STATUS: DONE',
    'FILES: tools/worker-contract.mjs',
    'TESTS: node --test',
    'INTERFACES: validateWorkerReport',
    'REQUIREMENTS: R04',
    'CONCERNS: none',
    'REDPROOF: test failed',
  ];
  for (let i = 1; i <= 20; i++) {
    lines.push(`Extra comment line ${i}`);
  }
  // Total non-empty lines: 7 + 20 = 27 (> 25)
  const oversizeReport = lines.join('\n');

  const res = validateWorkerReport(oversizeReport);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some(v => /oversize|exceeds/i.test(v)));
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

test('budget allows/refuses: allows within budget, throws when repairs>2, retries>2, reReviews>1', () => {
  // Allow cases
  const allowance0 = repairBudget({ repairs: 0, retries: 0, reReviews: 0 });
  assert.deepEqual(allowance0, { repairs: 2, retries: 2, reReviews: 1 });

  const allowanceMax = repairBudget({ repairs: 2, retries: 2, reReviews: 1 });
  assert.deepEqual(allowanceMax, { repairs: 0, retries: 0, reReviews: 0 });

  const allowancePartial = repairBudget({ repairs: 1, retries: 1, reReviews: 0 });
  assert.deepEqual(allowancePartial, { repairs: 1, retries: 1, reReviews: 1 });

  // Default empty state
  assert.deepEqual(repairBudget(), { repairs: 2, retries: 2, reReviews: 1 });

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

  // Refuse cases: reReviews > 1
  assert.throws(
    () => repairBudget({ repairs: 0, retries: 0, reReviews: 2 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /reReview/i);
      assert.match(err.message, /1/);
      return true;
    }
  );
});
