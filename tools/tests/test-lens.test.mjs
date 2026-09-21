/**
 * test-lens.test.mjs — тесты суммаризатора вывода тестов (`tools/test-lens.mjs`).
 *
 * Покрывает:
 *   - node --test (spec reporter): счётчики ℹ-блока, имена упавших тестов, файл/строка
 *   - pytest: сводная строка + FAILED-строки с сообщением
 *   - cargo test: ok/FAILED-строки
 *   - rawSummary-фоллбэк для неизвестного вывода
 *   - смешанный вывод (текст + JSON + текст): балансировка скобок не глотает лишнее
 *   - код выхода CLI: 0 успех, 1 падение, 2 spawnError
 *   - parse из stdin и из файла; пустой ввод не падает
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  summarize,
  extractJsonObject,
  parseNodeTestOutput,
  parsePytestOutput,
  parseCargoTestOutput,
  classifyResult,
  runCommand,
} from "../test-lens.mjs";

const CLI = fileURLToPath(new URL("../test-lens.mjs", import.meta.url));

function runCli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf-8",
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const NODE_PASS = `✔ DEFAULT_MARKER is 'defer' (0.94ms)
✔ scanRepo ignores node_modules (18.1ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 93.87
`;

const NODE_FAIL = `✔ good one (1.27ms)
✖ bad one (0.94ms)
✖ also bad (0.10ms)
ℹ tests 3
ℹ suites 0
ℹ pass 1
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 93.87

✖ failing tests:

test at tools/tests/f.test.mjs:4:1
✖ bad one (0.9448ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  actual: 1
  expected: 2

test at tools/tests/f.test.mjs:5:1
✖ also bad (0.1089ms)
  Error: boom message
      at TestContext.<anonymous> (file:///D:/repo/tools/tests/f.test.mjs:5:32)
`;

const PYTEST = `============================= test session starts ==============================
collected 4 items

tests/test_x.py::test_ok PASSED                                          [ 25%]
tests/test_x.py::test_bad FAILED                                          [ 50%]
tests/test_x.py::test_skip SKIPPED                                        [ 75%]

=================================== FAILURES ===================================
_________________________________ test_bad ____________________________________
E   AssertionError: assert 1 == 2

=========================== short test summary info ============================
FAILED tests/test_x.py::test_bad - AssertionError: assert 1 == 2
========================= 1 failed, 2 passed, 1 skipped in 0.42s =========================
`;

const CARGO = `   Compiling foo v0.1.0
    Finished test [unoptimized + debuginfo] target(s) in 0.5s
     Running unittests src/lib.rs (target/debug/deps/foo-1234)

running 3 tests
test tests::adds ... ok
test tests::subtracts ... FAILED
test tests::multiplies ... ok

failures:

---- tests::subtracts stdout ----
thread 'tests::subtracts' panicked at src/lib.rs:42:5:
assertion failed

failures:
    tests::subtracts

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;

const RAW = `Starting build...
Error: cannot find module 'x'
Build finished
`;

/** Смешанный вывод: проза + посторонний JSON-лог + JSON-отчёт + проза (регресс на жадный regex). */
const MIXED_JSON = `{"level":"warn","message":"jest-haste-map: duplicate manual mock found"}
> jest --json
PASS src/a.test.js
{"numTotalTests":1,"numPassedTests":0,"numFailedTests":1,"testResults":[{"name":"src/a.test.js","assertionResults":[{"status":"failed","title":"adds","failureMessages":["Error: expected {} got {\\"a\\":1}"]}]}]}
Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
`;

const JEST_JSON = `{"numTotalTests":2,"numPassedTests":1,"numFailedTests":1,"testResults":[{"name":"src\\\\a.test.js","assertionResults":[{"status":"passed","title":"ok"},{"status":"failed","title":"adds","failureMessages":["Expected: 2\\nReceived: 3"]}]}]}`;

test("parseNodeTestOutput: counters come from the ℹ summary block", () => {
  const s = parseNodeTestOutput(NODE_PASS);
  assert.equal(s.total, 24);
  assert.equal(s.passed, 24);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.failures, []);
});

test("parseNodeTestOutput: failed tests carry name, file, line and message", () => {
  const s = parseNodeTestOutput(NODE_FAIL);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 2);
  assert.deepEqual(
    s.failures.map((f) => f.test),
    ["bad one", "also bad"],
  );
  assert.equal(s.failures[0].file, "tools/tests/f.test.mjs");
  assert.equal(s.failures[0].line, 4);
  assert.match(s.failures[0].message, /^AssertionError \[ERR_ASSERTION\]/);
  assert.equal(s.failures[1].line, 5);
  assert.equal(s.failures[1].message, "Error: boom message");
});

test("parseNodeTestOutput: returns null when there is no ℹ summary block", () => {
  assert.equal(parseNodeTestOutput(RAW), null);
});

test("summarize: node --test output wins over the rawSummary fallback", () => {
  const s = summarize(NODE_FAIL);
  assert.equal(s.rawSummary, undefined);
  assert.equal(s.total, 3);
  assert.equal(s.failed, 2);
  assert.equal(s.failures.length, 2);
});

test("summarize: node --test all-green output reports no failures", () => {
  const s = summarize(NODE_PASS);
  assert.equal(s.total, 24);
  assert.equal(s.passed, 24);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.failures, []);
});

test("parsePytestOutput: counts come from the summary line, names from FAILED lines", () => {
  const s = parsePytestOutput(PYTEST);
  assert.equal(s.total, 4);
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.failures, [
    { test: "tests/test_x.py::test_bad", message: "AssertionError: assert 1 == 2" },
  ]);
});

test("summarize: pytest output is detected", () => {
  const s = summarize(PYTEST);
  assert.equal(s.rawSummary, undefined);
  assert.equal(s.failed, 1);
  assert.equal(s.failures[0].test, "tests/test_x.py::test_bad");
});

test("parseCargoTestOutput: ok/FAILED test lines are counted", () => {
  const s = parseCargoTestOutput(CARGO);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failures, [{ test: "tests::subtracts", message: "Test failed" }]);
});

test("summarize: cargo output is detected", () => {
  const s = summarize(CARGO);
  assert.equal(s.rawSummary, undefined);
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 1);
});

test("summarize: unknown output falls back to rawSummary with failure-ish lines", () => {
  const s = summarize(RAW);
  assert.equal(s.rawSummary, true);
  assert.equal(s.totalCount, 4);
  assert.deepEqual(s.failures, [{ message: "Error: cannot find module 'x'" }]);
});

test("summarize: mixed prose+JSON output parses the JSON block, not the trailing prose", () => {
  const s = summarize(MIXED_JSON);
  assert.equal(s.rawSummary, undefined);
  assert.equal(s.total, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].test, "adds");
  assert.equal(s.failures[0].file, "src/a.test.js");
  assert.equal(s.failures[0].message, 'Error: expected {} got {"a":1}');
});

test("extractJsonObject: braces inside strings do not truncate the object", () => {
  const text = 'noise {"testResults":[{"name":"a}b","assertionResults":[]}]} tail';
  const obj = extractJsonObject(text, "testResults");
  assert.deepEqual(obj, { testResults: [{ name: "a}b", assertionResults: [] }] });
});

test("extractJsonObject: returns null when no balanced object carries the key", () => {
  assert.equal(extractJsonObject("{ not json", "testResults"), null);
  assert.equal(extractJsonObject("no json here at all", "testResults"), null);
});

test("summarize: pristine jest JSON still parses", () => {
  const s = summarize(JEST_JSON);
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.failures[0].test, "adds");
  assert.equal(s.failures[0].file, "src/a.test.js");
  assert.equal(s.failures[0].message, "Expected: 2");
});

test("summarize: empty input does not throw", () => {
  const s = summarize("");
  assert.equal(typeof s, "object");
  assert.ok(Array.isArray(s.failures));
});

test("runCommand: exit code mirrors the command, spawnError is reported", () => {
  const ok = runCommand([process.execPath, "-e", "process.exit(0)"]);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.summary.spawnError, undefined);

  const bad = runCommand([process.execPath, "-e", "process.exit(3)"]);
  assert.equal(bad.exitCode, 3);

  const missing = runCommand(["nonexistent-binary-xyz"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.summary.spawnError, /nonexistent-binary-xyz/);
});

test("runCommand: argv with spaces and parentheses reaches the command intact", () => {
  const res = runCommand([
    process.execPath,
    "-e",
    "process.exit(process.argv[1]==='a b' && process.argv.length===2 ? 0 : 7)",
    "a b",
  ]);
  assert.equal(res.exitCode, 0);
});

test("classifyResult: spawn error exits 2 with a spawnError mark", () => {
  const res = classifyResult(
    { error: Object.assign(new Error("spawn nonexistent ENOENT"), { code: "ENOENT" }), status: null, signal: null, stdout: "", stderr: "" },
    "nonexistent-binary-xyz",
  );
  assert.equal(res.exitCode, 2);
  assert.match(res.summary.spawnError, /nonexistent-binary-xyz/);
  assert.equal(res.summary.failed, 0);
  assert.match(res.stderr, /spawnError/);
});

test("classifyResult: signal death exits 1 with a signal mark, not a green zero", () => {
  const res = classifyResult({ status: null, signal: "SIGTERM", stdout: NODE_PASS, stderr: "" }, "node");
  assert.equal(res.exitCode, 1);
  assert.equal(res.summary.signal, "SIGTERM");
  assert.equal(res.summary.passed, 24);
  assert.match(res.stderr, /signal/);
});

test("CLI run: exit 0 on green command", () => {
  const res = runCli(["run", "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).spawnError, undefined);
});

test("CLI run: exit 1 on failing command", () => {
  const res = runCli(["run", "--", process.execPath, "-e", "process.exit(1)"]);
  assert.equal(res.status, 1);
});

test("CLI run: exit 2 and spawnError mark when the binary does not exist", () => {
  const res = runCli(["run", "--", "nonexistent-binary-xyz"]);
  assert.equal(res.status, 2);
  assert.ok(JSON.parse(res.stdout).spawnError);
  assert.match(res.stderr, /spawnError/);
});

test("CLI parse: reads stdin", () => {
  const res = runCli(["parse"], NODE_FAIL);
  assert.equal(res.status, 0);
  const s = JSON.parse(res.stdout);
  assert.equal(s.total, 3);
  assert.equal(s.failures[0].test, "bad one");
});

test("CLI parse: reads a file argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-lens-test-"));
  try {
    const file = join(dir, "out.txt");
    writeFileSync(file, NODE_PASS, "utf-8");
    const res = runCli(["parse", file]);
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).passed, 24);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI parse: empty stdin yields a summary, not a crash", () => {
  const res = runCli(["parse"], "");
  assert.equal(res.status, 0);
  assert.equal(typeof JSON.parse(res.stdout), "object");
});
