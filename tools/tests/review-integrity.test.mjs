import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeSourceDigest } from '../review-evidence.mjs';
import { readFileSync, symlinkSync } from 'node:fs';
import { runReviewRecord, recordStageB, validateReviewEvidence, loadReviewEvidence, saveReviewEvidence, computeEventProjectionHash, countSourceChanges } from '../review-evidence.mjs';
import { nativeRunner, prepareEvidence, writeEvidence } from './fixtures/review-execution.mjs';
import { inspectProduct, executeProduct } from '../review-native-tools.mjs';
import { cmdStart, cmdArtifact, cmdClose } from '../workflow.mjs';

// Parent-owned execution: node --test tools/tests/review-integrity.test.mjs
// If dirty-status hashing causes the defect, hashing snapshot bytes detects the second edit.
// If HEAD causes false staleness, a commit with identical source leaves the digest unchanged.
// If recursive cache exclusion hides source, editing src/cache changes the digest.
test('source identity binds repeated dirty bytes, not commits or nested cache names', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-content-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init', '-q');
    mkdirSync(join(root, 'src', 'cache'), { recursive: true });
    writeFileSync(join(root, 'src', 'cache', 'code.js'), 'a');
    git('add', '.'); git('commit', '-qm', 'initial');
    writeFileSync(join(root, 'src', 'cache', 'code.js'), 'b');
    const b = computeSourceDigest(root);
    writeFileSync(join(root, 'src', 'cache', 'code.js'), 'c');
    const c = computeSourceDigest(root);
    assert.notEqual(b, c);
    git('add', '.'); git('commit', '-qm', 'same content');
    assert.equal(computeSourceDigest(root), c);
    mkdirSync(join(root, '.tmp'), { recursive: true });
    writeFileSync(join(root, '.tmp', 'generated'), 'ignored');
    assert.equal(computeSourceDigest(root), c);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-integrity-'));
  const changeId = 'integrity', changeDir = join(root, 'openspec', 'changes', changeId);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'manifest.md'), '| R01 | User needs product result |\n');
  prepareEvidence(root, changeId);
  writeFileSync(join(root, 'product.cjs'), 'exports.answer = () => 42 + 0;\n');
  writeFileSync(join(root, 'tests', 'consumer.cjs'), "require('node:assert/strict').equal(require('../product.cjs').answer(), 42);\n");
  const testCmd = `"${process.execPath}" tests/consumer.cjs`;
  return { root, changeId, changeDir, testCmd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function review(f, role = 'reviewer', extra = {}) {
  return runReviewRecord({ root: f.root, changeId: f.changeId, role, ompRunner: nativeRunner(undefined, undefined, 'correct', extra) });
}

test('native integrity requires retained events, projection and matching outer fields', () => {
  const f = fixture();
  try {
    writeEvidence(f.root, f.changeDir, f.changeId);
    const pristine = loadReviewEvidence(f.changeDir);
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
    for (const mutate of [
      data => { delete data.reviewer.nativeProjection; },
      data => { delete data.reviewer.nativeEvents; },
      data => { data.reviewer.model = 'forged-model'; },
      data => { data.reviewer.usage.input = '100'; },
      data => { data.oracles[0].verdict = 'REJECT'; },
      data => { data.reviewer.nativeEvents.find(e => e.customType === 'workflow-review-context').data.sourceDigest = 'forged'; data.reviewer.nativeEventsHash = computeEventProjectionHash(data.reviewer.nativeEvents); },
      data => { data.stageB.after.exitCode = null; },
    ]) {
      const data = structuredClone(pristine); mutate(data); saveReviewEvidence(f.changeDir, data);
      assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, false);
    }
  } finally { f.cleanup(); }
});

test('native usage rejects coercion, fractions, unsafe integers and unknown costs; cached zero is valid', () => {
  const f = fixture();
  try {
    for (const input of ['100', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', ompRunner: nativeRunner(undefined, { input, output: 50 }) }), /token usage/);
    }
    for (const costUsd of [NaN, Infinity, -1, 0]) assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', ompRunner: nativeRunner(undefined, undefined, 'correct', { costUsd }) }), /cost/i);
    const recorded = runReviewRecord({ ...f, role: 'reviewer', ompRunner: nativeRunner(undefined, { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 }) });
    assert.equal(recorded.record.usage.input, 0);
    assert.equal(recorded.record.usage.cacheRead, 0);
    assert.equal(recorded.record.usage.costSource, 'native-fixed-tariff');
  } finally { f.cleanup(); }
});

test('effective selector is exact, not a substring or wrong provider', () => {
  const f = fixture();
  try {
    for (const model of ['sonnet', 'anthropic/claude-3-5', 'wrong/claude-3-5-sonnet']) {
      assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', model, ompRunner: nativeRunner() }), /effective model mismatch/);
    }
  } finally { f.cleanup(); }
});

test('complete terminal report retains findings beyond the former snippet limit', () => {
  const f = fixture();
  try {
    const report = { findings: [{ title: 'Retain defect', body: 'x'.repeat(1200), priority: 1, confidence: 1, file_path: 'product.cjs', line_start: 1, line_end: 1 }], overall_correctness: 'incorrect', overall_explanation: 'Product defect', overall_confidence_score: 1 };
    const result = review(f, 'reviewer', { text: JSON.stringify(report) });
    assert.deepEqual(JSON.parse(result.record.report), report);
    assert.equal(result.record.verdict, 'REJECT');
  } finally { f.cleanup(); }
});

test('only the final completed assistant can decide; earlier ACCEPT cannot mask partial/error completion', () => {
  const f = fixture();
  try {
    for (const stopReason of [undefined, 'toolUse', 'error', 'length', 'aborted']) {
      const good = nativeRunner();
      const runner = args => {
        const result = good(args), entries = result.stdout.split('\n').map(JSON.parse);
        const final = structuredClone(entries.find(e => e.type === 'message'));
        final.message.stopReason = stopReason;
        final.message.content = stopReason === 'toolUse' ? [{ type: 'toolCall', name: 'inspect_product', id: 'pending' }] : [{ type: 'text', text: 'ACCEPT echoed by unfinished response' }];
        entries.push(final); return { status: 0, stdout: entries.map(e => JSON.stringify(e)).join('\n') };
      };
      assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', ompRunner: runner }), /stop reason|final report/);
    }
  } finally { f.cleanup(); }
});

test('actual Stage-B source chain supports simplification and freezes tests from reviewer A', () => {
  const f = fixture();
  try {
    const a = review(f).record.sourceDigest;
    recordStageB({ ...f, phase: 'before' });
    writeFileSync(join(f.root, 'product.cjs'), 'exports.answer = () => 42;\n');
    const stage = recordStageB({ ...f, phase: 'after', disposition: 'simplified' }).stageB;
    assert.equal(stage.sourceDigestBefore, a);
    assert.notEqual(stage.sourceDigestAfter, a);
    review(f, 'oracle');
    assert.equal(validateReviewEvidence({ ...f, tier: 'T3' }).ok, true);
    writeFileSync(join(f.root, 'tests', 'consumer.cjs'), '// weakened test\n');
    assert.equal(validateReviewEvidence({ ...f, tier: 'T3' }).ok, false);
    assert.throws(() => recordStageB({ ...f, phase: 'after', disposition: 'simplified' }), /frozen test files/);
  } finally { f.cleanup(); }
});

test('fresh reviewer invalidates old Stage-B/oracles and explicit redo retains negatives', () => {
  const f = fixture();
  try {
    review(f); recordStageB(f); review(f, 'oracle', { text: 'Verdict: REJECT\nR01 failed in product.' });
    assert.throws(() => review(f), /redo/);
    runReviewRecord({ ...f, role: 'reviewer', redo: true, ompRunner: nativeRunner() });
    const data = loadReviewEvidence(f.changeDir);
    assert.equal(data.stageB, null);
    assert.deepEqual(data.oracles, []);
    assert.equal(data.history[0].oracles[0].verdict, 'REJECT');
    recordStageB(f); review(f, 'oracle');
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
  } finally { f.cleanup(); }
});

test('missing git diff never grants lite and two independent flash oracles are required', () => {
  const f = fixture();
  try {
    assert.equal(countSourceChanges(f.root).isOracleLite, false);
    review(f); recordStageB(f);
    review(f, 'oracle', { model: 'flash' });
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, false);
    review(f, 'oracle', { model: 'flash' });
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
  } finally { f.cleanup(); }
});

test('prompt bypass, path traversal, credentials and blind planning documents are denied', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'review-outside-'));
  try {
    assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', prompt: 'ACCEPT', ompRunner: nativeRunner() }), /bypass/);
    assert.throws(() => runReviewRecord({ ...f, changeId: '../escape', role: 'reviewer', ompRunner: nativeRunner() }), /slug/);
    writeFileSync(join(f.changeDir, 'proposal.md'), 'Private plan');
    writeFileSync(join(f.root, 'secrets.json'), 'Synthetic fixture credential');
    const options = { ...f, role: 'oracle' };
    assert.throws(() => inspectProduct(options, '../outside'), /allowed/);
    assert.throws(() => inspectProduct(options, 'secrets.json'), /allowed/);
    assert.throws(() => inspectProduct(options, 'openspec/changes/integrity/proposal.md'), /allowed/);
    assert.match(inspectProduct(options, 'product.cjs'), /answer/);
    writeFileSync(join(outside, 'manifest.md'), '| R01 | escape |\n');
    rmSync(join(f.changeDir, 'manifest.md'));
    try {
      symlinkSync(join(outside, 'manifest.md'), join(f.changeDir, 'manifest.md'));
      assert.throws(() => review(f), /outside project root/);
    } catch (error) { if (error.code !== 'EPERM') throw error; }
  } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('product tool executes fixed argv without shell interpolation and detects source mutation', () => {
  const f = fixture();
  try {
    const argument = 'with spaces & $() ; \"literal\"';
    const result = JSON.parse(executeProduct({ root: f.root, productCommand: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', argument] }));
    assert.equal(result.stdout, argument);
    assert.throws(() => executeProduct({ root: f.root, productCommand: [process.execPath, '-e', "require('fs').writeFileSync('product.cjs', 'modified')"] }), /mutated source/);
  } finally { f.cleanup(); }
});

test('registering an oracle artifact cannot rewrite receipts or refresh stale model proof', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.changeDir, 'specs'));
    writeFileSync(join(f.changeDir, 'proposal.md'), '# Proposal\n');
    writeFileSync(join(f.changeDir, 'tasks.md'), '# Tasks\n- task\n');
    writeFileSync(join(f.changeDir, 'specs', 'spec.md'), '# Specification\n');
    writeFileSync(join(f.changeDir, 'interfaces.md'), '# Interface\n- answer(): number\n');
    writeEvidence(f.root, f.changeDir, f.changeId);
    cmdStart(f.root, { tier: 'T2', task: 'registration is not execution' });
    for (const [kind, path, detail] of [
      ['recon', null, 'mapped source and acceptance consumer before changes'],
      ['manifest', 'openspec/changes/integrity/manifest.md', 'R01 captured from original user requirement'],
      ['openspec', 'openspec/changes/integrity', 'validated complete change artifacts'],
      ['interfaces', 'openspec/changes/integrity/interfaces.md', 'public answer signature and invariants documented'],
    ]) assert.equal(cmdArtifact(f.root, { kind, path, detail }), 0);
    const before = readFileSync(join(f.changeDir, 'review-evidence.json'), 'utf8');
    writeFileSync(join(f.root, 'product.cjs'), 'exports.answer = () => 41;\n');
    assert.equal(cmdArtifact(f.root, { kind: 'oracle', detail: 'ACCEPT: manually registering existing evidence' }), 0);
    assert.equal(readFileSync(join(f.changeDir, 'review-evidence.json'), 'utf8'), before);
    assert.equal(cmdClose(f.root, {}), 1);
  } finally { f.cleanup(); }
});

test('tracked credentials bind repeated dirty bytes without publishing their contents', () => {
  const f = fixture();
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    writeFileSync(join(f.root, 'credentials.cjs'), 'synthetic-secret-one');
    git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'source']);
    writeFileSync(join(f.root, 'credentials.cjs'), 'synthetic-secret-two');
    const before = computeSourceDigest(f.root);
    review(f); recordStageB(f); review(f, 'oracle');
    const receipt = readFileSync(join(f.changeDir, 'review-evidence.json'), 'utf8');
    assert.doesNotMatch(receipt, /synthetic-secret/);
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
    writeFileSync(join(f.root, 'credentials.cjs'), 'synthetic-secret-three');
    assert.notEqual(computeSourceDigest(f.root), before);
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, false);
  } finally { f.cleanup(); }
});

test('oracle must exercise product natively; terminal ACCEPT alone is insufficient', () => {
  const f = fixture();
  try {
    review(f); recordStageB(f);
    const runner = nativeRunner();
    assert.throws(() => runReviewRecord({ ...f, role: 'oracle', ompRunner: args => {
      const result = runner(args);
      return { status: 0, stdout: result.stdout.split('\n').map(JSON.parse).filter(e => e.customType !== 'workflow-product-execution').map(e => JSON.stringify(e)).join('\n') };
    } }), /actual native product execution/);
  } finally { f.cleanup(); }
});

test('explicit redo keeps historical Markdown REJECT while accepting a newly executed cycle', () => {
  const f = fixture();
  try {
    review(f); recordStageB(f); review(f, 'oracle', { text: 'Verdict: REJECT\nR01 fails.' });
    writeFileSync(join(f.changeDir, 'oracle-old.md'), 'Verdict: REJECT\nOriginal negative evidence.\n');
    runReviewRecord({ ...f, role: 'reviewer', redo: true, ompRunner: nativeRunner() });
    recordStageB(f); review(f, 'oracle');
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
    assert.match(readFileSync(join(f.changeDir, 'oracle-old.md'), 'utf8'), /Original negative evidence/);
    assert.equal(loadReviewEvidence(f.changeDir).history[0].oracles[0].verdict, 'REJECT');
  } finally { f.cleanup(); }
});

test('lean-already executes two actual frozen greens with coherent native clocks', () => {
  const f = fixture();
  try {
    const reviewer = review(f).record;
    let runs = 0;
    const stage = recordStageB({ ...f, testRunner: () => {
      runs++;
      return spawnSync(process.execPath, ['tests/consumer.cjs'], { cwd: f.root, encoding: 'utf8' });
    } }).stageB;
    assert.equal(runs, 2, 'before/after greens cannot reuse one receipt');
    assert.notStrictEqual(stage.before, stage.after);
    assert.ok(stage.before.startedAt >= reviewer.completedAt);
    assert.ok(stage.after.startedAt >= stage.before.completedAt);
    assert.equal(stage.executedAt, stage.after.completedAt);
    review(f, 'oracle');
    assert.equal(validateReviewEvidence({ ...f, tier: 'T2' }).ok, true);
    assert.throws(() => review(f), /redo/);
  } finally { f.cleanup(); }
});

test('native context, selection, timestamps and product results fail closed before saving proof', () => {
  const f = fixture();
  try {
    const cases = [
      [entries => { entries[0].timestamp = 'yesterday'; }, /timestamp/],
      [entries => { entries[0].timestamp = '0'; }, /timestamp/],
      [entries => { entries.splice(0, 1); }, /session ID/],
      [entries => { entries.splice(1, 1); }, /model selection/],
      [entries => { entries.splice(2, 1); }, /review context/],
      [entries => { entries[2].data.manifestHash = 'forged'; }, /context differs/],
      [entries => { delete entries.at(-1).message.timestamp; }, /timestamp/],
      [entries => { entries.at(-1).timestamp = '1970-01-01T00:00:00.000Z'; }, /timestamp inversion/],
      [entries => { entries.at(-1).message.usage.totalTokens++; }, /totalTokens/],
      [entries => { entries.at(-1).message.content.push({ type: 'toolCall', id: 'pending', name: 'inspect_product' }); }, /unresolved tool calls/],
    ];
    for (const [mutate, expected] of cases) {
      const transport = nativeRunner();
      assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', ompRunner: args => {
        const result = transport(args), entries = result.stdout.split('\n').map(JSON.parse);
        mutate(entries);
        return { status: 0, stdout: entries.map(e => JSON.stringify(e)).join('\n') };
      } }), expected);
    }
    review(f); recordStageB(f);
    for (const [key, value, expected] of [
      ['outputHash', 'not-a-sha256', /provenance/],
      ['commandHash', 'forged-command', /provenance/],
      ['exitCode', 1, /failed product execution/],
    ]) {
      const transport = nativeRunner();
      assert.throws(() => runReviewRecord({ ...f, role: 'oracle', ompRunner: args => {
        const result = transport(args), entries = result.stdout.split('\n').map(JSON.parse);
        entries.find(e => e.customType === 'workflow-product-execution').data[key] = value;
        return { status: 0, stdout: entries.map(e => JSON.stringify(e)).join('\n') };
      } }), expected);
    }
    assert.deepEqual(loadReviewEvidence(f.changeDir).oracles, []);
  } finally { f.cleanup(); }
});

test('review request contains approved role body, full source and manifest without credentials', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'agent', 'agents', 'reviewer.md'), '---\noutput: old-schema\n---\nApproved review instructions.\n');
    writeFileSync(join(f.root, 'secrets.json'), 'synthetic-do-not-send');
    const transport = nativeRunner();
    runReviewRecord({ ...f, role: 'reviewer', ompRunner: args => {
      assert.match(args.prompt, /Approved review instructions/);
      assert.match(args.prompt, /User needs product result/);
      assert.match(args.prompt, /exports.answer = \(\) => 42 \+ 0/);
      assert.doesNotMatch(args.prompt, /synthetic-do-not-send/);
      return transport(args);
    } });
    const transport2 = nativeRunner();
    assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', redo: true, ompRunner: args => {
      const result = transport2(args);
      writeFileSync(join(f.root, 'product.cjs'), 'exports.answer = () => 0;\n');
      return result;
    } }), /mutated during review/);
  } finally { f.cleanup(); }
});

test('adding or deleting frozen tests blocks Stage-B instead of laundering a smaller suite', () => {
  const f = fixture();
  try {
    review(f); recordStageB({ ...f, phase: 'before' });
    const path = join(f.root, 'tests', 'added.test.cjs');
    writeFileSync(path, "require('node:assert/strict').equal(require('../product.cjs').answer(), 42);\n");
    assert.throws(() => recordStageB(f), /frozen test files/);
    rmSync(path);
    rmSync(join(f.root, 'tests', 'consumer.cjs'));
    assert.throws(() => recordStageB(f), /frozen test files/);
  } finally { f.cleanup(); }
});

test('malformed command argv and symlinked role or receipt cannot cross native trust boundaries', () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'native-boundary-'));
  try {
    for (const productCommand of [[], [1], [''], ['node', '\0'], 'node']) {
      assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', productCommand, ompRunner: nativeRunner() }), /JSON argv/);
      assert.throws(() => executeProduct({ root: f.root, productCommand }), /operator-authorized/);
    }
    writeEvidence(f.root, f.changeDir, f.changeId);
    for (const [path, content, expected] of [
      [join(f.root, 'agent', 'agents', 'reviewer.md'), '# outside role\n', /outside project root/],
      [join(f.changeDir, 'review-evidence.json'), '{}', /escapes change directory/],
    ]) {
      const original = readFileSync(path);
      const target = join(outside, 'outside-file');
      writeFileSync(target, content);
      rmSync(path);
      try {
        symlinkSync(target, path);
        assert.throws(() => runReviewRecord({ ...f, role: 'reviewer', redo: true, ompRunner: nativeRunner() }), expected);
      } catch (error) { if (error.code !== 'EPERM') throw error; }
      finally { rmSync(path, { force: true }); writeFileSync(path, original); }
    }
  } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test('reviewer terminal JSON must retain complete typed findings and verdict fields', () => {
  const f = fixture();
  try {
    const report = { findings: [], overall_correctness: 'correct', overall_explanation: 'R01 consumer passed.', overall_confidence_score: 0.9 };
    for (const mutate of [
      value => { delete value.overall_explanation; value.explanation = 'old contract'; },
      value => { value.overall_explanation = ' '; },
      value => { value.overall_confidence_score = '0.9'; },
      value => { value.overall_confidence_score = 2; },
      value => { value.findings = [null]; },
      value => { value.findings = [{ title: 'Missing defect location' }]; },
    ]) {
      const value = structuredClone(report); mutate(value);
      assert.throws(() => review(f, 'reviewer', { text: JSON.stringify(value) }), /schema|typed findings/);
    }
    assert.throws(() => review(f, 'reviewer', { text: 'ACCEPT: echoed without terminal JSON' }), /complete typed JSON/);
  } finally { f.cleanup(); }
});
