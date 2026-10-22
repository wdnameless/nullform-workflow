/**
 * tools/usage-normalize.mjs
 * Provider usage normalization with UNKNOWN gaps (R02).
 *
 * Anthropic cache fields are additive:
 *   total = input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * OpenAI cache fields are subsets:
 *   total = prompt_tokens + completion_tokens (cached_tokens is already a subset of prompt_tokens)
 *
 * Unreported fields are 'UNKNOWN', never 0.
 */

function toCount(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return "UNKNOWN";
}

/**
 * Normalizes provider raw usage into canonical counters.
 *
 * @param {string} provider - 'anthropic' | 'openai'
 * @param {object} raw - Provider raw usage payload
 * @returns {{ totals: { input: number|string, output: number|string, cacheRead: number|string, cacheWrite: number|string, totalTokens: number|string }, unknown: string[] }}
 */
export function normalizeUsage(provider, raw) {
  if (typeof provider !== "string") {
    throw new Error(`Unknown provider: '${provider}'`);
  }
  const normProvider = provider.trim().toLowerCase();
  if (normProvider !== "anthropic" && normProvider !== "openai") {
    throw new Error(`Unknown provider: '${provider}'`);
  }

  const rawObj = (raw && typeof raw === "object") ? raw : {};
  let inputVal, outputVal, cacheReadVal, cacheWriteVal, totalVal;

  if (normProvider === "anthropic") {
    inputVal = toCount(rawObj.input_tokens ?? rawObj.inputTokens ?? rawObj.input);
    outputVal = toCount(rawObj.output_tokens ?? rawObj.outputTokens ?? rawObj.output);
    cacheReadVal = toCount(rawObj.cache_read_input_tokens ?? rawObj.cacheReadInputTokens ?? rawObj.cache_read_tokens ?? rawObj.cacheRead);
    cacheWriteVal = toCount(rawObj.cache_creation_input_tokens ?? rawObj.cacheCreationInputTokens ?? rawObj.cache_creation_tokens ?? rawObj.cacheWrite);

    const explicitTotal = toCount(rawObj.total_tokens ?? rawObj.totalTokens ?? rawObj.total);
    if (explicitTotal !== "UNKNOWN") {
      totalVal = explicitTotal;
    } else if (inputVal !== "UNKNOWN" && outputVal !== "UNKNOWN") {
      totalVal = inputVal + outputVal + (cacheReadVal !== "UNKNOWN" ? cacheReadVal : 0) + (cacheWriteVal !== "UNKNOWN" ? cacheWriteVal : 0);
    } else {
      totalVal = "UNKNOWN";
    }
  } else if (normProvider === "openai") {
    inputVal = toCount(rawObj.prompt_tokens ?? rawObj.promptTokens ?? rawObj.input ?? rawObj.input_tokens);
    outputVal = toCount(rawObj.completion_tokens ?? rawObj.completionTokens ?? rawObj.output ?? rawObj.output_tokens);

    const promptDetails = (rawObj.prompt_tokens_details && typeof rawObj.prompt_tokens_details === "object")
      ? rawObj.prompt_tokens_details
      : null;
    const rawCached = promptDetails?.cached_tokens ?? rawObj.cached_tokens ?? rawObj.cachedTokens ?? rawObj.cacheRead;
    cacheReadVal = toCount(rawCached);
    cacheWriteVal = toCount(rawObj.cache_creation_tokens ?? rawObj.cacheWrite ?? rawObj.cache_creation_input_tokens);

    const explicitTotal = toCount(rawObj.total_tokens ?? rawObj.totalTokens ?? rawObj.total);
    if (explicitTotal !== "UNKNOWN") {
      totalVal = explicitTotal;
    } else if (inputVal !== "UNKNOWN" && outputVal !== "UNKNOWN") {
      // In OpenAI, cached_tokens is already a subset of prompt_tokens; additive would double-count.
      totalVal = inputVal + outputVal;
    } else {
      totalVal = "UNKNOWN";
    }
  }

  const totals = {
    input: inputVal,
    output: outputVal,
    cacheRead: cacheReadVal,
    cacheWrite: cacheWriteVal,
    totalTokens: totalVal,
  };

  Object.defineProperty(totals, "total", {
    get() { return this.totalTokens; },
    set(v) { this.totalTokens = v; },
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(totals, "prompt_tokens", {
    get() { return this.input; },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(totals, "completion_tokens", {
    get() { return this.output; },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(totals, "input_tokens", {
    get() { return this.input; },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(totals, "output_tokens", {
    get() { return this.output; },
    enumerable: false,
    configurable: true,
  });

  const unknown = [];
  for (const [key, value] of Object.entries(totals)) {
    if (value === "UNKNOWN") {
      unknown.push(key);
    }
  }

  return { totals, unknown };
}
