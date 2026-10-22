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
