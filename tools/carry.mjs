import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Copy open debts and placeholders from prev run dir to next carried.md (markdown list).
 * Also carries over JSON files to nextDir for subsequent round-trip propagation.
 */
export function carryDebts(prevDir, nextDir) {
  const prevAbs = resolve(prevDir);
  const nextAbs = resolve(nextDir);
  mkdirSync(nextAbs, { recursive: true });

  const items = [];
  const copiedJsonFiles = [];

  if (existsSync(prevAbs)) {
    const files = readdirSync(prevAbs);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const fullPath = join(prevAbs, f);
        try {
          const content = readFileSync(fullPath, 'utf8');
          const data = JSON.parse(content);
          copiedJsonFiles.push({ name: f, data, path: fullPath });
          copyFileSync(fullPath, join(nextAbs, f));

          const rawList = [];
          if (Array.isArray(data)) {
            rawList.push(...data);
          } else if (data && typeof data === 'object') {
            if (Array.isArray(data.debts)) rawList.push(...data.debts);
            if (Array.isArray(data.placeholders)) rawList.push(...data.placeholders);
            if (Array.isArray(data.items)) rawList.push(...data.items);
            if (Array.isArray(data.open)) rawList.push(...data.open);
            if (rawList.length === 0) rawList.push(data);
          }

          for (const item of rawList) {
            if (typeof item === 'string') {
              items.push(item);
            } else if (item && typeof item === 'object') {
              const text = item.what || item.description || item.text || item.title;
              const ceilingPart = item.ceiling ? ` (ceiling: ${item.ceiling})` : '';
              if (item.id && text) {
                items.push(`${item.id}: ${text}${ceilingPart}`);
              } else if (item.what) {
                items.push(`${item.what}${ceilingPart}`);
              } else if (text) {
                items.push(`${text}${ceilingPart}`);
              } else if (item.id) {
                items.push(item.id);
              } else {
                items.push(JSON.stringify(item));
              }
            }
          }
        } catch {
          // Ignore unparseable JSON files
        }
      }
    }

    // If no JSON files were found or yielded items, check for an existing carried.md
    if (items.length === 0 && existsSync(join(prevAbs, 'carried.md'))) {
      try {
        const mdText = readFileSync(join(prevAbs, 'carried.md'), 'utf8');
        for (const line of mdText.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            const val = trimmed.replace(/^[-*]\s+/, '').trim();
            if (val && val !== '(none)') {
              items.push(val);
            }
          }
        }
        if (items.length > 0 && copiedJsonFiles.length === 0) {
          // Write a debts.json in nextDir to preserve round-trip capabilities
          writeFileSync(join(nextAbs, 'debts.json'), JSON.stringify(items, null, 2), 'utf8');
        }
      } catch {}
    }
  }

  const lines = ['# Carried Debts and Placeholders', ''];
  if (items.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('');

  const targetPath = join(nextAbs, 'carried.md');
  writeFileSync(targetPath, lines.join('\n'), 'utf8');
  return targetPath;
}

/**
 * Deterministic hash over a skill's whole directory: every file, sorted, with its
 * repo-relative path folded in so a rename changes the digest and an added reference file
 * is caught.
 *
 * Why this exists: `hash` covers SKILL.md only, so 45 of our 72 skills ship 476 bundled
 * files (`references/*.md`, scripts) that a tampered install could change invisibly —
 * the SKILL.md still matched. Vercel's skills CLI tracks this as `skillFolderHash`.
 * Line endings are normalised so a Windows checkout and a Linux CI agree.
 */
export function skillFolderHash(skillDir) {
  const abs = resolve(skillDir);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(abs);
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    const rel = relative(abs, file).split(sep).join('/');
    digest.update(rel + '\0');
    digest.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    digest.update('\0');
  }
  return digest.digest('hex');
}

/**
 * Verify SHA-256 of each locked SKILL.md against a lock file.
 * When an entry carries `folderHash`, the whole skill directory is verified too, so a
 * swapped `references/*.md` cannot hide behind an unchanged SKILL.md.
 * Throws an Error naming the skill if hash mismatches or file is missing.
 */
/** Normalize the two accepted lock shapes into one entry list. */
function lockEntries(lockData) {
  const source = lockData.skills || lockData;
  if (Array.isArray(source)) {
    return source.filter(Boolean).map((s) => ({ name: s.name || s.skill || s.id, expectedHash: s.hash || s.sha256, path: s.path || null }));
  }
  return mapLockEntries(source);
}

/** The object-shaped lock: `name -> hash` or `name -> { hash, folderHash, path }`. */
function mapLockEntries(source) {
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source)
    .filter(([key]) => key !== 'version' && key !== 'generatedAt')
    .map(([key, val]) => (typeof val === 'string'
      ? { name: key, expectedHash: val, path: null }
      : (val && typeof val === 'object'
        ? { name: key, expectedHash: val.hash || val.sha256, path: val.path || null, folderHash: typeof val.folderHash === 'string' ? val.folderHash.toLowerCase() : null }
        : null)))
    .filter(Boolean);
}

/** Where a locked skill's SKILL.md may live, in priority order. */
function skillFileCandidates(entry, baseDir, lockAbs) {
  const { name, path } = entry;
  const out = [];
  if (path) {
    out.push(resolve(baseDir, path));
    out.push(resolve(dirname(lockAbs), path));
  }
  out.push(resolve(baseDir, 'skills', name, 'SKILL.md'));
  out.push(resolve(baseDir, name, 'SKILL.md'));
  out.push(resolve(baseDir, name));
  out.push(resolve(dirname(lockAbs), 'skills', name, 'SKILL.md'));
  out.push(resolve(dirname(lockAbs), name, 'SKILL.md'));
  return out;
}

/** Verify one entry. Returns an error message, or null when the entry is sound. */
function entryProblem(entry, baseDir, lockAbs) {
  const foundFile = skillFileCandidates(entry, baseDir, lockAbs).find((c) => existsSync(c));
  if (!foundFile) return `Skill "${entry.name}" verification failed: SKILL.md not found`;
  const actualHash = createHash('sha256').update(readFileSync(foundFile)).digest('hex');
  const expected = String(entry.expectedHash || '').toLowerCase();
  if (actualHash.toLowerCase() !== expected) {
    return `Skill "${entry.name}" verification failed: hash mismatch (expected ${expected}, got ${actualHash})`;
  }
  if (entry.folderHash) {
    const actualFolder = skillFolderHash(dirname(foundFile));
    if (actualFolder !== entry.folderHash) {
      return `Skill "${entry.name}" verification failed: bundled files changed (folder hash ${actualFolder} != expected ${entry.folderHash})`;
    }
  }
  return null;
}

export function verifySkillsLock(lockPath, rootDir = null, { throws = true } = {}) {
  const lockAbs = resolve(lockPath);
  if (!existsSync(lockAbs)) {
    const err = new Error(`Lock file not found: ${lockAbs}`);
    if (throws) throw err;
    return { ok: false, error: err.message };
  }

  let lockData;
  try {
    lockData = JSON.parse(readFileSync(lockAbs, 'utf8'));
  } catch (err) {
    if (throws) throw new Error(`Invalid lock JSON at ${lockAbs}: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const entries = lockEntries(lockData);

  const baseDir = rootDir ? resolve(rootDir) : dirname(lockAbs);
  const verified = [];

  for (const entry of entries) {
    const problem = entryProblem(entry, baseDir, lockAbs);
    if (problem) {
      const err = new Error(problem);
      err.skill = entry.name;
      if (throws) throw err;
      return { ok: false, skill: entry.name, error: err.message };
    }
    verified.push(entry.name);
  }

  return { ok: true, verified };
}
