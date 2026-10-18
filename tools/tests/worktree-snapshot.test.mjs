import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanGitEnv, sourceDigest, scanWorktree } from '../worktree-snapshot.mjs';

const gitEnv = { ...cleanGitEnv(), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

function repository(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'baseline']]) {
    const result = spawnSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

const inventory = root => Object.keys({ ...scanWorktree(root).tracked, ...scanWorktree(root).untracked }).sort();

test('worktree-snapshot: ambient GIT_* cannot redirect source identity or inventory to another repository', t => {
  const a = repository('scope-a-', { 'alpha.mjs': 'export const v = 1;\n', 'tests/alpha.test.mjs': '// A\n' });
  const b = repository('scope-b-', { 'beta.mjs': 'export const v = 99;\n', 'tests/beta.test.mjs': '// B\n' });
  const saved = {};
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) { saved[key] = process.env[key]; delete process.env[key]; }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  const baseline = sourceDigest(a), baselineInventory = inventory(a);
  assert.deepEqual(baselineInventory, ['alpha.mjs', 'tests/alpha.test.mjs']);

  // Foreign Git environment, including the lowercase spelling and a real frozen-test path
  // that also exists in B — the shape that used to let stale hashes keep validating.
  process.env.GIT_DIR = join(b, '.git');
  process.env.GIT_WORK_TREE = b;
  process.env.git_dir = join(b, '.git');
  process.env.GIT_INDEX_FILE = join(b, '.git', 'index');

  assert.equal(sourceDigest(a), baseline, 'Baseline source identity must ignore a foreign Git environment');
  assert.deepEqual(inventory(a), baselineInventory, 'Inventory must describe the requested root, not the foreign repository');

  writeFileSync(join(a, 'alpha.mjs'), 'export const v = 2;\n');
  assert.notEqual(sourceDigest(a), baseline, 'Changed bytes in the requested root must still be detected under a foreign Git environment');

  // A test file that exists in both repositories must not mask the foreign redirection.
  writeFileSync(join(a, 'tests', 'alpha.test.mjs'), '// A changed\n');
  assert.notEqual(sourceDigest(a), baseline, 'A changed common test path must still be detected');
});
