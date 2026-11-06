import test from "node:test";
import assert from "node:assert/strict";

import { isHotPath, classifyDiffForPerf } from "../review/hot-path.mjs";

test("dashboard, http and collector modules are hot paths", () => {
  for (const f of [
    "tools/dashboard.mjs",
    "tools/dashboard-ui.mjs",
    "tools/dashboard-collectors.mjs",
    "tools/review/http-runtime.mjs",
    "tools/collector-git.mjs",
  ]) {
    assert.equal(isHotPath(f), true, `${f} must be hot`);
  }
});

test("docs, config, and plain source are not hot paths", () => {
  for (const f of [
    "docs/GATES.md",
    "README.md",
    "tools/quality.mjs",
    "agent/AGENTS.md",
    "openspec/changes/x/manifest.md",
  ]) {
    assert.equal(isHotPath(f), false, `${f} must not be hot`);
  }
});

test("tests and fixtures named after hot modules never trigger the perf rule", () => {
  for (const f of [
    "tools/tests/dashboard.test.mjs",
    "tools/tests/dashboard-run.test.mjs",
    "tools/tests/fixtures/collector.json",
    "tools/review/__tests__/http-runtime.spec.mjs",
  ]) {
    assert.equal(isHotPath(f), false, `${f} must not be hot`);
  }
});

test("classifyDiffForPerf separates hot files and detects docs-only diffs", () => {
  const mixed = classifyDiffForPerf(["docs/GATES.md", "tools/dashboard.mjs", "tools/quality.mjs"]);
  assert.deepEqual(mixed.hot, ["tools/dashboard.mjs"]);
  assert.equal(mixed.requiresPerf, true);
  assert.equal(mixed.docsOnly, false);

  const docs = classifyDiffForPerf(["docs/GATES.md", "README.md", "notes.txt"]);
  assert.equal(docs.requiresPerf, false);
  assert.equal(docs.docsOnly, true);

  const none = classifyDiffForPerf([]);
  assert.equal(none.requiresPerf, false);
  assert.equal(none.docsOnly, false, "an empty diff is not a docs-only diff");
});

test("windows separators and blank input are handled", () => {
  assert.equal(isHotPath("tools\\dashboard-collectors.mjs"), true);
  assert.equal(isHotPath(""), false);
  assert.equal(isHotPath(null), false);
});
