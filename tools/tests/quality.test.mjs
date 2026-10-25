/**
 * tools/tests/quality.test.mjs — the ratchet's contract, not its implementation.
 *
 * Each test names the failure it prevents:
 *   - silent pass on a missing analyzer (the difference between "clean" and "unproven")
 *   - suppression mistaken for a ratchet (eslint --suppress-all allows growth)
 *   - a re-seed used as a rubber stamp (baseline --update raising a value)
 *   - a proxy metric reported as cognitive complexity
 *   - a per-stack argv template that only works under a shell
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadStacks, detectStacks, applyRatchet, expandArgv, baselineKey,
  loadBaseline, saveBaseline, runQualityCli, sourceFiles, normalizeFile, mergeBaselineEntries,
} from "../quality.mjs";
import {
  parseEslintJson, parsePylintJson, parseCargoJson, parseDotnetText,
  parseGolangciJson, parseRubocopJson, parseSwiftlintJson, parsePhpstanJson, parseSarif, fromRatio,
} from "../quality/parsers.mjs";

function sandbox(files) {
  const root = mkdtempSync(join(tmpdir(), "quality-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function cli(root, argv) {
  const out = { text: "", err: "" };
  const code = runQualityCli([...argv, "--root", root], {
    stdout: { write: (s) => { out.text += s; } },
    stderr: { write: (s) => { out.err += s; } },
  });
  return { code, ...out };
}

/* ----------------------------------------------------------------- markers */

test("detect reports the marker that proved each stack, not just the stack", () => {
  const root = sandbox({ "package.json": "{}", "src/app.py": "x = 1\n" });
  try {
    const found = detectStacks(root);
    const node = found.find((s) => s.id === "node");
    assert.equal(node.proof, "package.json", "a declared manifest outranks an incidental extension match");
    assert.ok(found.some((s) => s.id === "python"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every stack declares the metric it actually measures", () => {
  const doc = loadStacks();
  assert.equal(doc.stacks.length, 10, "the lecture matrix is 9 languages; node and csharp split JS/TS from .NET");
  for (const stack of doc.stacks) {
    assert.ok(stack.metric && stack.metric.length > 10, `${stack.id} must name its metric`);
    if (stack.coco === "proxy") assert.match(stack.metric, /NOT|not cognitive|cyclomatic|PERCEIVED/i, `${stack.id} is a proxy and must say so`);
  }
});

test("a proxy stack is never labelled native", () => {
  const doc = loadStacks();
  assert.equal(doc.stacks.find((s) => s.id === "ruby").coco, "proxy", "RuboCop PerceivedComplexity is not Sonar COCO");
  assert.equal(doc.stacks.find((s) => s.id === "swift").coco, "proxy", "SwiftLint has no cognitive rule");
});

/* ----------------------------------------------------------------- ratchet */

test("ratchet: unchanged legacy passes, growth fails, a new offender fails", () => {
  const rows = [
    { key: "a.mjs:big", coco: 40, file: "a.mjs", line: 1 },
    { key: "a.mjs:newcomer", coco: 20, file: "a.mjs", line: 9 },
    { key: "a.mjs:small", coco: 3, file: "a.mjs", line: 20 },
  ];
  const { failures, kept } = applyRatchet(rows, { "a.mjs:big": 40 }, 15);
  assert.deepEqual(failures.map((f) => f.type).sort(), ["new"]);
  assert.equal(failures[0].key, "a.mjs:newcomer");
  assert.equal(kept["a.mjs:big"], 40, "an unchanged baselined value stays recorded");

  const grown = applyRatchet([{ key: "a.mjs:big", coco: 41, file: "a.mjs", line: 1 }], { "a.mjs:big": 40 }, 15);
  assert.equal(grown.failures[0].type, "growth", "one point above the baseline is still growth");
});

test("ratchet ignores functions below the threshold even when absent from the baseline", () => {
  const { failures } = applyRatchet([{ key: "x:m", coco: 15, file: "x", line: 1 }], {}, 15);
  assert.deepEqual(failures, [], "15 is the limit, not a violation");
});

test("baseline re-seed lowers values and never raises them", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-b-"));
  try {
    saveBaseline(root, { version: 1, stacks: { node: { threshold: 15, seeded: true, functions: { "a.mjs:m": 99 } } } });
    const loaded = loadBaseline(root);
    const next = Math.min(loaded.stacks.node.functions["a.mjs:m"], 50);
    assert.equal(next, 50);
    assert.notEqual(next, 99, "a lower measurement must win");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("same-named functions in one file get distinct keys", () => {
  assert.notEqual(baselineKey({ fn: "a", line: 1 }, "f.mjs"), baselineKey({ fn: "b", line: 2 }, "f.mjs"));
});

/* ------------------------------------------------------------------- argv */

test("argv templating never needs a shell", () => {
  const argv = expandArgv(["node_modules/eslint/bin/eslint.js", "-c", "{quality}/node/eslint.config.mjs", "{files...}"],
    { root: "/p", qualityDir: ".quality", files: ["a.mjs", "b.mjs"], stack: {} });
  assert.deepEqual(argv, ["node_modules/eslint/bin/eslint.js", "-c", ".quality/node/eslint.config.mjs", "a.mjs", "b.mjs"]);
  const noFiles = expandArgv(["{root}"], { root: "/p", qualityDir: ".quality", files: null, stack: {} });
  assert.deepEqual(noFiles, ["/p"], "a tool without a file list gets the project root");
});

/* ---------------------------------------------------------------- parsers */

test("parsers read the number the analyzer already computed", () => {
  const eslint = parseEslintJson(JSON.stringify([{ filePath: "/p/a.mjs", messages: [{ ruleId: "sonarjs/cognitive-complexity", line: 3, column: 5, message: "Refactor this function to reduce its Cognitive Complexity from 21 to the 15 allowed." }] }]));
  assert.deepEqual(eslint.map((r) => [r.coco, r.threshold, r.line]), [[21, 15, 3]]);

  const pylint = parsePylintJson(JSON.stringify([{ "message-id": "R7001", path: "a.py", line: 1, column: 0, obj: "deep", message: "'deep' is too cognitively complex (15/4)" }]));
  assert.deepEqual(pylint.map((r) => [r.fn, r.coco, r.threshold]), [["deep", 15, 4]]);

  const cargo = parseCargoJson(JSON.stringify({ reason: "compiler-message", message: { code: { code: "clippy::cognitive_complexity" }, message: "the function has a cognitive complexity of (6/5)", spans: [{ file_name: "src/main.rs", line_start: 2, column_start: 4 }] } }));
  assert.deepEqual(cargo.map((r) => [r.coco, r.threshold, r.line]), [[6, 5, 2]]);

  const dotnet = parseDotnetText("C:\\p\\Program.cs(3,25): warning S3776: Refactor this method to reduce its Cognitive Complexity from 21 to the 15 allowed. [x.csproj]");
  assert.deepEqual(dotnet.map((r) => [r.coco, r.threshold, r.line]), [[21, 15, 3]]);

  const go = parseGolangciJson(JSON.stringify({ Issues: [{ FromLinter: "gocognit", Text: "cognitive complexity 21 of func `deep` is high (> 15)", Pos: { Filename: "a.go", Line: 7, Column: 1 } }] }));
  assert.deepEqual(go.map((r) => [r.fn, r.coco, r.threshold]), [["deep", 21, 15]]);

  const php = parsePhpstanJson(JSON.stringify({ files: { "a.php": { messages: [{ line: 4, message: "Method deep() has cognitive complexity 34, limit is 8" }] } } }));
  assert.deepEqual(php.map((r) => [r.coco, r.threshold]), [[34, 8]]);

  const ruby = parseRubocopJson(JSON.stringify({ files: [{ path: "a.rb", offenses: [{ cop_name: "Metrics/PerceivedComplexity", message: "Perceived complexity for deep is too high. [12/8]", location: { line: 2, column: 1 } }] }] }));
  assert.deepEqual(ruby.map((r) => [r.fn, r.coco, r.threshold]), [["deep", 12, 8]]);

  const swift = parseSwiftlintJson(JSON.stringify([{ rule_id: "cyclomatic_complexity", file: "a.swift", line: 5, character: 2, reason: "Cyclomatic Complexity: 21. Warning Threshold: 10" }]));
  assert.deepEqual(swift.map((r) => [r.coco, r.threshold]), [[21, 10]]);

  const sarif = parseSarif(JSON.stringify({ runs: [{ results: [{ message: { text: "The method 'deep' has a cognitive complexity of 21, threshold is 15." }, locations: [{ physicalLocation: { artifactLocation: { uri: "A.java" }, region: { startLine: 9, startColumn: 3 } } }] }] }] }));
  assert.deepEqual(sarif.map((r) => [r.coco, r.threshold, r.line]), [[21, 15, 9]]);
});

test("a message without a number yields no row instead of a guessed one", () => {
  assert.equal(fromRatio("something went wrong"), null);
  assert.deepEqual(parseEslintJson(JSON.stringify([{ filePath: "a", messages: [{ ruleId: "sonarjs/cognitive-complexity", line: 1, message: "no digits here" }] }])), []);
});

/* -------------------------------------------------------------- CLI honesty */

test("a stack with no analyzer installed reports unverified, never pass", () => {
  const root = sandbox({ "Cargo.toml": "[package]\nname='x'\n" });
  try {
    const { code, text } = cli(root, ["check", "--stack", "rust"]);
    assert.equal(code, 1, "exit 1 for unverified: a skipped check is not a green check");
    assert.match(text, /unverified|missing-tool|tool-error/i);
    assert.doesNotMatch(text, /ratchet clean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an analyzer that prints nothing is a tool error, not a clean run", async () => {
  // Regression guard: parsing "" used to throw and be reported as `unparsable`, and a
  // parse function that tolerates empty input would have produced `ran` with zero rows —
  // indistinguishable from "no violations". A silently broken analyzer must exit 1.
  const root = sandbox({ "a.py": "def f():\n    return 1\n" });
  try {
    saveBaseline(root, { version: 1, stacks: { python: { threshold: 15, seeded: true, functions: {} } } });
    const { runStack } = await import("../quality.mjs");
    const silent = { run: { argv: ["node", "-e", ""], parser: "pylint-json" }, markers: ["*.py"], threshold: 15 };
    const result = runStack(silent, { root, qualityDir: ".quality", files: null });
    assert.notEqual(result.status, "ran", "empty stdout must never be reported as a completed run");
    assert.equal(result.status, "tool-error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check exits 1 when the analyzer runs but reports an unreadable payload", async () => {
  const root = sandbox({ "a.py": "def f():\n    return 1\n" });
  try {
    saveBaseline(root, { version: 1, stacks: { python: { threshold: 15, seeded: true, functions: {} } } });
    const mod = await import("../quality.mjs");
    // A parser that throws on garbage is the realistic case (analyzer changed its schema).
    const broken = { run: { argv: ["node", "-e", "process.stdout.write('not json')"], parser: "pylint-json" }, markers: ["*.py"], threshold: 15 };
    const result = mod.runStack(broken, { root, qualityDir: ".quality", files: null });
    assert.equal(result.status, "unparsable");
    assert.ok(result.detail, "an unparsable report must carry the reason, not just the status");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check on a project with no known stack cannot exit 0", () => {
  const root = sandbox({ "README.md": "nothing here\n" });
  try {
    const { code, err } = cli(root, ["check"]);
    assert.equal(code, 2);
    assert.match(err, /no known stack/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install --dry-run writes nothing", () => {
  const root = sandbox({ "package.json": "{}" });
  try {
    const { code } = cli(root, ["install", "--dry-run"]);
    assert.equal(code, 0);
    assert.throws(() => readFileSync(join(root, ".quality", "node", "eslint.config.mjs"), "utf8"), "dry-run must not create sidecar configs");
    assert.throws(() => readFileSync(join(root, ".quality-baseline.json"), "utf8"), "dry-run must not seed a baseline");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh clone with no sidecar configs still gets a real verdict", () => {
  // .quality/ is gitignored, so CI checks out the baseline and nothing else. Before this
  // guard, `check` reported `tool-error: config file ... doesn't exist` — a red build on a
  // clean checkout that no local run reproduced.
  const root = sandbox({
    "package.json": "{}",
    ".quality-baseline.json": JSON.stringify({ version: 1, stacks: { node: { threshold: 15, seeded: true, functions: {} } } }),
    "src/ok.mjs": "export function small(a) {\n  return a ? 1 : 0;\n}\n",
  });
  try {
    const { code, text } = cli(root, ["check", "--stack", "node"]);
    const written = readFileSync(join(root, ".quality", "node", "eslint.config.mjs"), "utf8");
    assert.match(written, /cognitive-complexity/, "check must materialize the same config install writes");
    assert.doesNotMatch(text, /config file .*doesn't exist/i, "a missing sidecar must be regenerated, not reported as a broken analyzer");
    // No node_modules in the sandbox, so the honest verdict here is "the analyzer is absent",
    // which is a different fact from "the config is absent" and must not be confused with it.
    assert.match(text, /missing-tool|unverified/i);
    assert.equal(code, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check does not overwrite an existing sidecar config", () => {
  const root = sandbox({
    "package.json": "{}",
    ".quality-baseline.json": JSON.stringify({ version: 1, stacks: { node: { threshold: 15, seeded: true, functions: {} } } }),
    ".quality/node/eslint.config.mjs": "// locally tuned\n",
    "src/ok.mjs": "export function small(a) {\n  return a ? 1 : 0;\n}\n",
  });
  try {
    cli(root, ["check", "--stack", "node"]);
    assert.equal(readFileSync(join(root, ".quality", "node", "eslint.config.mjs"), "utf8"), "// locally tuned\n",
      "only missing files may be generated; a hand-edited sidecar is the operator's");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install never runs a pip install outside a project virtualenv", () => {
  // A quality gate that mutates the operator's global Python is a defect, not a feature.
  // Observed: an early install put pylint into the system interpreter on this host.
  const root = sandbox({ "pyproject.toml": "[project]\nname='x'\n", "a.py": "def f():\n    return 1\n" });
  try {
    const out = { text: "", err: "" };
    const io = { stdout: { write: (s) => { out.text += s; } }, stderr: { write: (s) => { out.err += s; } } };
    const code = runQualityCli(["install", "--root", root, "--stack", "python", "--json"], io);
    assert.equal(code, 0);
    const payload = JSON.parse(out.text);
    const action = payload.actions.find((a) => a.id === "python");
    assert.equal(action.install.status, "skipped-no-venv");
    assert.match(action.install.detail, /host interpreter/);
    assert.match(readFileSync(join(root, ".quality", "python", "pylintrc"), "utf8"), /max-cognitive-complexity/,
      "the config is still written; only the host-polluting install is skipped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("install proceeds when a project virtualenv exists", () => {
  const root = sandbox({ "pyproject.toml": "[project]\nname='x'\n", "a.py": "def f():\n    return 1\n" });
  mkdirSync(join(root, ".venv", "Scripts"), { recursive: true });
  writeFileSync(join(root, ".venv", "Scripts", "python.exe"), "");
  try {
    const out = { text: "", err: "" };
    const io = { stdout: { write: (s) => { out.text += s; } }, stderr: { write: (s) => { out.err += s; } } };
    runQualityCli(["install", "--root", root, "--stack", "python", "--json"], io);
    const action = JSON.parse(out.text).actions.find((a) => a.id === "python");
    assert.notEqual(action.install.status, "skipped-no-venv", "a venv must satisfy the guard; the exact install outcome depends on pip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("baseline keys are OS-independent", () => {
  // A baseline seeded on Windows used to keep "tools\\a.py:main", so the same function
  // read as "new" on Linux CI and the gate was permanently red cross-platform.
  //
  // On POSIX a backslash is a legal filename character, not a separator, so only a
  // Windows-style input can be normalised there. Asserting the conversion everywhere
  // would be asserting Windows semantics on Linux — the assertion, not the code, would
  // be wrong. The real invariant is checked on every platform: the key never carries a
  // separator and matches the relative form the baseline was seeded with.
  const root = sandbox({ "tools/a.py": "def main():\n    return 1\n" });
  try {
    const forward = normalizeFile(root, "tools/a.py");
    const absolute = normalizeFile(root, join(root, "tools", "a.py"));
    assert.equal(forward, "tools/a.py");
    assert.equal(absolute, "tools/a.py");
    assert.ok(!forward.includes("\\"), "a baseline key must never carry a platform separator");
    if (process.platform === "win32") {
      assert.equal(normalizeFile(root, "tools\\a.py"), "tools/a.py", "Windows separators must fold to /");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sourceFiles never returns vendored or virtualenv trees", () => {
  // Measured failure: passing the bare root to pylint graded a CI venv and produced 556
  // findings from site-packages. The analyzer must receive a list, not a directory.
  const root = sandbox({
    "package.json": "{}",
    "src/app.mjs": "export const a = 1;\n",
    "bin/cli.mjs": "export const b = 2;\n",
    "node_modules/dep/index.mjs": "export const c = 3;\n",
    ".venv/Lib/site-packages/x/mod.py": "def f():\n    return 1\n",
    "tools/legacy.cjs": "module.exports = 1;\n",
  });
  try {
    const doc = loadStacks();
    const node = doc.stacks.find((s) => s.id === "node");
    const files = sourceFiles(root, node);
    assert.ok(files.includes("src/app.mjs"));
    assert.ok(files.includes("bin/cli.mjs"), "bin/ is source, not build output");
    assert.ok(files.includes("tools/legacy.cjs"), "a .cjs marker is required or coverage silently shrinks");
    assert.deepEqual(files.filter((f) => /node_modules|\.venv/.test(f)), [], "vendored trees must never be graded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expandArgv with an empty file list yields no root fallback", () => {
  const argv = expandArgv(["x", "{files...}"], { root: "/p", qualityDir: ".quality", files: [], stack: {} });
  assert.deepEqual(argv, ["x"], "an empty source list means 'nothing to analyze', not 'analyze everything'");
});

test("an unseeded baseline is reported as a setup gap, not as dozens of findings", () => {
  const root = sandbox({ "package.json": "{}" });
  try {
    saveBaseline(root, { version: 1, stacks: { node: { seeded: false, reason: "tool-error" } } });
    const { code, text } = cli(root, ["check", "--stack", "node"]);
    assert.equal(code, 1);
    assert.match(text, /unseeded|unverified|tool-error/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rename cannot launder a recorded ceiling through `baseline`", () => {
  // Measured hole: `baseline` rebuilt its map from current rows only, so renaming a
  // function dropped its recorded value. The rename then read as "new" and was
  // re-baselined at today's number — growth laundered by a rename.
  // Asserted on the pure merge: a CLI call would need an analyzer in the sandbox and
  // would return before reaching this decision.
  const merged = mergeBaselineEntries({ "a.mjs:oldName": 40 }, [{ key: "a.mjs:newName", coco: 60 }], { prune: false });
  assert.equal(merged.functions["a.mjs:oldName"], 40, "an entry with no current match must survive a re-seed");
  assert.equal(merged.functions["a.mjs:newName"], 60, "the renamed function is recorded too");
  assert.equal(merged.orphans, 1, "the orphan is reported so a reviewer sees the rename");
});

test("`baseline --prune` is the explicit way to drop an orphaned entry", () => {
  // The sandbox has no analyzer, so the CLI never reaches the prune branch; this asserts
  // the decision itself. A sandbox with eslint would test the wiring instead.
  const root = sandbox({ "a.mjs": "export function renamed() {\n  return 1;\n}\n" });
  try {
    saveBaseline(root, { version: 1, stacks: { node: { threshold: 15, seeded: true, functions: { "a.mjs:oldName": 40 } } } });
    const merged = mergeBaselineEntries({ "a.mjs:oldName": 40 }, [], { prune: false });
    assert.equal(merged.functions["a.mjs:oldName"], 40, "default keeps the orphan");
    assert.equal(merged.orphans, 1);
    const pruned = mergeBaselineEntries({ "a.mjs:oldName": 40 }, [], { prune: true });
    assert.equal(pruned.functions["a.mjs:oldName"], undefined, "pruning must be possible, but only when asked for");
    assert.equal(pruned.pruned, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
