/**
 * tools/review/arbitrate.mjs
 * Arbitrate review findings against acceptance criteria.
 */

/**
 * Arbitrate findings against a list of criterion ids.
 *
 * @param {Array<{id: string, criterion: string}>} findings
 * @param {string[]} criteria
 * @returns {{ accepted: Array<{id: string, criterion: string}>, dropped: Array<{id: string, criterion: string, reason: string}> }}
 */
export function arbitrate(findings = [], criteria = []) {
  const allowed = new Set(Array.isArray(criteria) ? criteria : []);
  const accepted = [];
  const dropped = [];

  for (const finding of (Array.isArray(findings) ? findings : [])) {
    if (finding && typeof finding === 'object' && allowed.has(finding.criterion)) {
      accepted.push(finding);
    } else {
      dropped.push({
        ...finding,
        reason: 'no-criterion-match',
      });
    }
  }

  return { accepted, dropped };
}

/**
 * Scores review findings independently across three axes: manifest, spec, craft.
 * Counts only blocker findings per axis.
 *
 * @param {Array<{axis: "manifest"|"spec"|"craft", severity: "blocker"|"minor", text?: string}>} findings
 * @returns {{ manifest: number, spec: number, craft: number }}
 */
export function scoreReview(findings = []) {
  const scores = { manifest: 0, spec: 0, craft: 0 };
  if (!Array.isArray(findings)) return scores;

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const axis = typeof finding.axis === 'string' ? finding.axis.toLowerCase() : '';
    const severity = typeof finding.severity === 'string' ? finding.severity.toLowerCase() : '';
    if (severity === 'blocker' && Object.prototype.hasOwnProperty.call(scores, axis)) {
      scores[axis]++;
    }
  }

  return scores;
}

/**
 * Consolidates branch blockers into a single F1 ticket object.
 *
 * @param {Array<any>} blockers
 * @returns {{ id: "F1", items: Array<any> }}
 */
export function consolidateF1(blockers = []) {
  const list = Array.isArray(blockers) ? blockers : [];
  const items = list.filter((item) => {
    if (item && typeof item === 'object' && 'severity' in item) {
      return String(item.severity).toLowerCase() === 'blocker';
    }
    return true;
  });

  return {
    id: 'F1',
    items,
  };
}

/**
 * Enforces repair budget allowances: <=2 repairs, <=2 retries, <=2 re-reviews
 * Throws when limits are exceeded, naming the exceeded limit.
 * Otherwise returns remaining allowances.
 *
 * @param {{ repairs?: number, retries?: number, reReviews?: number }} [state]
 * state that a gate gets one initial review plus at most two re-reviews.
 * @returns {{ repairs: number, retries: number, reReviews: number }}
 */
export function repairBudget(state = {}) {
  const { repairs = 0, retries = 0, reReviews = 0 } = state ?? {};

  if (repairs > 2) {
    throw new Error(`Repair budget exhausted: repairs (${repairs}) exceeds limit of 2`);
  }
  if (retries > 2) {
    throw new Error(`Retry budget exhausted: retries (${retries}) exceeds limit of 2`);
  }
  if (reReviews > 2) {
    throw new Error(`Re-review budget exhausted: reReviews (${reReviews}) exceeds limit of 2`);
  }

  return {
    repairs: 2 - repairs,
    retries: 2 - retries,
    reReviews: 2 - reReviews,
  };
}
