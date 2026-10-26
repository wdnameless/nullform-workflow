import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBriefRounds, appendAddenda } from '../brief-rounds.mjs';
import { cmdBrief, runWorkflowCli } from '../workflow.mjs';
import { freezeBrief } from '../brief.mjs';
import { recount } from '../requirements.mjs';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'u-brief-test-'));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

test('brief-rounds: stub-ask records answers and appends addenda to manifest fixture', async () => {
  await withTmpDir(async (dir) => {
    const manifestPath = join(dir, 'manifest.md');
    writeFileSync(manifestPath, `# Sample Manifest\n\n| ID | Verbatim user quote | Observable acceptance | Status |\n|---|---|---|---|\n| R01 | «base req» | base acc | open |\n`);

    const stubAnswers = {
      0: 'Custom answer for failure handling',
      1: 'Custom answer for first-run init',
    };

    let callCount = 0;
    const stubAsk = async (question, defaultAnswer) => {
      assert.ok(typeof question === 'string' && question.length > 0);
      assert.ok(typeof defaultAnswer === 'string' && defaultAnswer.length > 0);
      const ans = stubAnswers[callCount] || defaultAnswer;
      callCount++;
      return ans;
    };

    const brief = 'Initial project brief without depth dimensions.';
    const addenda = await runBriefRounds(brief, { rounds: 2, ask: stubAsk });

    assert.equal(addenda.length, 2);
    assert.equal(addenda[0].id, 'G01');
    assert.equal(addenda[0].answer, 'Custom answer for failure handling');
    assert.equal(addenda[1].id, 'G02');
    assert.equal(addenda[1].answer, 'Custom answer for first-run init');

    appendAddenda(manifestPath, addenda);

    const updated = readFileSync(manifestPath, 'utf8');
    assert.match(updated, /## Дополнения/);
    assert.match(updated, /\| G01 \|/);
    assert.match(updated, /\| G02 \|/);
    assert.match(updated, /Custom answer for failure handling/);

    const counts = recount(updated);
    assert.equal(counts.R, 1);
    assert.equal(counts.G, 2);
    assert.equal(counts.total, 3);
  });
});

test('brief-rounds: defaults applied on empty or whitespace answers', async () => {
  await withTmpDir(async (dir) => {
    const manifestPath = join(dir, 'manifest.md');
    writeFileSync(manifestPath, `# Manifest\n`);

    // stub returns empty strings or whitespace
    let askCalls = 0;
    const stubAsk = async () => {
      askCalls++;
      return askCalls % 2 === 0 ? '' : '   ';
    };

    const addenda = await runBriefRounds('Some brief', { rounds: 2, ask: stubAsk });
    assert.equal(addenda.length, 2);
    assert.equal(addenda[0].answer, addenda[0].defaultAnswer);
    assert.equal(addenda[1].answer, addenda[1].defaultAnswer);
    assert.ok(addenda[0].defaultAnswer.length > 0);

    appendAddenda(manifestPath, addenda);
    const content = readFileSync(manifestPath, 'utf8');
    assert.match(content, /## Дополнения/);
    assert.match(content, /\| G01 \|/);
    assert.match(content, /\| G02 \|/);

    const counts = recount(content);
    assert.equal(counts.G, 2);
  });
});

test('brief-rounds: rounds limit defaults to 2 and clamps between 1 and 5', async () => {
  const ask = async (_q, def) => def;

  // default rounds (omitted) -> 2
  const defAddenda = await runBriefRounds('Brief', { ask });
  assert.equal(defAddenda.length, 2);

  // rounds = 1
  const r1Addenda = await runBriefRounds('Brief', { rounds: 1, ask });
  assert.equal(r1Addenda.length, 1);
  assert.equal(r1Addenda[0].id, 'G01');

  // rounds = 3
  const r3Addenda = await runBriefRounds('Brief', { rounds: 3, ask });
  assert.equal(r3Addenda.length, 3);
  assert.equal(r3Addenda[2].id, 'G03');

  // rounds = 10 -> clamped to 5
  const r10Addenda = await runBriefRounds('Brief', { rounds: 10, ask });
  assert.equal(r10Addenda.length, 5);
  assert.equal(r10Addenda[4].id, 'G05');

  // rounds = 0 or negative -> fallback to default 2
  const r0Addenda = await runBriefRounds('Brief', { rounds: 0, ask });
  assert.equal(r0Addenda.length, 2);
});

test('workflow cmdBrief: CLI flag parsing and direct invocation', async () => {
  await withTmpDir(async (root) => {
    const manifestPath = join(root, 'manifest.md');
    writeFileSync(manifestPath, `# Manifest\n\n| ID | Requirement | Acceptance | Status |\n|---|---|---|---|\n| R01 | R1 | A1 | open |\n`);

    const briefFilePath = join(root, 'brief.txt');
    writeFileSync(briefFilePath, 'Detailed brief content for testing.');

    // 1. Missing manifest flag should fail (exit 1)
    const errCode = await cmdBrief(root, {});
    assert.equal(errCode, 1);

    // 2. Direct cmdBrief call with --rounds, --manifest, --brief flags
    const answers = ['Answer 1', 'Answer 2', 'Answer 3'];
    let idx = 0;
    const stubAsk = async () => answers[idx++] || 'Fallback';

    const okCode = await cmdBrief(root, {
      rounds: '3',
      manifest: 'manifest.md',
      brief: 'brief.txt',
    }, { ask: stubAsk });

    assert.equal(okCode, 0);

    const manifestContent = readFileSync(manifestPath, 'utf8');
    assert.match(manifestContent, /## Дополнения/);
    assert.match(manifestContent, /\| G01 \|/);
    assert.match(manifestContent, /\| G02 \|/);
    assert.match(manifestContent, /\| G03 \|/);
    assert.match(manifestContent, /Answer 1/);
    assert.match(manifestContent, /Answer 2/);
    assert.match(manifestContent, /Answer 3/);

    const counts = recount(manifestContent);
    assert.equal(counts.R, 1);
    assert.equal(counts.G, 3);
    assert.equal(counts.total, 4);
  });
});

test('workflow cmdBrief: reads inline brief argument string and discovers frozen brief', async () => {
  await withTmpDir(async (root) => {
    const changeDir = join(root, 'openspec', 'changes', 'my-change');
    mkdirSync(changeDir, { recursive: true });
    const manifestPath = join(changeDir, 'manifest.md');
    writeFileSync(manifestPath, `# Manifest\n`);

    // Inline string test
    const stubAsk = async (_q, def) => def;
    const code1 = await cmdBrief(root, {
      rounds: 1,
      manifest: 'openspec/changes/my-change/manifest.md',
      brief: 'Inline brief string without file',
    }, { ask: stubAsk });
    assert.equal(code1, 0);

    let content = readFileSync(manifestPath, 'utf8');
    assert.match(content, /\| G01 \|/);

    // Frozen brief discovery test (brief flag omitted)
    freezeBrief(changeDir, 'Frozen brief text in directory');
    const code2 = await cmdBrief(root, {
      rounds: 2,
      manifest: 'openspec/changes/my-change/manifest.md',
    }, { ask: stubAsk });
    assert.equal(code2, 0);

    content = readFileSync(manifestPath, 'utf8');
    assert.match(content, /\| G02 \|/);
    assert.match(content, /\| G03 \|/);
    const counts = recount(content);
    assert.equal(counts.G, 3);
  });
});

test('appendAddenda: multiple calls preserve sequential numbering without duplicate headers', async () => {
  await withTmpDir(async (root) => {
    const manifestPath = join(root, 'manifest.md');
    writeFileSync(manifestPath, `# Manifest\n`);

    appendAddenda(manifestPath, [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);

    appendAddenda(manifestPath, [
      { question: 'Q3', answer: 'A3' },
    ]);

    const content = readFileSync(manifestPath, 'utf8');
    const headerMatches = content.match(/##\s*Дополнения/g);
    assert.equal(headerMatches.length, 1);

    assert.match(content, /\| G01 \|/);
    assert.match(content, /\| G02 \|/);
    assert.match(content, /\| G03 \|/);

    const counts = recount(content);
    assert.equal(counts.G, 3);
  });
});

test('runWorkflowCli: dispatches brief command with exit code 0', async () => {
  await withTmpDir(async (root) => {
    const manifestPath = join(root, 'manifest.md');
    writeFileSync(manifestPath, `# Manifest\n`);

    const stubAsk = async (_q, def) => `CLI answer: ${def}`;
    const res = runWorkflowCli([
      'brief',
      '--manifest', 'manifest.md',
      '--rounds', '2',
      '--brief', 'Test brief text',
    ], { cwd: root, ask: stubAsk });

    const code = res && typeof res.then === 'function' ? await res : res;
    assert.equal(code, 0);

    const content = readFileSync(manifestPath, 'utf8');
    assert.match(content, /## Дополнения/);
    assert.match(content, /CLI answer/);
    const counts = recount(content);
    assert.equal(counts.G, 2);
  });
});
