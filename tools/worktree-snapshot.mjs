import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

export function isPathInsideRoot(root, path) {
  if (typeof path !== 'string' || !path) return false;
  const rel = relative(resolve(root), resolve(root, path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
export function isRealPathInsideRoot(root, path) {
  if (!isPathInsideRoot(root, path)) return false;
  try { return isPathInsideRoot(realpathSync(root), realpathSync(resolve(root, path))); } catch { return false; }
}
export function isStructuralExcludedPath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/');
  return !path || ['.tmp', '.archmap', '.codemap', '.opencode', '.workflow', 'cache', 'logs'].includes(parts[0]) || parts.some(p => p === '.git' || p === 'node_modules');
}
export function isSecretOrCredentialPath(path) {
  const base = basename(String(path || '').replace(/\\/g, '/'));
  return ['models.yml', 'models.yaml', 'mcp.json'].includes(base) || base.startsWith('.env') || base.startsWith('secrets') || /credentials|\.secret|secrets\.|\.key$|\.pem$/i.test(base);
}
export function isAcceptanceArtifactFilename(path) {
  const base = basename(String(path || '')).toLowerCase();
  return /^oracle(-+[a-z0-9]+)*\.md$/.test(base) || base === 'acceptance.md' || /^review-evidence(-+[a-z0-9]+)*\.json$/.test(base);
}
export function isAcceptancePath(path) {
  return /^openspec\/changes\/[^/]+\//.test(path.replace(/\\/g, '/')) && isAcceptanceArtifactFilename(path);
}
export function hashFile(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}
export function scanWorktree(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const secretEntries = [];
  function collect(paths, untracked) {
    const files = {};
    for (const rel of paths) {
      if (!rel || isStructuralExcludedPath(rel) || isAcceptancePath(rel) || !isRealPathInsideRoot(root, rel)) continue;
      const full = join(root, rel);
      if (!statSync(full).isFile()) continue;
      if (isSecretOrCredentialPath(rel)) {
        if (!untracked) {
          const hash = hashFile(full);
          if (!hash) throw new Error('Cannot fingerprint tracked credential content');
          secretEntries.push([rel, hash]); files[rel] = { hash: null, isSecret: true };
        }
        continue;
      }
      const stat = statSync(full);
      const hash = hashFile(full);
      if (!hash) throw new Error(`Cannot snapshot ${rel}`);
      files[rel] = { hash, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    return files;
  }
  let trackedPaths, untrackedPaths, commitSha = null;
  try {
    trackedPaths = git(['ls-files', '-z']).split('\0');
    untrackedPaths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
    try { commitSha = git(['rev-parse', 'HEAD']).trim(); } catch {}
  } catch {
    const paths = [];
    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = relative(root, full).replace(/\\/g, '/');
        if (isStructuralExcludedPath(rel) || !isRealPathInsideRoot(root, rel)) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) paths.push(rel);
      }
    }
    walk(root);
    return { isGit: false, files: collect(paths, true) };
  }
  const tracked = collect(trackedPaths, false);
  const untracked = collect(untrackedPaths, true);
  const secretDigest = createHash('sha256').update(JSON.stringify(secretEntries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))).digest('hex');
  return { isGit: true, commitSha, tracked, untracked, secretDigest };
}
export function sourceDigest(root) {
  const snapshot = scanWorktree(root);
  const files = snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files;
  const entries = Object.entries(files).filter(([p, m]) => !isAcceptancePath(p) && !m.isSecret).map(([p, m]) => [p, m.hash]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify([entries, snapshot.secretDigest || null])).digest('hex');
}
export function testFilesHash(root) {
  const snapshot = scanWorktree(root);
  const files = snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files;
  const entries = Object.entries(files).filter(([p]) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/.test(p)).map(([p, m]) => [p, m.isSecret ? hashFile(join(root, p)) : m.hash]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (!entries.length) throw new Error('Frozen test set is empty; retain real test files before reviewer/Stage-B');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
