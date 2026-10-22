/**
 * tools/supervision.mjs
 *
 * Supervision utilities for agent lifecycle:
 * - classify(manifest, tailLines): Match tail lines against declarative manifest
 * - waitForState(sample, want, opts): Event barrier awaiting desired state
 */

const VALID_STATES = new Set(["working", "blocked", "idle"]);

/**
 * Classify agent state from a declarative manifest and tail lines.
 *
 * @param {Array<{ id: string, state: "working"|"blocked"|"idle", pattern: string }>} manifest
 * @param {string[]} [tailLines=[]]
 * @returns {"working"|"blocked"|"idle"}
 */
export function classify(manifest, tailLines = []) {
  if (!Array.isArray(manifest)) {
    throw new TypeError("Manifest must be an array");
  }

  const compiled = manifest.map((rule) => {
    if (!rule || typeof rule !== "object") {
      throw new Error("Invalid manifest rule: expected an object");
    }
    const { id, state, pattern } = rule;
    if (!VALID_STATES.has(state)) {
      throw new Error(`Invalid state "${state}" in manifest rule "${id}"`);
    }
    if (typeof pattern !== "string") {
      throw new Error(`Invalid RegExp pattern in manifest rule "${id}": expected string`);
    }
    try {
      const regex = new RegExp(pattern);
      return { id, state, regex };
    } catch (err) {
      throw new Error(`Invalid RegExp pattern in manifest rule "${id}": ${err.message}`);
    }
  });

  const lines = Array.isArray(tailLines)
    ? tailLines
    : (tailLines != null ? [String(tailLines)] : []);

  if (lines.length === 0) {
    return "idle";
  }

  const fullText = lines.join("\n");

  for (const { state, regex } of compiled) {
    if (lines.some((line) => regex.test(line)) || regex.test(fullText)) {
      return state;
    }
  }

  return "idle";
}

/**
 * Await a target state via a sampling barrier with timeout.
 *
 * @param {() => (string | Promise<string>)} sample
 * @param {string | string[]} want
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options={}]
 * @returns {Promise<string>} Resolves with the observed wanted state
 */
export function waitForState(sample, want, { timeoutMs, intervalMs = 25 } = {}) {
  if (typeof sample !== "function") {
    throw new TypeError("sample must be a function");
  }

  const targets = new Set(Array.isArray(want) ? want : [want]);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer = null;
    let pollTimer = null;

    const cleanup = () => {
      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    if (typeof timeoutMs === "number") {
      timeoutTimer = setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new Error("timeout"));
        }
      }, timeoutMs);
    }

    const step = async () => {
      if (settled) return;
      try {
        const state = await sample();
        if (settled) return;
        if (targets.has(state)) {
          cleanup();
          resolve(state);
          return;
        }
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (!settled) {
        pollTimer = setTimeout(step, intervalMs);
      }
    };

    step();
  });
}
