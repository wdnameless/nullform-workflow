/**
 * tools/fallback.mjs
 * Tool fallback order and token budget / context compaction policy (R08).
 *
 * withFallback([fnA, fnB, ...], args, { log } = {})
 *   Tries fns in order, collects tried name/index, logs order, returns { result, tried }
 *   on success or throws Error naming the tried order when all fail.
 *
 * checkBudget({ used, limit, compactAt = 0.8 })
 *   Returns "refuse" when used >= limit,
 *   "compact" when used >= limit * compactAt,
 *   else "ok".
 */

export async function withFallback(fns = [], args = undefined, { log = null } = {}) {
  const tried = [];
  let lastError = null;

  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    const name = fn.name || String(i);
    tried.push(name);
    if (Array.isArray(log)) {
      log.push(name);
    }

    try {
      const callArgs = Array.isArray(args) ? args : (args !== undefined ? [args] : []);
      const result = await fn(...callArgs);
      return { result, tried };
    } catch (err) {
      lastError = err;
    }
  }

  const orderStr = tried.join(", ");
  throw new Error(`All fallbacks failed. Tried order: [${orderStr}]${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

export function checkBudget({ used, limit, compactAt = 0.8 }) {
  if (typeof used !== "number" || typeof limit !== "number") {
    throw new TypeError("checkBudget requires numeric 'used' and 'limit'");
  }
  if (used >= limit) {
    return "refuse";
  }
  if (used >= limit * compactAt) {
    return "compact";
  }
  return "ok";
}
