/**
 * tools/tests/sync-manifest-coverage.test.mjs — Verify dashboard dependencies are declared in sync-manifest.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

test("sync-manifest: covers all relative imports in tools/dashboard.mjs", () => {
  const dashboardPath = resolve(REPO_ROOT, "tools", "dashboard.mjs");
  const manifestPath = resolve(REPO_ROOT, "tools", "sync-manifest.json");

  assert.ok(existsSync(dashboardPath), "tools/dashboard.mjs must exist");
  assert.ok(existsSync(manifestPath), "tools/sync-manifest.json must exist");

  const dashboardSource = readFileSync(dashboardPath, "utf8");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.ok(Array.isArray(manifest), "sync-manifest.json must be an array");
  const manifestEntries = new Set(manifest.map((entry) => entry.rel));

  // Parse relative import and re-export specifiers matching `from "./x"` or `from './x'`
  const importPattern = /from\s+["'](\.[^"']+)["']/g;
  const matches = [...dashboardSource.matchAll(importPattern)].map((m) => m[1]);

  assert.ok(matches.length > 0, "tools/dashboard.mjs must contain relative imports");

  const uniqueImports = [...new Set(matches)];

  for (const relImport of uniqueImports) {
    const resolvedRel = posix.normalize(posix.join("tools", relImport));
    assert.ok(
      manifestEntries.has(resolvedRel),
      `Relative import "${relImport}" in tools/dashboard.mjs resolved to "${resolvedRel}", which must be listed in tools/sync-manifest.json`
    );
    assert.ok(
      existsSync(resolve(REPO_ROOT, resolvedRel)),
      `Resolved file "${resolvedRel}" must exist on disk`
    );
  }

  // Specifically verify that brief.mjs is covered
  assert.ok(
    manifestEntries.has("tools/brief.mjs"),
    "tools/brief.mjs must be present in tools/sync-manifest.json"
  );
});
