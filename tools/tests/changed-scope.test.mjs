/**
 * tools/tests/changed-scope.test.mjs — tests for shared changed-files scope.
 *
 * Covers git-diff scoping + suite matching on temp repos. Fast, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBaseRef,
  resolveRoot,
  gitDiff,
  getChangedFiles,
  getChangedLines,
  findMatchingSuite,
  filterCandidateFiles,
  classifyScope,
  parseUnifiedDiff,
} from "../changed-scope.mjs";
import { loadScope } from "../clone-coverage.mjs";

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "changed-scope-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("resolveBaseRef: explicit ref wins, HEAD~1 fallback, null on empty", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    writeFileSync(join(root, "a.mjs"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    assert.equal(resolveBaseRef(root, "HEAD"), "HEAD");
    writeFileSync(join(root, "b.mjs"), "export const b = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "two");
    assert.equal(resolveBaseRef(root), "HEAD~1");
  } finally {
    cleanup();
  }
});

test("getChangedFiles/getChangedLines: worktree fallback when base == head", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\nexport const b = 2;\n");
    assert.deepEqual(getChangedFiles(root, "HEAD", "HEAD"), ["tools/a.mjs"]);
    assert.deepEqual(getChangedLines(root, "HEAD", "HEAD", "tools/a.mjs"), [2]);
    assert.ok(gitDiff(root, ["--name-only", "HEAD"]) !== null);
    // clean tree: empty diff with base == head still returns [] (not null)
    git("add", "-A");
    git("commit", "-qm", "clean");
    assert.deepEqual(getChangedFiles(root, "HEAD", "HEAD"), []);
  } finally {
    cleanup();
  }
});

test("findMatchingSuite: direct, stripped and fuzzy candidates", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "tools", "tests"), { recursive: true });
    writeFileSync(join(root, "tools", "tests", "a.test.mjs"), "import test from 'node:test';\n");
    writeFileSync(join(root, "tools", "tests", "x.test.mjs"), "import test from 'node:test';\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    assert.equal(findMatchingSuite(root, "tools/a.mjs"), "tools/tests/a.test.mjs");
    assert.equal(findMatchingSuite(root, "tools/bench-x.mjs"), "tools/tests/x.test.mjs");
    assert.equal(findMatchingSuite(root, "tools/none.mjs"), null);
  } finally {
    cleanup();
  }
});

test("filterCandidateFiles: keeps sources, drops tests and missing", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "tools", "tests"), { recursive: true });
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\n");
    writeFileSync(join(root, "tools", "tests", "a.test.mjs"), "x\n");
    const out = filterCandidateFiles(root, ["tools/a.mjs", "tools/tests/a.test.mjs", "tools/missing.mjs", "note.md"]);
    assert.deepEqual(out, ["tools/a.mjs"]);
  } finally {
    cleanup();
  }
});

test("resolveBaseRef: env fallbacks and failure branches", () => {
  const { root, git, cleanup } = makeGitRepo();
  const saved = { ...process.env };
  try {
    writeFileSync(join(root, "a.mjs"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    // invalid explicit ref passes through (caller validates liveness separately)
    assert.equal(resolveBaseRef(root, "no-such-ref"), "no-such-ref");
    // BASE_REF env resolves via rev-parse
    process.env.BASE_REF = "HEAD";
    delete process.env.GITHUB_BASE_REF;
    assert.equal(resolveBaseRef(root), "HEAD");
    // GITHUB_BASE_REF fallback when BASE_REF unset
    delete process.env.BASE_REF;
    process.env.GITHUB_BASE_REF = "HEAD";
    assert.equal(resolveBaseRef(root), "HEAD");
    // both set, BASE_REF invalid → GITHUB ignored (|| short-circuit), falls through to null
    // (documents: invalid BASE_REF is NOT skipped; kills ||→&& on L35 which would resolve HEAD)
    process.env.BASE_REF = "no-such-ref";
    assert.strictEqual(resolveBaseRef(root), null);
    delete process.env.BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    // GITHUB_EVENT_NAME + GITHUB_EVENT_BEFORE resolve a real push base (kills ||→&& L41/L42)
    const sha = git("rev-parse", "HEAD").trim();
    process.env.GITHUB_EVENT_NAME = "push";
    process.env.GITHUB_EVENT_BEFORE = sha;
    assert.strictEqual(resolveBaseRef(root), sha);
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_EVENT_BEFORE;
    // EVENT_NAME + PUSH_BASE resolve a real push base (positive push path)
    process.env.EVENT_NAME = "push";
    process.env.PUSH_BASE = sha;
    assert.strictEqual(resolveBaseRef(root), sha);
    delete process.env.EVENT_NAME;
    delete process.env.PUSH_BASE;
    // non-push event with valid base does NOT take push path (kills ===→!== on L43)
    process.env.EVENT_NAME = "pull_request";
    process.env.PUSH_BASE = "HEAD";
    assert.strictEqual(resolveBaseRef(root), null);
    // push event with zero base is ignored → HEAD~1 missing → null (strict: undefined fails)
    delete process.env.GITHUB_BASE_REF;
    process.env.EVENT_NAME = "push";
    process.env.PUSH_BASE = "0000000";
    assert.strictEqual(resolveBaseRef(root), null);
    // unknown event + single commit → no HEAD~1 → null (strict: undefined fails)
    delete process.env.EVENT_NAME;
    delete process.env.PUSH_BASE;
    assert.strictEqual(resolveBaseRef(root), null);
    // invalid git args → gitDiff null (strict: undefined fails)
    assert.strictEqual(gitDiff(root, ["--not-a-flag", "???"]), null);
  } finally {
    process.env = saved;
    cleanup();
  }
});

test("resolveRoot: explicit path or default script-parent", () => {
  const root = resolveRoot();
  assert.ok(root && typeof root === "string");
  const explicit = resolveRoot("./fixtures");
  assert.ok(explicit.endsWith("fixtures"));
});

test("findMatchingSuite: custom suitesDir on fixture foreign tree", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    // Foreign tree without tools/tests dir
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "spec"), { recursive: true });
    writeFileSync(join(root, "src", "engine.mjs"), "export const engine = true;\n");
    writeFileSync(join(root, "spec", "engine.test.mjs"), "import test from 'node:test';\n");
    git("add", "-A");
    git("commit", "-qm", "foreign tree");

    // Default suitesDir (tools/tests) does not exist -> returns null, never crashes
    assert.equal(findMatchingSuite(root, "src/engine.mjs"), null);

    // Custom suitesDir finds the test in spec
    assert.equal(findMatchingSuite(root, "src/engine.mjs", "spec"), "spec/engine.test.mjs");
  } finally {
    cleanup();
  }
});

test("loadScope: loads .clone.json {scope:[...]} from root, falls back to DEFAULT_SCOPE", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    // Without file -> DEFAULT_SCOPE
    const def = loadScope(root);
    assert.ok(Array.isArray(def) && def.length > 0);

    // With .clone.json
    writeFileSync(join(root, ".clone.json"), JSON.stringify({ scope: ["src/**/*.js", "lib/**/*.mjs"] }));
    const custom = loadScope(root);
    assert.deepEqual(custom, ["src/**/*.js", "lib/**/*.mjs"]);
  } finally {
    cleanup();
  }
});

test("classifyScope: mixed diff triggers split advisory, separates in_scope and likely_creep, detects config and deps/renames", () => {
  const sampleDiff = `diff --git a/tools/changed-scope.mjs b/tools/changed-scope.mjs
index 1111..2222 100644
--- a/tools/changed-scope.mjs
+++ b/tools/changed-scope.mjs
@@ -10,2 +10,3 @@
-export function legacyScopeResolver() {}
+export function modernScopeResolver() {}
diff --git a/docs/unrelated.md b/docs/unrelated.md
new file mode 100644
--- /dev/null
+++ b/docs/unrelated.md
@@ -0,0 +1,2 @@
+# Notes
+Random doc creep.
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -15,1 +15,2 @@
   "dependencies": {
+    "fast-glob": "^3.3.2"
`;

  const intent = { zone: ["tools/changed-scope.mjs"] };
  const report = classifyScope(sampleDiff, intent);

  assert.deepEqual(report.in_scope, ["tools/changed-scope.mjs"]);
  assert.deepEqual(report.likely_creep, ["docs/unrelated.md", "package.json"]);
  assert.deepEqual(report.config_edits, ["package.json"]);
  assert.deepEqual(report.new_deps, ["fast-glob"]);
  assert.equal(report.api_renames.length, 1);
  assert.equal(report.api_renames[0].from, "legacyScopeResolver");
  assert.equal(report.api_renames[0].to, "modernScopeResolver");
  assert.equal(report.advisory, "split");
  assert.equal(report.stats.files, 3);
  assert.equal(report.stats.in_scope, 1);
  assert.equal(report.stats.likely_creep, 2);
  assert.ok(report.stats.additions > 0);
  assert.ok(report.stats.deletions > 0);
});

test("classifyScope: empty signals handling — empty diff yields keep, empty intent yields justify", () => {
  // Empty diff -> keep
  const emptyReport = classifyScope("", { zone: ["tools/changed-scope.mjs"] });
  assert.deepEqual(emptyReport.in_scope, []);
  assert.deepEqual(emptyReport.likely_creep, []);
  assert.deepEqual(emptyReport.new_deps, []);
  assert.deepEqual(emptyReport.api_renames, []);
  assert.deepEqual(emptyReport.config_edits, []);
  assert.equal(emptyReport.stats.files, 0);
  assert.equal(emptyReport.advisory, "keep");

  // Non-empty diff with empty/missing intent -> justify
  const diff = `diff --git a/tools/demo.mjs b/tools/demo.mjs
--- a/tools/demo.mjs
+++ b/tools/demo.mjs
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
`;
  const noIntentReport = classifyScope(diff, null);
  assert.deepEqual(noIntentReport.in_scope, []);
  assert.deepEqual(noIntentReport.likely_creep, ["tools/demo.mjs"]);
  assert.equal(noIntentReport.stats.files, 1);
  assert.equal(noIntentReport.advisory, "justify");
});
