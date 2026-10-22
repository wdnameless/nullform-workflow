import { spawnSync } from 'node:child_process';

const MAX_BEATS = 2000;
const MAX_GAP_MS = 45 * 60 * 1000;

/**
 * Append an event timestamp to journal.beats (cap 2000, drop oldest).
 */
export function recordBeat(journal, at = null) {
  if (!journal || typeof journal !== 'object') {
    throw new TypeError('journal must be an object');
  }
  if (!Array.isArray(journal.beats)) {
    journal.beats = [];
  }
  const iso = at ? new Date(at).toISOString() : new Date().toISOString();
  journal.beats.push(iso);
  if (journal.beats.length > MAX_BEATS) {
    journal.beats.splice(0, journal.beats.length - MAX_BEATS);
  }
  return iso;
}

/**
 * Start waiting state for a specific question/prompt kind.
 */
export function askKind(journal, kind, at = null) {
  if (!journal || typeof journal !== 'object') {
    throw new TypeError('journal must be an object');
  }
  const from = at ? new Date(at).toISOString() : new Date().toISOString();
  journal.waiting = { kind: String(kind || 'unknown'), from };
  return journal.waiting;
}

/**
 * Finish waiting state and archive it to journal.waits: [{ kind, from, to }].
 */
export function answered(journal, at = null) {
  if (!journal || typeof journal !== 'object') {
    throw new TypeError('journal must be an object');
  }
  if (!journal.waiting) {
    return null;
  }
  const to = at ? new Date(at).toISOString() : new Date().toISOString();
  const entry = {
    kind: journal.waiting.kind,
    from: journal.waiting.from,
    to,
  };
  if (!Array.isArray(journal.waits)) {
    journal.waits = [];
  }
  journal.waits.push(entry);
  delete journal.waiting;
  return entry;
}

/**
 * Compute honest working time in milliseconds:
 * Sum deltas <= 45 min between consecutive beats minus archived waits.
 */
export function honestTime(journal) {
  if (!journal || !Array.isArray(journal.beats) || journal.beats.length < 2) {
    return 0;
  }

  let activeMs = 0;
  for (let i = 0; i < journal.beats.length - 1; i++) {
    const t1 = new Date(journal.beats[i]).getTime();
    const t2 = new Date(journal.beats[i + 1]).getTime();
    if (Number.isNaN(t1) || Number.isNaN(t2)) continue;
    const delta = t2 - t1;
    if (delta > 0 && delta <= MAX_GAP_MS) {
      activeMs += delta;
    }
  }

  let waitMs = 0;
  if (Array.isArray(journal.waits)) {
    for (const w of journal.waits) {
      if (w && w.from && w.to) {
        const from = new Date(w.from).getTime();
        const to = new Date(w.to).getTime();
        if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) {
          waitMs += (to - from);
        }
      }
    }
  }

  return Math.max(0, activeMs - waitMs);
}

/**
 * Check if each commit is an ancestor of HEAD via git merge-base --is-ancestor.
 * Returns { ok, missing: string[] }.
 */
export function commitsCheck(repoDir, commits = []) {
  if (!Array.isArray(commits)) {
    return { ok: true, missing: [] };
  }
  const missing = [];
  for (const c of commits) {
    if (!c || typeof c !== 'string') continue;
    const res = spawnSync('git', ['merge-base', '--is-ancestor', c, 'HEAD'], {
      cwd: repoDir,
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status !== 0) {
      missing.push(c);
    }
  }
  return {
    ok: missing.length === 0,
    missing,
  };
}

/**
 * Format commit trailers for run / requirements.
 */
export function formatTrailers({ run, requirements } = {}) {
  const lines = [];
  if (run) lines.push(`Run: ${run}`);
  if (requirements) {
    const reqStr = Array.isArray(requirements) ? requirements.join(', ') : requirements;
    lines.push(`Requirements: ${reqStr}`);
  }
  return lines.join('\n');
}
