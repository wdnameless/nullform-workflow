import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
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
 * Verify SHA-256 of each locked SKILL.md against a lock file.
 * Throws an Error naming the skill if hash mismatches or file is missing.
 */
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

  const entries = [];
  const source = lockData.skills || lockData;
  if (Array.isArray(source)) {
    for (const s of source) {
      if (s) {
        entries.push({
          name: s.name || s.skill || s.id,
          expectedHash: s.hash || s.sha256,
          path: s.path || null,
        });
      }
    }
  } else if (source && typeof source === 'object') {
    for (const [key, val] of Object.entries(source)) {
      if (key === 'version' || key === 'generatedAt') continue;
      if (typeof val === 'string') {
        entries.push({ name: key, expectedHash: val, path: null });
      } else if (val && typeof val === 'object') {
        entries.push({
          name: key,
          expectedHash: val.hash || val.sha256,
          path: val.path || null,
        });
      }
    }
  }

  const baseDir = rootDir ? resolve(rootDir) : dirname(lockAbs);
  const verified = [];

  for (const entry of entries) {
    const skillName = entry.name;
    const candidates = [];
    if (entry.path) {
      candidates.push(resolve(baseDir, entry.path));
      candidates.push(resolve(dirname(lockAbs), entry.path));
    }
    candidates.push(resolve(baseDir, 'skills', skillName, 'SKILL.md'));
    candidates.push(resolve(baseDir, skillName, 'SKILL.md'));
    candidates.push(resolve(baseDir, skillName));
    candidates.push(resolve(dirname(lockAbs), 'skills', skillName, 'SKILL.md'));
    candidates.push(resolve(dirname(lockAbs), skillName, 'SKILL.md'));

    let foundFile = null;
    for (const c of candidates) {
      if (existsSync(c)) {
        foundFile = c;
        break;
      }
    }

    if (!foundFile) {
      const err = new Error(`Skill "${skillName}" verification failed: SKILL.md not found`);
      err.skill = skillName;
      if (throws) throw err;
      return { ok: false, skill: skillName, error: err.message };
    }

    const content = readFileSync(foundFile);
    const actualHash = createHash('sha256').update(content).digest('hex');
    const expected = String(entry.expectedHash || '').toLowerCase();

    if (actualHash.toLowerCase() !== expected) {
      const err = new Error(`Skill "${skillName}" verification failed: hash mismatch (expected ${expected}, got ${actualHash})`);
      err.skill = skillName;
      if (throws) throw err;
      return { ok: false, skill: skillName, error: err.message };
    }

    verified.push(skillName);
  }

  return { ok: true, verified };
}
