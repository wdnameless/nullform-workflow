import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { recordBeat, honestTime, askKind, answered, commitsCheck, formatTrailers } from '../journal.mjs';
import { carryDebts, verifySkillsLock } from '../carry.mjs';
import { normalizedCost } from '../cost-snapshot.mjs';
import { embedSnapshot, detectCollision, isOwnServer } from '../dashboard.mjs';

test('journal: recordBeat caps at 2000 timestamps and drops oldest', () => {
  const journal = { beats: [] };
  for (let i = 0; i < 2005; i++) {
    const t = new Date(1700000000000 + i * 1000).toISOString();
    recordBeat(journal, t);
  }
  assert.equal(journal.beats.length, 2000);
  assert.equal(journal.beats[0], new Date(1700000000000 + 5 * 1000).toISOString());
  assert.equal(journal.beats[1999], new Date(1700000000000 + 2004 * 1000).toISOString());
});

test('journal: honestTime sums deltas <= 45min, excludes gaps > 45min, and subtracts archived waits', () => {
  const t0 = new Date('2026-10-22T10:00:00.000Z').getTime();
  const min = (m) => new Date(t0 + m * 60 * 1000).toISOString();

  const journal = {
    beats: [
      min(0),   // 10:00
      min(15),  // 10:15 (+15 min = 900,000 ms)
      min(35),  // 10:35 (+20 min = 1,200,000 ms)
      min(90),  // 11:30 (+55 min > 45 min -> EXCLUDED!)
      min(100), // 11:40 (+10 min = 600,000 ms)
    ],
  };

  // Active time = 15m + 20m + 10m = 45m = 2,700,000 ms
  assert.equal(honestTime(journal), 45 * 60 * 1000);

  // Add archived wait of 5 minutes (300,000 ms)
  journal.waits = [
    { kind: 'user_prompt', from: min(5), to: min(10) },
  ];
  // Honest time = 45m - 5m = 40m = 2,400,000 ms
  assert.equal(honestTime(journal), 40 * 60 * 1000);

  // When waits exceed active time, honest time clamps to 0
  journal.waits.push({ kind: 'sleep', from: min(0), to: min(120) });
  assert.equal(honestTime(journal), 0);

  // Empty journal returns 0
  assert.equal(honestTime({}), 0);
  assert.equal(honestTime({ beats: [min(0)] }), 0);
});

test('journal: askKind and answered manage waiting to waits archive', () => {
  const journal = {};
  const tAsk = '2026-10-22T12:00:00.000Z';
  const tAns = '2026-10-22T12:15:00.000Z';

  askKind(journal, 'review_approval', tAsk);
  assert.deepEqual(journal.waiting, {
    kind: 'review_approval',
    from: tAsk,
  });

  const entry = answered(journal, tAns);
  assert.deepEqual(entry, {
    kind: 'review_approval',
    from: tAsk,
    to: tAns,
  });
  assert.equal(journal.waiting, undefined);
  assert.deepEqual(journal.waits, [
    { kind: 'review_approval', from: tAsk, to: tAns },
  ]);

  // Repeated answered call when not waiting returns null
  assert.equal(answered(journal), null);
  assert.equal(journal.waits.length, 1);
});

test('journal: commitsCheck verifies ancestors with a fixture git repository', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-ops-git-'));
  try {
    const git = (args) => {
      const res = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      return res.stdout.trim();
    };

    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Tester']);
    git(['config', 'commit.gpgsign', 'false']);

    writeFileSync(join(tmp, 'file1.txt'), 'hello', 'utf8');
    git(['add', 'file1.txt']);
    git(['commit', '-m', 'commit 1']);
    const c1 = git(['rev-parse', 'HEAD']);

    writeFileSync(join(tmp, 'file2.txt'), 'world', 'utf8');
    git(['add', 'file2.txt']);
    git(['commit', '-m', 'commit 2']);
    const c2 = git(['rev-parse', 'HEAD']);

    // Both c1 and c2 are ancestors of HEAD
    const resOk = commitsCheck(tmp, [c1, c2]);
    assert.equal(resOk.ok, true);
    assert.deepEqual(resOk.missing, []);

    // A fake or missing commit is reported in missing
    const fakeCommit = '0123456789abcdef0123456789abcdef01234567';
    const resMissing = commitsCheck(tmp, [c1, fakeCommit]);
    assert.equal(resMissing.ok, false);
    assert.deepEqual(resMissing.missing, [fakeCommit]);

    // Format trailers helper
    const trailers = formatTrailers({ run: 'run-42', requirements: ['R10', 'R11'] });
    assert.ok(trailers.includes('Run: run-42'));
    assert.ok(trailers.includes('Requirements: R10, R11'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('carry: carryDebts carries debts and placeholders across runs and round-trips', () => {
  const base = mkdtempSync(join(tmpdir(), 'ap-ops-carry-'));
  try {
    const run1 = join(base, 'run1');
    const run2 = join(base, 'run2');
    const run3 = join(base, 'run3');

    mkdirSync(run1, { recursive: true });

    writeFileSync(
      join(run1, 'debts.json'),
      JSON.stringify([{ id: 'DEBT-1', what: 'clean up cache', ceiling: '50' }]),
      'utf8'
    );
    writeFileSync(
      join(run1, 'placeholders.json'),
      JSON.stringify(['R11: placeholder for cost reporting']),
      'utf8'
    );

    // Carry from run1 to run2
    const mdPath = carryDebts(run1, run2);
    assert.equal(mdPath, join(run2, 'carried.md'));

    const content2 = readFileSync(join(run2, 'carried.md'), 'utf8');
    assert.ok(content2.includes('- DEBT-1: clean up cache (ceiling: 50)'));
    assert.ok(content2.includes('- R11: placeholder for cost reporting'));

    // Carry from run2 to run3 (round-trip)
    carryDebts(run2, run3);
    const content3 = readFileSync(join(run3, 'carried.md'), 'utf8');
    assert.ok(content3.includes('- DEBT-1: clean up cache (ceiling: 50)'));
    assert.ok(content3.includes('- R11: placeholder for cost reporting'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cost-snapshot: normalizedCost calculates units, preserves role, and sets cacheChurn flag', () => {
  // Case 1: out*5 + write*1.25 + read*0.1
  // out=1000, write=200, read=5000 -> 5000 + 250 + 500 = 5750
  // write / read = 200 / 5000 = 0.04 <= 0.10 -> churn = false
  const res1 = normalizedCost({ output: 1000, cacheWrite: 200, cacheRead: 5000 }, 'worker');
  assert.equal(res1.units, 5750);
  assert.equal(res1.role, 'worker');
  assert.equal(res1.cacheChurn, false);

  // Case 2: write / read > 0.10 -> churn = true
  // out=100, write=30, read=100 -> write / read = 0.30 > 0.10
  const res2 = normalizedCost({ output: 100, cacheWrite: 30, cacheRead: 100 }, 'fixer');
  assert.equal(res2.units, 100 * 5 + 30 * 1.25 + 100 * 0.1);
  assert.equal(res2.role, 'fixer');
  assert.equal(res2.cacheChurn, true);

  // Case 3: write > 0 with read = 0 -> churn = true
  const res3 = normalizedCost({ output: 10, cacheWrite: 5, cacheRead: 0 });
  assert.equal(res3.cacheChurn, true);

  // Case 4: default/empty
  const res4 = normalizedCost();
  assert.equal(res4.units, 0);
  assert.equal(res4.cacheChurn, false);
});

test('carry: verifySkillsLock passes on valid hash and throws naming skill on tampering', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-ops-lock-'));
  try {
    const skillDir = join(tmp, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });

    const skillContent = '# My Skill content\n';
    writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf8');

    const expectedHash = createHash('sha256').update(skillContent).digest('hex');
    const lockPath = join(tmp, 'skills-lock.json');
    writeFileSync(
      lockPath,
      JSON.stringify({ skills: { 'my-skill': expectedHash } }, null, 2),
      'utf8'
    );

    // Valid check passes
    const okRes = verifySkillsLock(lockPath, tmp);
    assert.equal(okRes.ok, true);
    assert.deepEqual(okRes.verified, ['my-skill']);

    // Tampered check fails naming the skill
    writeFileSync(join(skillDir, 'SKILL.md'), '# Tampered content\n', 'utf8');
    assert.throws(
      () => verifySkillsLock(lockPath, tmp),
      (err) => {
        assert.ok(err.message.includes('my-skill'));
        return true;
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dashboard: embedSnapshot replaces state between markers and escapes </', () => {
  const html = `<!DOCTYPE html><html><head><script>/*STATE-BEGIN*/var old = 1;/*STATE-END*/</script></head><body></body></html>`;
  const state = {
    project: 'test-proj',
    xss: '</script><script>alert("pwn")</script>',
  };

  const embedded = embedSnapshot(html, state);
  assert.ok(embedded.includes('/*STATE-BEGIN*/'));
  assert.ok(embedded.includes('/*STATE-END*/'));
  assert.ok(embedded.includes('window.STATE ='));

  // Critical: </ must be escaped as <\/ to prevent closing <script> prematurely
  assert.ok(!embedded.includes('</script><script>'));
  assert.ok(embedded.includes('<\\/script><script>'));
});

test('dashboard: detectCollision and isOwnServer identify parallel sessions and harness processes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-ops-collision-'));
  try {
    mkdirSync(join(tmp, '.workflow'), { recursive: true });

    // Case 1: unfinished task + fresh serve.pid -> collision = true
    writeFileSync(
      join(tmp, '.workflow', 'state.json'),
      JSON.stringify({ status: 'open', task: 'active-task' }),
      'utf8'
    );
    writeFileSync(join(tmp, '.workflow', 'serve.pid'), '12345\n', 'utf8');
    assert.equal(detectCollision(tmp), true);

    // Case 2: finished task (closed) + fresh serve.pid -> collision = false
    writeFileSync(
      join(tmp, '.workflow', 'state.json'),
      JSON.stringify({ status: 'closed', task: 'active-task' }),
      'utf8'
    );
    assert.equal(detectCollision(tmp), false);

    // Case 3: unfinished task + stale serve.pid (>5min) -> collision = false
    writeFileSync(
      join(tmp, '.workflow', 'state.json'),
      JSON.stringify({ status: 'open', task: 'active-task' }),
      'utf8'
    );
    const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(join(tmp, '.workflow', 'serve.pid'), tenMinAgo, tenMinAgo);
    assert.equal(detectCollision(tmp), false);

    // Test isOwnServer predicate
    const myCmd = `node tools/dashboard.mjs --serve --root ${tmp}`;
    assert.equal(isOwnServer(myCmd, tmp), true);

    // Foreign server
    assert.equal(isOwnServer('python -m http.server 4200', tmp), false);
    assert.equal(isOwnServer('nginx: master process', tmp), false);

    // Harness server for another project
    assert.equal(isOwnServer('node tools/dashboard.mjs --serve --root /some/other/project', tmp), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
