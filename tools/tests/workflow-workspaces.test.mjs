import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../bin/nullform.mjs', import.meta.url));
const REGISTRATION = '.workflow/workspace.json';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function repository(t, { ignore = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-workspaces-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'integration']);
  for (const [key, value] of [['user.name', 'Workspace Test'], ['user.email', 'workspace@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['merge.conflictStyle', 'merge'], ['core.hooksPath', join(root, '.git/hooks').replace(/\\/g, '/')]]) git(root, ['config', '--local', key, value]);
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  if (ignore) writeFileSync(join(root, '.gitignore'), '.tmp/\n.workflow/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}
function cli(root, command, feature, extra = []) {
  return spawnSync(process.execPath, [CLI, 'workflow', command, '--feature', feature, '--root', root, ...extra], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, killSignal: 'SIGKILL' });
}
function cliAsync(root, command, feature) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, 'workflow', command, '--feature', feature, '--root', root], { cwd: root, windowsHide: true, timeout: 120000, killSignal: 'SIGKILL' });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', status => resolveResult({ status, stdout, stderr }));
  });
}
function replaceGitMetadata(path, body) {
  // Windows hidden .git files reject open('w'); r+ preserves the actual metadata file.
  const fd = openSync(path, 'r+');
  try { writeFileSync(fd, body); ftruncateSync(fd, Buffer.byteLength(body)); }
  finally { closeSync(fd); }
}
function allocated(root, feature) {
  const result = cli(root, 'workspace', feature);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function committed(cwd, file, body) {
  writeFileSync(join(cwd, file), body);
  git(cwd, ['add', '--', file]);
  git(cwd, ['commit', '-qm', file]);
  return git(cwd, ['rev-parse', 'HEAD']);
}
function snapshot(root) {
  return { head: git(root, ['rev-parse', 'HEAD']), status: git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), index: git(root, ['ls-files', '--stage']), shared: existsSync(join(root, 'shared.txt')) ? readFileSync(join(root, 'shared.txt'), 'utf8') : null };
}
function refused(root, command, feature, pattern) {
  const before = snapshot(root);
  const result = cli(root, command, feature);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  if (pattern) assert.match(result.stderr, pattern);
  assert.deepEqual(snapshot(root), before, 'Refusal must not mutate HEAD, index, status or human bytes');
  return result;
}

test('concurrent allocation isolates indexes/state without copying staged, unstaged or untracked operator work', async t => {
  const root = repository(t);
  writeFileSync(join(root, 'shared.txt'), 'staged human\n');
  git(root, ['add', 'shared.txt']);
  writeFileSync(join(root, 'shared.txt'), 'unstaged human\n');
  writeFileSync(join(root, 'human.txt'), 'untracked human\n');
  mkdirSync(join(root, '.workflow'));
  const state = '{"tier":"T2","status":"open","task":"human task"}\n';
  writeFileSync(join(root, '.workflow/state.json'), state);
  const before = snapshot(root);
  const results = await Promise.all(['alpha', 'beta'].map(feature => cliAsync(root, 'workspace', feature)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const [a, b] = results.map(result => JSON.parse(result.stdout));
  assert.equal(a.base, before.head);
  assert.equal(b.base, before.head);
  assert.equal(a.integrationBranch, 'integration');
  assert.notEqual(a.cwd, b.cwd);
  assert.notEqual(resolve(a.cwd, git(a.cwd, ['rev-parse', '--git-path', 'index'])), resolve(b.cwd, git(b.cwd, ['rev-parse', '--git-path', 'index'])));
  for (const record of [a, b]) {
    assert.equal(readFileSync(join(record.cwd, 'shared.txt'), 'utf8'), 'base\n');
    assert.equal(existsSync(join(record.cwd, 'human.txt')), false);
    assert.equal(existsSync(join(record.cwd, '.workflow/state.json')), false);
    assert.equal(git(record.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  }
  const opened = spawnSync(process.execPath, [CLI, 'workflow', 'start', '--tier', 'T0', '--task', 'alpha task', '--no-dashboard'], { cwd: a.cwd, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(existsSync(join(b.cwd, '.workflow/state.json')), false);
  assert.deepEqual(snapshot(root), before);
  assert.equal(readFileSync(join(root, '.workflow/state.json'), 'utf8'), state);
  assert.equal(readFileSync(join(root, 'human.txt'), 'utf8'), 'untracked human\n');
  assert.equal(git(root, ['show', ':shared.txt']), 'staged human');
});

test('uppercase and lowercase Git index injection cannot replace staged human or private feature indexes', t => {
  const root = repository(t);
  const baseEntries = git(root, ['ls-files', '--stage']);
  writeFileSync(join(root, 'human.txt'), 'staged human work\n');
  git(root, ['add', 'human.txt']);
  const mainEntries = git(root, ['ls-files', '--stage']);
  const mainIndex = resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
  const alternateIndex = join(root, '.git/human-alternate-index');
  copyFileSync(mainIndex, alternateIndex);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'GIT_INDEX_FILE'));
  const alternateEntries = () => {
    const result = spawnSync('git', ['ls-files', '--stage'], { cwd: root, env: { ...env, GIT_INDEX_FILE: alternateIndex }, encoding: 'utf8', windowsHide: true, timeout: 30000, killSignal: 'SIGKILL' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.match(mainEntries, /\thuman\.txt$/m);
  assert.equal(alternateEntries(), mainEntries);
  for (const [key, feature] of [['GIT_INDEX_FILE', 'env-upper'], ['git_index_file', 'env-lower']]) {
    // Lowercase reaches Git as an index override on Windows; exercise both cases everywhere.
    const result = spawnSync(process.execPath, [CLI, 'workflow', 'workspace', '--feature', feature, '--root', root], { cwd: root, env: { ...env, [key]: alternateIndex }, encoding: 'utf8', windowsHide: true, timeout: 120000, killSignal: 'SIGKILL' });
    assert.equal(result.status, 0, `${key}: ${result.stderr}`);
    const { cwd } = JSON.parse(result.stdout);
    assert.equal(alternateEntries(), mainEntries, `${key} must preserve alternate logical entries`);
    assert.equal(git(root, ['ls-files', '--stage']), mainEntries, `${key} must preserve main logical entries`);
    assert.equal(git(cwd, ['ls-files', '--stage']), baseEntries, `${key} must initialize only the committed feature index`);
    const privateIndex = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
    assert.notEqual(privateIndex, mainIndex);
    assert.notEqual(privateIndex, alternateIndex);
  }
  assert.equal(readFileSync(join(root, 'human.txt'), 'utf8'), 'staged human work\n');
});

test('duplicate allocation refuses existing writable cwd and simultaneous duplicates have exactly one owner', async t => {
  const root = repository(t);
  const results = await Promise.all([cliAsync(root, 'workspace', 'same'), cliAsync(root, 'workspace', 'same')]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  const record = JSON.parse(results.find(result => result.status === 0).stdout);
  writeFileSync(join(record.cwd, 'private.txt'), 'writer bytes');
  refused(root, 'workspace', 'same', /EEXIST|exist/i);
  assert.equal(readFileSync(join(record.cwd, 'private.txt'), 'utf8'), 'writer bytes');
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 2);
});

test('path-like slugs, existing foreign repositories and junction escape refuse without replacement', t => {
  const root = repository(t);
  for (const slug of ['../escape', 'a/b', 'a\\b', 'HEAD~1', '-flag', 'a'.repeat(65)]) refused(root, 'workspace', slug, /slug/);
  mkdirSync(join(root, '.tmp/worktrees'), { recursive: true });
  const foreign = join(root, '.tmp/worktrees/featureforeign');
  mkdirSync(foreign);
  git(foreign, ['init', '-q']);
  writeFileSync(join(foreign, 'human.txt'), 'foreign user');
  refused(root, 'workspace', 'foreign', /EEXIST|exist/i);
  assert.equal(readFileSync(join(foreign, 'human.txt'), 'utf8'), 'foreign user');
  const outside = repository(t);
  symlinkSync(outside, join(root, '.tmp/worktrees/featureescape'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(root, 'workspace', 'escape', /escape/);
  assert.equal(existsSync(join(outside, REGISTRATION)), false);
});

test('junction in allocation parent refuses before making outside files', t => {
  const root = repository(t), outside = repository(t);
  symlinkSync(outside, join(root, '.tmp'), process.platform === 'win32' ? 'junction' : 'dir');
  refused(root, 'workspace', 'escape', /escape|junction/);
  assert.equal(existsSync(join(outside, 'worktrees')), false);
});

test('two committed features integrate onto one branch while preserving both source commits', t => {
  const root = repository(t);
  const a = allocated(root, 'alpha'), b = allocated(root, 'beta');
  const heads = [committed(a.cwd, 'alpha.txt', 'alpha feature\n'), committed(b.cwd, 'beta.txt', 'beta feature\n')];
  git(root, ['config', '--local', 'merge.autoStash', 'true']);
  git(root, ['config', '--local', 'branch.integration.mergeOptions', '--autostash -s ours']);
  for (const feature of ['alpha', 'beta']) {
    const result = cli(root, 'integrate', feature);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.integrationHead, git(root, ['rev-parse', 'HEAD']));
  }
  assert.equal(readFileSync(join(root, 'alpha.txt'), 'utf8'), 'alpha feature\n');
  assert.equal(readFileSync(join(root, 'beta.txt'), 'utf8'), 'beta feature\n');
  heads.forEach(head => git(root, ['merge-base', '--is-ancestor', head, 'HEAD']));
  assert.equal(git(a.cwd, ['rev-parse', 'HEAD']), heads[0]);
  assert.equal(git(b.cwd, ['rev-parse', 'HEAD']), heads[1]);
});

test('generated registration is the only untracked source exemption; unmanaged tmp data still refuses', t => {
  const root = repository(t, { ignore: false });
  const a = allocated(root, 'alpha');
  committed(a.cwd, 'alpha.txt', 'feature\n');
  const result = cli(root, 'integrate', 'alpha');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, '.tmp/human.txt'), 'untracked tmp human');
  refused(root, 'integrate', 'alpha', /Dirty/);
  assert.equal(readFileSync(join(root, '.tmp/human.txt'), 'utf8'), 'untracked tmp human');
});

test('dirty target and source, wrong branch and active operations refuse with autostash disabled', t => {
  const root = repository(t), a = allocated(root, 'alpha');
  committed(a.cwd, 'alpha.txt', 'feature\n');
  git(root, ['config', '--local', 'merge.autoStash', 'true']);
  for (const staged of [false, true]) {
    writeFileSync(join(root, 'shared.txt'), 'human changes\n');
    if (staged) git(root, ['add', 'shared.txt']);
    refused(root, 'integrate', 'alpha', /Dirty/);
    assert.equal(git(root, ['stash', 'list']), '');
    git(root, ['restore', '--staged', '--worktree', 'shared.txt']);
  }
  writeFileSync(join(root, 'untracked.txt'), 'human untracked');
  refused(root, 'integrate', 'alpha', /Dirty/);
  rmSync(join(root, 'untracked.txt'));
  for (const staged of [false, true]) {
    writeFileSync(join(a.cwd, 'shared.txt'), 'source human');
    if (staged) git(a.cwd, ['add', 'shared.txt']);
    const before = snapshot(a.cwd);
    refused(root, 'integrate', 'alpha', /Dirty/);
    assert.deepEqual(snapshot(a.cwd), before);
    git(a.cwd, ['restore', '--staged', '--worktree', 'shared.txt']);
  }
  writeFileSync(join(a.cwd, 'untracked.txt'), 'source untracked');
  refused(root, 'integrate', 'alpha', /Dirty/);
  rmSync(join(a.cwd, 'untracked.txt'));
  git(root, ['switch', '-qc', 'wrong']);
  refused(root, 'integrate', 'alpha', /Wrong/);
  git(root, ['switch', '-q', 'integration']);
  for (const cwd of [root, a.cwd]) {
    const mergeHead = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD']));
    const head = git(cwd, ['rev-parse', 'HEAD']);
    writeFileSync(mergeHead, `${head}\n`);
    refused(root, 'integrate', 'alpha', /Active Git/);
    assert.equal(readFileSync(mergeHead, 'utf8'), `${head}\n`);
    rmSync(mergeHead);
  }
});

test('foreign root, foreign Git common directory and tampered registration refuse', t => {
  const root = repository(t), a = allocated(root, 'alpha'), foreign = repository(t);
  const registration = join(a.cwd, REGISTRATION), body = readFileSync(registration, 'utf8');
  for (const mutation of [{ root: foreign }, { integrationBranch: 'wrong' }, { base: '0'.repeat(40) }, { cwd: foreign }]) {
    writeFileSync(registration, JSON.stringify({ ...a, ...mutation }));
    refused(root, 'integrate', 'alpha', /tampered|Invalid/i);
  }
  writeFileSync(registration, body);
  const gitFile = join(a.cwd, '.git'), originalGit = readFileSync(gitFile, 'utf8');
  replaceGitMetadata(gitFile, `gitdir: ${join(foreign, '.git').replace(/\\/g, '/')}\n`);
  refused(root, 'integrate', 'alpha', /Foreign/);
  replaceGitMetadata(gitFile, originalGit);
  refused(foreign, 'integrate', 'alpha');
});

test('source history detached from the recorded base cannot be integrated', t => {
  const root = repository(t), a = allocated(root, 'alpha');
  git(a.cwd, ['switch', '--orphan', 'unrelated']);
  writeFileSync(join(a.cwd, 'unrelated.txt'), 'unrelated history');
  git(a.cwd, ['add', 'unrelated.txt']);
  git(a.cwd, ['commit', '-qm', 'unrelated']);
  refused(root, 'integrate', 'alpha');
  assert.equal(existsSync(join(root, 'unrelated.txt')), false);
});

test('rewritten integration history must still descend from the recorded base', t => {
  const root = repository(t), a = allocated(root, 'alpha');
  committed(a.cwd, 'alpha.txt', 'feature\n');
  git(root, ['branch', '-m', 'prior-integration']);
  git(root, ['switch', '--orphan', 'integration']);
  committed(root, 'replacement.txt', 'replacement history');
  refused(root, 'integrate', 'alpha');
  assert.equal(existsSync(join(root, 'alpha.txt')), false);
});

test('same-line conflict remains native, recoverable and explicitly unsuccessful', t => {
  const root = repository(t), a = allocated(root, 'alpha'), b = allocated(root, 'beta');
  const left = committed(a.cwd, 'shared.txt', 'alpha choice\n'), right = committed(b.cwd, 'shared.txt', 'beta choice\n');
  assert.equal(cli(root, 'integrate', 'alpha').status, 0);
  const before = git(root, ['rev-parse', 'HEAD']);
  const result = cli(root, 'integrate', 'beta');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /merge failed.*state retained/is);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(readFileSync(join(root, '.git/MERGE_HEAD'), 'utf8').trim(), right);
  const conflict = readFileSync(join(root, 'shared.txt'), 'utf8');
  assert.match(conflict, /<<<<<<<.*\nalpha choice\n=======\nbeta choice\n>>>>>>>/s);
  const stages = git(root, ['ls-files', '--unmerged']);
  assert.match(stages, / 1\tshared.txt/);
  assert.match(stages, / 2\tshared.txt/);
  assert.match(stages, / 3\tshared.txt/);
  assert.equal(git(a.cwd, ['rev-parse', 'HEAD']), left);
  assert.equal(git(b.cwd, ['rev-parse', 'HEAD']), right);
  assert.equal(readFileSync(join(a.cwd, 'shared.txt'), 'utf8'), 'alpha choice\n');
  assert.equal(readFileSync(join(b.cwd, 'shared.txt'), 'utf8'), 'beta choice\n');
  assert.equal(git(root, ['stash', 'list']), '');
  refused(root, 'integrate', 'alpha', /Active Git/);
});

test('old live, malformed and uncertain-owner common locks are never reclaimed', t => {
  const root = repository(t), a = allocated(root, 'alpha');
  committed(a.cwd, 'alpha.txt', 'feature\n');
  const lock = join(root, '.git/nullform-integration.lock');
  for (const body of [JSON.stringify({ pid: process.pid, token: 'human', createdAt: 1 }), '{corrupt', JSON.stringify({ pid: 'uncertain', createdAt: 1 })]) {
    writeFileSync(lock, body);
    utimesSync(lock, new Date(1), new Date(1));
    refused(root, 'integrate', 'alpha', /lock is held/);
    assert.equal(readFileSync(lock, 'utf8'), body);
    rmSync(lock);
  }
});

test('simultaneous integrations serialize the whole native merge, not just registration', async t => {
  const root = repository(t), a = allocated(root, 'alpha'), b = allocated(root, 'beta');
  const heads = [committed(a.cwd, 'alpha.txt', 'alpha feature\n'), committed(b.cwd, 'beta.txt', 'beta feature\n')];
  const hookRoot = join(root, '.git/test-hooks');
  mkdirSync(hookRoot);
  git(root, ['config', '--local', 'core.hooksPath', hookRoot.replace(/\\/g, '/')]);
  const helper = join(root, '.git/hook-helper.mjs');
  writeFileSync(helper, "import { appendFileSync } from 'node:fs';\nappendFileSync('.git/merge-order', 'start\\n');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\nappendFileSync('.git/merge-order', 'end\\n');\n");
  const hook = join(hookRoot, 'pre-merge-commit');
  writeFileSync(hook, `#!/bin/sh\n'${process.execPath.replace(/\\/g, '/')}' '${helper.replace(/\\/g, '/')}'\n`);
  chmodSync(hook, 0o755);
  const results = await Promise.all(['alpha', 'beta'].map(feature => cliAsync(root, 'integrate', feature)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, '.git/merge-order'), 'utf8'), 'start\nend\nstart\nend\n');
  heads.forEach(head => git(root, ['merge-base', '--is-ancestor', head, 'HEAD']));
  assert.equal(readFileSync(join(root, 'alpha.txt'), 'utf8'), 'alpha feature\n');
  assert.equal(readFileSync(join(root, 'beta.txt'), 'utf8'), 'beta feature\n');
  assert.equal(existsSync(join(root, '.git/nullform-integration.lock')), false);
});
