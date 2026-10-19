import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRootPath, validatePathWithinScope } from '../worktree-snapshot.mjs';

const REGISTRATION = '.workflow/workspace.json';
const ANCHOR = 'nullform-workspace.json';
const LOCK = 'nullform-integration.lock';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' });

function git(root, args) {
  return execFileSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', windowsHide: true, timeout: 30000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}
function gitPath(root, name) {
  return resolve(root, git(root, ['rev-parse', '--git-path', name]).trim());
}
function commonDirectory(root) {
  return realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()));
}
function projectRoot(root) {
  const path = realpathSync(validateRootPath(root));
  if (realpathSync(git(path, ['rev-parse', '--show-toplevel']).trim()) !== path) throw new Error('--root must be the integration checkout root');
  return path;
}
function featurePath(root, feature) {
  if (typeof feature !== 'string' || !SLUG.test(feature)) throw new Error('--feature must be a lowercase alphanumeric/hyphen slug (1-64 characters)');
  const path = join(root, '.tmp', 'worktrees', `feature${feature}`);
  if (!validatePathWithinScope(path, root)) throw new Error('Feature path escapes the project root');
  return path;
}
function plainDirectory(path, scope) {
  if (!validatePathWithinScope(path, scope)) throw new Error('Workspace metadata/path escapes its declared scope');
  try { mkdirSync(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Workspace directory is a symlink/junction or not a directory');
}
function assertIdle(root) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock']) {
    if (existsSync(gitPath(root, name))) throw new Error(`Active Git operation in ${root}: ${name}`);
  }
}
function branch(root) {
  const name = git(root, ['symbolic-ref', '--quiet', 'HEAD']).trim();
  if (!name.startsWith('refs/heads/')) throw new Error('Integration checkout must be on a branch');
  return name.slice('refs/heads/'.length);
}
function commit(root, revision) {
  const sha = git(root, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Git did not resolve a commit');
  return sha;
}
function assertAncestor(root, base, head) {
  git(root, ['merge-base', '--is-ancestor', base, head]);
}
function loadRegistration(root, feature) {
  const cwd = featurePath(root, feature);
  if (lstatSync(cwd).isSymbolicLink() || realpathSync(cwd) !== cwd) throw new Error('Feature cwd is a symlink/junction or was moved');
  const file = join(cwd, REGISTRATION);
  if (!validatePathWithinScope(file, cwd) || lstatSync(file).isSymbolicLink()) throw new Error('Registration escapes the feature cwd');
  const body = readFileSync(file, 'utf8');
  const record = JSON.parse(body);
  const commonDir = commonDirectory(root);
  if (record.version !== 1 || record.feature !== feature || record.cwd !== cwd || record.root !== root || record.commonDir !== commonDir || commonDirectory(cwd) !== commonDir) throw new Error('Foreign or tampered workspace registration');
  if (realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim()) !== cwd || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.base) || typeof record.integrationBranch !== 'string') throw new Error('Invalid workspace registration');
  const anchor = gitPath(cwd, ANCHOR);
  if (!validatePathWithinScope(anchor, commonDir) || readFileSync(anchor, 'utf8') !== body) throw new Error('Tampered workspace registration');
  return record;
}
function managedUntracked(root, path) {
  if (path === REGISTRATION) {
    const record = JSON.parse(readFileSync(join(root, REGISTRATION), 'utf8'));
    return loadRegistration(record.root, record.feature).cwd === root;
  }
  const match = /^\.tmp\/worktrees\/feature([a-z0-9-]+)\/$/.exec(path);
  return Boolean(match && loadRegistration(root, match[1]));
}
function assertClean(root) {
  const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('?? ') && managedUntracked(root, entry.slice(3))) continue;
    throw new Error(`Dirty checkout (including untracked data): ${root}`);
  }
}
// Locks survive worker crashes/kills and uncertain Git timeouts; there is no automatic recovery.
function lockHeldError(path) {
  let owner = 'unreadable/malformed record; owner identity uncertain';
  try {
    const { pid, token, createdAt } = JSON.parse(readFileSync(path, 'utf8'));
    owner = `pid=${pid}, token=${token}, createdAt=${createdAt}`;
  } catch {}
  return new Error(`Integration lock is held: ${path}. Owner: ${owner}. Never auto-evicted, including after a crash. Before manual release, verify the recorded owner and its Git/hook children have stopped, exclude any active integrator, and re-read the unchanged owner token. Unknown identity must remain locked.`);
}
function withIntegrationLock(commonDir, run) {
  const path = join(commonDir, LOCK);
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  const deadline = Date.now() + 60000;
  for (;;) {
    try { writeFileSync(path, payload, { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never evict: age, a malformed payload or an uncertain PID is not ownership proof.
      if (Date.now() >= deadline) throw lockHeldError(path);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  let release = true;
  try { return run(); }
  catch (error) {
    if (error.code === 'ETIMEDOUT') { release = false; error.message += `; native Git state retained. ${lockHeldError(path).message}`; }
    throw error;
  }
  finally { if (release && readFileSync(path, 'utf8') === payload) unlinkSync(path); }
}

/** Allocate a new detached writer; existing paths are never authorization to reuse it. */
function allocateWorkspace(project, feature) {
  const root = projectRoot(project);
  const cwd = featurePath(root, feature);
  const integrationBranch = branch(root);
  assertIdle(root);
  const commonDir = commonDirectory(root);
  const base = commit(root, 'HEAD');
  plainDirectory(join(root, '.tmp'), root);
  plainDirectory(join(root, '.tmp', 'worktrees'), root);
  // mkdir is the atomic reservation for concurrent duplicate requests. Failures retain it.
  mkdirSync(cwd);
  git(root, ['worktree', 'add', '--detach', '--', cwd, base]);
  if (commonDirectory(cwd) !== commonDir) throw new Error('Allocated worktree belongs to a foreign repository');
  plainDirectory(join(cwd, '.workflow'), cwd);
  const record = { version: 1, feature, cwd, root, commonDir, base, integrationBranch };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(gitPath(cwd, ANCHOR), body, { flag: 'wx' });
  writeFileSync(join(cwd, REGISTRATION), body, { flag: 'wx' });
  return record;
}

/** Merge the resolved committed source with native conflict state left intact on failure. */
function integrateWorkspace(project, feature) {
  const root = projectRoot(project);
  featurePath(root, feature);
  return withIntegrationLock(commonDirectory(root), () => {
    const record = loadRegistration(root, feature);
    if (branch(root) !== record.integrationBranch) throw new Error('Wrong integration branch');
    for (const cwd of [root, record.cwd]) { assertIdle(cwd); assertClean(cwd); }
    const sourceHead = commit(record.cwd, 'HEAD');
    const targetHead = commit(root, 'HEAD');
    assertAncestor(root, record.base, sourceHead);
    assertAncestor(root, record.base, targetHead);
    const result = spawnSync('git', ['-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', '-c', `branch.${record.integrationBranch}.mergeOptions=`, 'merge', '--no-autostash', '--no-ff', '--no-edit', sourceHead], { cwd: root, env: gitEnv(), encoding: 'utf8', windowsHide: true, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native Git merge failed; conflict/operation state retained.\n${result.stdout || ''}${result.stderr || ''}`);
    return { ...record, sourceHead, integrationHead: commit(root, 'HEAD') };
  });
}

export function runWorkspaceCommand(command, root, flags, positionalCount = 1) {
  try {
    if (positionalCount !== 1 || Object.keys(flags).some(key => !['root', 'feature'].includes(key)) || (flags.root !== undefined && typeof flags.root !== 'string')) throw new Error('Use --feature SLUG [--root PROJECT] only');
    const record = command === 'workspace' ? allocateWorkspace(root, flags.feature) : integrateWorkspace(root, flags.feature);
    console.log(JSON.stringify(record, null, 2));
    return 0;
  } catch (error) {
    console.error(`workflow ${command}: ${error.message}`);
    return 1;
  }
}
