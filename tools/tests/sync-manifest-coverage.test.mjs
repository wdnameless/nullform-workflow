/**
 * tools/tests/sync-manifest-coverage.test.mjs — Verify entrypoint import closures are declared in sync-manifest.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

// Entry points the live harness must boot: missing transitive deps = ERR_MODULE_NOT_FOUND at runtime.
const ENTRYPOINTS = ["tools/dashboard.mjs", "tools/workflow.mjs"];

function relativeImportsOf(source) {
  const pattern = /from\s+["'](\.[^"']+)["']/g;
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1]))].filter((s) => s.endsWith(".mjs"));
}

function closureOf(entryRel) {
  const seen = new Set([entryRel]);
  const queue = [entryRel];
  while (queue.length > 0) {
    const rel = queue.pop();
    const abs = resolve(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    const dir = posix.dirname(rel);
    for (const spec of relativeImportsOf(readFileSync(abs, "utf8"))) {
      const next = posix.normalize(posix.join(dir, spec));
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  seen.delete(entryRel);
  return [...seen];
}

for (const entry of ENTRYPOINTS) {
  test(`sync-manifest: covers transitive closure of ${entry}`, () => {
    const manifestPath = resolve(REPO_ROOT, "tools", "sync-manifest.json");
    assert.ok(existsSync(resolve(REPO_ROOT, entry)), `${entry} must exist`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest), "sync-manifest.json must be an array");
    const entries = new Set(manifest.map((e) => e.rel));
    const closure = closureOf(entry);
    assert.ok(closure.length > 0, `${entry} must have relative imports`);
    for (const dep of closure) {
      assert.ok(entries.has(dep), `${entry}: transitive import "${dep}" must be listed in tools/sync-manifest.json`);
      assert.ok(existsSync(resolve(REPO_ROOT, dep)), `resolved file "${dep}" must exist on disk`);
    }
  });
}

test("sync-manifest: covers brief.mjs (R08 root cause)", () => {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "tools", "sync-manifest.json"), "utf8"));
  assert.ok(new Set(manifest.map((e) => e.rel)).has("tools/brief.mjs"));
});
