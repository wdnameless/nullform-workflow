/**
 * tools/review/hot-path.mjs — which changed files force a performance measurement.
 *
 * A review cannot demand a benchmark for a comment fix, and cannot wave through a
 * latency change to the live dashboard. The predicate names the runtime surfaces this
 * repo actually serves: the dashboard server family, HTTP handling, and the collectors
 * that feed it. Everything else stays outside the perf rule.
 */

/** Paths whose runtime behavior is observable by a user waiting on the dashboard. */
const HOT_PATH_PATTERNS = [
  /(^|\/)dashboard[^/]*\.mjs$/i,
  /(^|\/)[^/]*http[^/]*\.mjs$/i,
  /(^|\/)[^/]*collectors?[^/]*\.mjs$/i,
];

/** Extensions that cannot change runtime behavior of the served product. */
const INERT_EXTENSIONS = /\.(md|markdown|txt|json|ya?ml)$/i;

/**
 * True when a changed file can change what a dashboard user waits on.
 * Documentation, fixtures, and test files are excluded — including tests named
 * after a hot module, because a test file is not the served surface.
 */
export function isHotPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (INERT_EXTENSIONS.test(normalized)) return false;
  if (/(^|\/)(tests?|__tests__|fixtures?)(\/|$)/i.test(normalized)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)) return false;
  return HOT_PATH_PATTERNS.some((rx) => rx.test(normalized));
}

/**
 * Split changed paths into hot and inert sets, and report whether the diff was
 * docs-only (which never triggers the perf rule).
 */
export function classifyDiffForPerf(files) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f.trim()) : [];
  const hot = list.filter(isHotPath);
  return {
    hot,
    requiresPerf: hot.length > 0,
    docsOnly: list.length > 0 && list.every((f) => INERT_EXTENSIONS.test(f.replace(/\\/g, "/"))),
  };
}
