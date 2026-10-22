/**
 * tools/worker-contract.mjs
 * Validation for worker return contracts.
 */

const REQUIRED_SECTIONS = [
  'STATUS',
  'FILES',
  'TESTS',
  'INTERFACES',
  'REQUIREMENTS',
  'CONCERNS',
];

/**
 * Validates worker report text against contract rules.
 * Requires REDPROOF: line, mandatory sections, and <= 25 non-empty lines.
 *
 * @param {string} text
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function validateWorkerReport(text) {
  const violations = [];

  if (typeof text !== 'string') {
    return {
      ok: false,
      violations: ['report must be a string'],
    };
  }

  const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length > 25) {
    violations.push(`oversize: report has ${nonEmptyLines.length} lines (max 25)`);
  }

  const hasRedproof = nonEmptyLines.some((line) => /(?:^|\s)REDPROOF\s*:/i.test(line));
  if (!hasRedproof) {
    violations.push('missing REDPROOF: line');
  }

  for (const section of REQUIRED_SECTIONS) {
    const pattern = section === 'REQUIREMENTS'
      ? /\bREQUIREMENTS?\b/i
      : new RegExp(`\\b${section}\\b`, 'i');

    const hasSection = nonEmptyLines.some((line) => pattern.test(line));
    if (!hasSection) {
      violations.push(`missing ${section} section`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
