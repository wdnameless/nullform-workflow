/**
 * tools/tests/coverage-changed.test.mjs — Unit tests for coverage gate helpers.
 *
 * Validates report parsing and changed lines coverage intersection on fixtures.
 * NO live node --test runs in this suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUncoveredLines,
  parseCoverageReport,
  findFileCoverage,
  changedLinesCovered,
  parseCliArgs,
  filterCandidateFiles,
  resolveBaseRef,
  gitDiff,
  getChangedFiles,
  getChangedLines,
  findMatchingSuite,
  runFileCoverage,
} from "../coverage-changed.mjs";
import { runQualityCommand } from "../../bin/nullform.mjs";

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "cov-changed-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const FIXTURE_REPORT = `
ℹ start of coverage report
ℹ -----------------------------------------------------------------------------------------------------------------------------------------
ℹ file                    | line % | branch % | funcs % | uncovered lines
ℹ -----------------------------------------------------------------------------------------------------------------------------------------
ℹ bin                     |        |          |         | 
ℹ  nullform.mjs           |  79.06 |    64.99 |   76.60 | 70-71 75-84 98
ℹ tools                   |        |          |         | 
ℹ  brief-rounds.mjs       |  30.81 |   100.00 |    0.00 | 47-61 73-125
ℹ  installation           |        |          |         | 
ℹ   adapters.mjs          |  20.89 |   100.00 |    0.00 | 41-45 102
ℹ   capabilities.mjs      | 100.00 |   100.00 |  100.00 | 
ℹ  workflow.mjs           |  95.00 |    90.00 |   85.00 | 12 15-16
ℹ -----------------------------------------------------------------------------------------------------------------------------------------
ℹ all files               |  65.19 |    71.25 |   52.32 | 
ℹ -----------------------------------------------------------------------------------------------------------------------------------------
ℹ end of coverage report
`;

const FLAT_FIXTURE = `
file                 | line % | branch % | funcs % | uncovered lines
--------------------------------------------------------------------
tools/lead-time.mjs  |  85.00 |    75.00 |   90.00 | 20-22 45
tools/cfr-report.mjs |  50.00 |    40.00 |   60.00 | 10-15
--------------------------------------------------------------------
all files            |  67.50 |    57.50 |   75.00 | 
`;

test("parseUncoveredLines: handles ranges, singles, commas and empty values", () => {
  assert.deepEqual(parseUncoveredLines(""), []);
  assert.deepEqual(parseUncoveredLines("   "), []);
  assert.deepEqual(parseUncoveredLines(null), []);
  assert.deepEqual(parseUncoveredLines("98"), [98]);
  assert.deepEqual(parseUncoveredLines("70-72 98"), [70, 71, 72, 98]);
  assert.deepEqual(parseUncoveredLines("1-3, 5, 8-9"), [1, 2, 3, 5, 8, 9]);
});

test("parseCoverageReport: parses hierarchical coverage report and summary", () => {
  const report = parseCoverageReport(FIXTURE_REPORT);

  assert.equal(report.summary.linePercent, 65.19);
  assert.equal(report.summary.branchPercent, 71.25);
  assert.equal(report.summary.funcsPercent, 52.32);

  const nullform = report.files["bin/nullform.mjs"];
  assert.ok(nullform, "bin/nullform.mjs should exist");
  assert.equal(nullform.linePercent, 79.06);
  assert.equal(nullform.branchPercent, 64.99);
  assert.equal(nullform.funcsPercent, 76.6);
  assert.deepEqual(nullform.uncoveredRanges, ["70-71", "75-84", "98"]);
  assert.ok(nullform.uncoveredLines.includes(70));
  assert.ok(nullform.uncoveredLines.includes(71));
  assert.ok(nullform.uncoveredLines.includes(75));
  assert.ok(nullform.uncoveredLines.includes(84));
  assert.ok(nullform.uncoveredLines.includes(98));
  assert.ok(!nullform.uncoveredLines.includes(72));

  const adapters = report.files["tools/installation/adapters.mjs"];
  assert.ok(adapters, "tools/installation/adapters.mjs should exist");
  assert.equal(adapters.linePercent, 20.89);
  assert.deepEqual(adapters.uncoveredLines, [41, 42, 43, 44, 45, 102]);

  const capabilities = report.files["tools/installation/capabilities.mjs"];
  assert.ok(capabilities, "tools/installation/capabilities.mjs should exist");
  assert.equal(capabilities.linePercent, 100);
  assert.deepEqual(capabilities.uncoveredLines, []);

  const workflow = report.files["tools/workflow.mjs"];
  assert.ok(workflow, "tools/workflow.mjs should exist");
  assert.equal(workflow.linePercent, 95);
  assert.deepEqual(workflow.uncoveredLines, [12, 15, 16]);
});

test("parseCoverageReport: parses flat report and handles empty input", () => {
  const empty = parseCoverageReport("");
  assert.deepEqual(empty.files, {});
  assert.equal(empty.summary.linePercent, 0);

  const flat = parseCoverageReport(FLAT_FIXTURE);
  assert.ok(flat.files["tools/lead-time.mjs"]);
  assert.equal(flat.files["tools/lead-time.mjs"].linePercent, 85);
  assert.deepEqual(flat.files["tools/lead-time.mjs"].uncoveredLines, [20, 21, 22, 45]);
  assert.equal(flat.summary.linePercent, 67.5);
});

test("findFileCoverage: finds target by exact, relative, or normalized match", () => {
  const report = parseCoverageReport(FIXTURE_REPORT);

  assert.ok(findFileCoverage(report, "bin/nullform.mjs"));
  assert.ok(findFileCoverage(report, "./bin/nullform.mjs"));
  assert.ok(findFileCoverage(report, "bin\\nullform.mjs"));
  assert.ok(findFileCoverage(report, "nullform.mjs"));
  assert.ok(findFileCoverage(report, "tools/installation/adapters.mjs"));
  assert.equal(findFileCoverage(report, "nonexistent.mjs"), null);
});

test("changedLinesCovered: calculates covered changed lines ratio and percentage", () => {
  // 4 changed lines, 2 uncovered -> 2/4 = 50%
  const res50 = changedLinesCovered([12, 13], [10, 11, 12, 13]);
  assert.equal(res50.covered, 2);
  assert.equal(res50.total, 4);
  assert.equal(res50.percent, 50);
  assert.deepEqual(res50.coveredLines, [10, 11]);
  assert.deepEqual(res50.uncoveredLines, [12, 13]);
  assert.ok(res50 >= 50);
  assert.ok(!(res50 > 50));

  // 4 changed lines, 1 uncovered -> 3/4 = 75%
  const res75 = changedLinesCovered([10], [10, 11, 12, 13]);
  assert.equal(res75.covered, 3);
  assert.equal(res75.total, 4);
  assert.equal(res75.percent, 75);
  assert.ok(res75 >= 50);

  // 2 changed lines, 2 uncovered -> 0/2 = 0%
  const res0 = changedLinesCovered([1, 2], [1, 2]);
  assert.equal(res0.covered, 0);
  assert.equal(res0.total, 2);
  assert.equal(res0.percent, 0);
  assert.ok(!(res0 >= 50));

  // 0 changed lines -> 100%
  const resEmpty = changedLinesCovered([5, 6], []);
  assert.equal(resEmpty.percent, 100);
  assert.equal(resEmpty.total, 0);

  // Accepts Set, string ranges, and object
  const resSet = changedLinesCovered(new Set([10, 11]), [10, 12]);
  assert.equal(resSet.percent, 50);

  const resStr = changedLinesCovered("10-11", [10, 12]);
  assert.equal(resStr.percent, 50);

  const resObj = changedLinesCovered({ uncoveredLines: [10, 11] }, [10, 12]);
  assert.equal(resObj.percent, 50);
});

test("parseCliArgs: provides correct defaults and parses overrides", () => {
  const def = parseCliArgs([]);
  assert.equal(def.threshold, 50);
  assert.equal(def.maxFiles, 10);
  assert.equal(def.head, "HEAD");
  assert.equal(def.dryRun, false);
  assert.equal(def.base, null);
  assert.equal(def.root, null);
  assert.equal(def.suites, "tools/tests");

  const withRootSuites = parseCliArgs(["--root", "/custom/path", "--suites", "custom/tests"]);
  assert.equal(withRootSuites.root, "/custom/path");
  assert.equal(withRootSuites.suites, "custom/tests");
  const custom = parseCliArgs([
    "--base",
    "origin/main",
    "--threshold",
    "80",
    "--max-files",
    "5",
    "--dry-run",
    "--files",
    "tools/a.mjs,tools/b.mjs",
  ]);
  assert.equal(custom.base, "origin/main");
  assert.equal(custom.threshold, 80);
  assert.equal(custom.maxFiles, 5);
  assert.equal(custom.dryRun, true);
  assert.equal(custom.files, "tools/a.mjs,tools/b.mjs");
  // non-strict: unknown flags pass through (kills strict:false→true, which throws)
  const lax = parseCliArgs(["--no-such-flag", "x"]);
  assert.equal(lax.threshold, 50);
});

test("parseCoverageReport: null/non-string/empty-name guards", () => {
  const empty = parseCoverageReport(null);
  assert.deepEqual(empty.files, {});
  const num = parseCoverageReport(42);
  assert.deepEqual(num.files, {});
  // header + blank-name rows skipped (kills ||→&& on empty-name guard)
  const rep = parseCoverageReport("file | line % | branch % | funcs % | uncovered\n   | 1 | 2 | 3 | 4\n");
  assert.deepEqual(rep.files, {});
});
test("filterCandidateFiles: filters out test files and non-mjs files", () => {
  const files = [
    "tools/coverage-changed.mjs",
    "tools/tests/coverage-changed.test.mjs",
    "README.md",
    "package.json",
  ];
  const candidates = filterCandidateFiles(process.cwd(), files);
  assert.deepEqual(candidates, ["tools/coverage-changed.mjs"]);
});

test("git helpers: resolveBaseRef/getChangedFiles/getChangedLines on temp repo", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "tools", "tests"), { recursive: true });
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\nexport const b = 2;\n");
    assert.equal(resolveBaseRef(root, "HEAD"), "HEAD");
    assert.deepEqual(getChangedFiles(root, "HEAD", "HEAD"), ["tools/a.mjs"]);
    assert.deepEqual(getChangedLines(root, "HEAD", "HEAD", "tools/a.mjs"), [2]);
    assert.ok(gitDiff(root, ["--name-only", "HEAD"]) !== null);
  } finally {
    cleanup();
  }
});

test("findMatchingSuite: resolves direct and stripped candidates", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "tools", "tests"), { recursive: true });
    writeFileSync(join(root, "tools", "a.mjs"), "export const a = 1;\n");
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

test("runFileCoverage: handles foreign tree without tools/tests directory", () => {
  const { root, git, cleanup } = makeGitRepo();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "sample.mjs"), "export const hello = 'world';\n");
    git("add", "-A");
    git("commit", "-qm", "foreign project init");

    const verdict = runFileCoverage(root, "src/sample.mjs", { threshold: 50, head: "HEAD", suites: "tests" }, null);
    assert.ok(verdict);
    assert.equal(verdict.target, "src/sample.mjs");
    assert.ok(typeof verdict.passed === "boolean");
  } finally {
    cleanup();
  }
});

test("runQualityCommand: passthrough to code-size exits 0 on --help", async () => {
  let stdoutData = "";
  const mockStdout = {
    write(chunk) {
      stdoutData += chunk;
      return true;
    },
  };
  const code = await runQualityCommand(["code-size", "--help"], { stdout: mockStdout });
  assert.equal(code, 0);
  assert.ok(stdoutData.includes("code-size"));
});
