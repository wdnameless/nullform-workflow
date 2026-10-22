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

export function defaultIsRetryable(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (status === 429 || status === 503 || status === "429" || status === "503") return true;
  const code = err.code;
  if (code === 429 || code === 503 || code === "429" || code === "503") return true;
  if (typeof err.message === "string" && /\b(429|503)\b/.test(err.message)) return true;
  return false;
}

/**
 * Circuit breaker with failback to reserve on retryable failures (R07).
 * Opens after `threshold` consecutive retryable failures, routes to `reserve`
 * while open, closes after one successful probe.
 * Non-retryable errors pass through without tripping.
 */
export function withBreaker(primary, { reserve, threshold = 3, isRetryable = defaultIsRetryable } = {}) {
  if (typeof primary !== "function") {
    throw new TypeError("withBreaker requires a function for 'primary'");
  }

  let failures = 0;
  let isOpen = false;

  const breaker = async function (...args) {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && args[0].probe === true) {
      return await breaker.probe();
    }

    if (isOpen) {
      if (typeof reserve === "function") {
        return await reserve(...args);
      }
      return reserve;
    }

    try {
      const res = await primary(...args);
      failures = 0;
      return res;
    } catch (err) {
      if (!isRetryable(err)) {
        throw err;
      }
      failures++;
      if (failures >= threshold) {
        isOpen = true;
      }
      throw err;
    }
  };

  breaker.probe = async function (...args) {
    const res = await primary(...args);
    failures = 0;
    isOpen = false;
    return res;
  };

  Object.defineProperty(breaker, "isOpen", {
    get() { return isOpen; },
    set(v) { isOpen = Boolean(v); },
  });

  Object.defineProperty(breaker, "failures", {
    get() { return failures; },
    set(v) { failures = Number(v); },
  });

  Object.defineProperty(breaker, "state", {
    get() { return isOpen ? "open" : "closed"; },
  });

  breaker.open = () => { isOpen = true; };
  breaker.close = () => { isOpen = false; failures = 0; };

  return breaker;
}
