/**
 * tools/checklists.mjs
 * Depth dimensions and adversarial question checklists for specs and Wave 0.
 */

export const DEPTH_DIMENSIONS = [
  'first-run',
  'empty',
  'wrong-input',
  'failure',
  'interruption',
  'growth',
  'boundaries',
  'aftermath',
];

export const ADVERSARIAL_QUESTIONS = [
  'failure',
  'collision',
  'unverified',
  'cost',
  'dependency',
  'second-week',
  'second-actor',
];

const DIMENSION_PATTERNS = {
  'first-run': /\bfirst[-_\s]?run\b/i,
  'empty': /\bempty\b/i,
  'wrong-input': /\bwrong[-_\s]?input\b/i,
  'failure': /\bfailure\b/i,
  'interruption': /\binterruption\b/i,
  'growth': /\bgrowth\b/i,
  'boundaries': /\bboundar(?:ies|y)\b/i,
  'aftermath': /\baftermath\b/i,
};

/**
 * Static documented prompts for the 7 adversarial questions.
 */
export const ADVERSARIAL_PROMPTS = Object.freeze([
  'failure: How does the system handle unexpected failure or crashes?',
  'collision: How are concurrent operations and resource collisions prevented?',
  'unverified: What claims or assumptions remain unverified before execution?',
  'cost: What are the worst-case cost, memory, and token expenditures?',
  'dependency: How does the system degrade if an external dependency is missing?',
  'second-week: How does the design hold up during second-week maintenance and drift?',
  'second-actor: What happens when a second-actor interferes with active tasks?',
]);

/**
 * Checks spec text against the 8 depth dimensions.
 * Returns missing dimension names (keyword-anchored, case-insensitive).
 *
 * @param {string} specText
 * @returns {string[]}
 */
export function depthChecklist(specText) {
  if (typeof specText !== 'string' || specText.trim().length === 0) {
    return [...DEPTH_DIMENSIONS];
  }

  const missing = [];
  for (const dim of DEPTH_DIMENSIONS) {
    const pattern = DIMENSION_PATTERNS[dim];
    if (!pattern || !pattern.test(specText)) {
      missing.push(dim);
    }
  }

  return missing;
}

/**
 * Runs the static adversarial pass for a brief.
 * Returns the 7 question prompts as documented static prompts.
 * Pure function, never calls LLM.
 *
 * @param {string} [_briefText]
 * @returns {string[]}
 */
export function adversarialPass(_briefText = '') {
  return [...ADVERSARIAL_PROMPTS];
}
