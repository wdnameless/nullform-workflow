import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CACHE_VERSION = 1;
const CACHE_FILE = ".archmap/cache.json";

/**
 * Loads cache from root/.archmap/cache.json.
 * @param {string} root
 * @returns {{ version: number, entries: Record<string, { hash: string, members: any[], imports: string[], exports: string[] }> }}
 */
export function loadCache(root) {
  const p = join(root, CACHE_FILE);
  if (!existsSync(p)) {
    return { version: CACHE_VERSION, entries: {} };
  }
  try {
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
    return { version: CACHE_VERSION, entries: {} };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Saves cache to root/.archmap/cache.json.
 * @param {string} root
 * @param {{ version: number, entries: Record<string, any> }} cache
 */
export function saveCache(root, cache) {
  const p = join(root, CACHE_FILE);
  mkdirSync(join(root, ".archmap"), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2), "utf8");
}
