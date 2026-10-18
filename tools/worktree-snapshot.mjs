import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Environment for every Git READ this project performs.
 *
 * Ambient `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` and the
 * external-diff/textconv/fsmonitor hooks can silently redirect a read to another
 * repository, so a `--root A` read would report B's inventory or no inventory at all.
 * They are stripped case-insensitively; hooks that execute code are neutralised.
 * The external-diff variable is REMOVED, never set to an empty string: an empty value
 * makes Git try to spawn a command named "" and every diff fails.
 */
export function cleanGitEnv(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GIT_CONFIG_NOSYSTEM = '1';
  return clean;
}

export function isPathInsideRoot(root, path) {
  if (typeof path !== 'string' || !path) return false;
  const rel = relative(resolve(root), resolve(root, path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
export function isRealPathInsideRoot(root, path) { if (!isPathInsideRoot(root, path)) return false;
try { return isPathInsideRoot(realpathSync(root), realpathSync(resolve(root, path))); } catch { return false; } }

export function normalizePath(path) {
  const full = resolve(path);
  return full.startsWith('\\\\?\\') ? full.slice(4) : full;
}
export function isInsideOrEqual(parent, child) {
  let p = normalizePath(parent), c = normalizePath(child);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (process.platform === 'win32') { p = p.toLowerCase(); c = c.toLowerCase(); }
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
export function resolveRealPath(path) { try { return normalizePath(realpathSync.native ? realpathSync.native(path) : realpathSync(path)); } catch { return null; } }
export function getCanonicalPath(path, cache = null) {
  try { return canonicalEntry(path, cache).real; } catch { return null; }
}
function canonicalEntry(path, cache) {
  const full = normalizePath(path);
  if (cache?.has(full)) return cache.get(full);
  let stat, entry;
  try { stat = lstatSync(full); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if (stat) {
    const real = resolveRealPath(full);
    entry = { real, link: stat.isSymbolicLink(), directory: stat.isDirectory() || Boolean(stat.isSymbolicLink() && real && statSync(full).isDirectory()) };
  } else {
    const parent = dirname(full);
    const ancestor = parent === full ? null : canonicalEntry(parent, cache);
    entry = { real: ancestor?.directory && ancestor.real ? join(ancestor.real, basename(full)) : null, link: false, directory: true };
  }
  cache?.set(full, entry);
  return entry;
}
export function validateRootPath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Preflight failed: root path is empty or invalid');
  const full = normalizePath(path), entry = canonicalEntry(full);
  if (entry.link) throw new Error(`Preflight failed: root path "${full}" escapes declared root or is a symlink/junction`);
  if (!entry.real || !entry.directory) throw new Error(`Preflight failed: root path "${full}" is not a resolvable directory`);
  return full;
}
export function validatePathWithinScope(path, scope, cache = null, allowRootLink = false) {
  try {
    if (!isInsideOrEqual(scope, path)) return false;
    const root = canonicalEntry(scope, cache), target = canonicalEntry(path, cache);
    return Boolean(root.real && root.directory && target.real && (allowRootLink || !root.link) && isInsideOrEqual(root.real, target.real));
  } catch { return false; }
}
export function isStructuralExcludedPath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/');
  return !path || ['.tmp', '.codemap', '.opencode', '.workflow', 'cache', 'logs'].includes(parts[0]) || parts.some(p => p === '.git' || p === 'node_modules');
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
export function hashFile(path, text = false) {
  try {
    let bytes = readFileSync(path);
    // Latin-1 roundtrips every byte; only declared text may lose CRLF bytes.
    if (text && bytes.includes(13) && !bytes.subarray(0, 8000).includes(0)) {
      bytes = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    }
    return createHash('sha256').update(bytes).digest('hex');
  } catch { return null; }
}
const TEXT_PATH = /(?:\.(?:md|mdc|mjs|cjs|js|jsx|ts|tsx|py|json|jsonc|json5|jsonl|ya?ml|toml|txt|ps1|psm1|sh|bash|css|html|xml|svg|csv|srt|example)|(?:^|\/)(?:VERSION|LICENSE|Dockerfile|Makefile|\.gitattributes|\.gitignore))$/i;
export function scanWorktree(root) {
  const git = (args, input) => execFileSync('git', args, { cwd: root, env: cleanGitEnv(), input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const secretEntries = [];
  const textAttributes = new Map();
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
      const attribute = textAttributes.get(rel);
      const isText = attribute === 'set' || attribute === 'auto' || (attribute !== 'unset' && TEXT_PATH.test(rel));
      const hash = hashFile(full, isText);
      if (!hash) throw new Error(`Cannot snapshot ${rel}`);
      files[rel] = { hash, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    return files;
  }
  let trackedPaths, untrackedPaths, commitSha = null;
  try {
    trackedPaths = git(['ls-files', '-z']).split('\0').filter(Boolean);
    untrackedPaths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
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
  const paths = [...trackedPaths, ...untrackedPaths];
  if (paths.length) {
    const attributes = git(['check-attr', '-z', '--stdin', 'text'], paths.join('\0') + '\0').split('\0');
    for (let i = 0; i + 2 < attributes.length; i += 3) textAttributes.set(attributes[i], attributes[i + 2]);
  }
  try { commitSha = git(['rev-parse', 'HEAD']).trim(); } catch {}
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
  // Freeze runtime graders and their inputs as well as conventional test files.
  const snapshot = scanWorktree(root);
  const files = snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files;
  const entries = Object.entries(files).filter(([p]) => /^bench\/(checks|fixtures)\/|(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/.test(p)).map(([p, m]) => [p, m.isSecret ? hashFile(join(root, p)) : m.hash]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (!entries.length) throw new Error('Frozen test set is empty; retain real test files before reviewer/Stage-B');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
