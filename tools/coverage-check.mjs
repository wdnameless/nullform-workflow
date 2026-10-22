/**
 * Coverage check comparing spec text against brief text.
 *
 * NOTE: Blindness to manifest and tickets is strictly enforced by the caller
 * passing ONLY briefText and specText (no manifest or ticket access is provided
 * to this module or its caller context).
 *
 * @param {string} briefText - Raw brief content
 * @param {string} specText - Raw spec content
 * @returns {{ found: number, fixed: number, deferred: number, items: string[] }}
 */
export function coverageCheck(briefText = "", specText = "") {
  const normSpec = normalize(specText);
  const normSpecPunct = stripPunct(normSpec);

  const rawPieces = (briefText || "").split(/[.!?\r?\n]+/);
  const items = [];

  for (const piece of rawPieces) {
    const raw = piece.trim();
    if (!raw) continue;

    // Strip leading markdown bullets / heading markers
    const cleaned = raw.replace(/^[\s\-*#>]+/, "").trim();
    if (!cleaned) continue;

    const normSentence = normalize(cleaned);
    const normSentencePunct = stripPunct(normSentence);

    const matched =
      normSpec.includes(normSentence) ||
      (normSentencePunct && normSpecPunct.includes(normSentencePunct));

    if (!matched) {
      items.push(cleaned);
    }
  }

  return {
    found: items.length,
    fixed: 0,
    deferred: 0,
    items,
  };
}

/**
 * Gate determining if uncovered gaps are within allowed fixed + deferred count.
 *
 * @param {{ found: number, fixed?: number, deferred?: number }} result
 * @returns {boolean}
 */
export function coverageGate(result) {
  if (!result || typeof result.found !== "number") return false;
  const fixed = typeof result.fixed === "number" ? result.fixed : 0;
  const deferred = typeof result.deferred === "number" ? result.deferred : 0;
  return result.found <= fixed + deferred;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stripPunct(s) {
  return (s || "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
