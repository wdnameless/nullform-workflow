#!/usr/bin/env node
/**
 * tools/coverage-changed.mjs — CI Coverage Gate wrapper for changed files.
 *
 * Computes changed *.mjs files vs base ref, matches each file to its unit test suite,
 * runs `node --test --experimental-test-coverage <suite>`, parses coverage report,
 * and checks that changed lines meet the minimum coverage threshold (default: 50%).
 * Exits 0 fast when no files changed.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateMutants } from "./mutation-test.mjs";
import { gitRevParse, resolveBaseRef, gitDiff, getChangedFiles, getChangedLines, findMatchingSuite, filterCandidateFiles } from "./changed-scope.mjs";
export { gitRevParse, resolveBaseRef, gitDiff, getChangedFiles, getChangedLines, findMatchingSuite, filterCandidateFiles };

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      "max-files": { type: "string", default: "10" },
      threshold: { type: "string", default: "50" },
      "dry-run": { type: "boolean", default: false },
      files: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  return {
    base: values.base ?? null,
    head: values.head ?? "HEAD",
    maxFiles: Number(values["max-files"] ?? 10),
    threshold: Number(values.threshold ?? 50),
    dryRun: Boolean(values["dry-run"]),
    files: values.files ?? null,
    help: Boolean(values.help),
  };
}


export function parseUncoveredLines(str) {
  if (!str || !str.trim()) return [];
  const parts = str.trim().split(/[\s,]+/);
  const lines = [];
  for (const part of parts) {
    if (!part) continue;
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        lines.push(i);
      }
    } else {
      const num = Number.parseInt(part, 10);
      if (!Number.isNaN(num)) {
        lines.push(num);
      }
    }
  }
  return lines;
}

function splitRow(rawLine) {
  if (!rawLine.includes("|")) return null;
  const parts = rawLine.replace(/^(?:ℹ|\u2139\uFE0F|\u2139)?\s?/, "").split("|");
  if (parts.length < 4) return null;
  const m = parts[0].match(/^(\s*)(.*)$/);
  return { indent: m ? m[1].length : 0, name: m ? m[2].trim() : "",
    cols: parts.slice(1, 4).map((c) => c.trim()), rest: parts.slice(4).join("|").trim() };
}

function popToIndent(stack, indent) {
  while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
}

function applyRow(result, stack, row) {
  const { indent, name, cols, rest } = row;
  if (!name || name.toLowerCase() === "file") return;
  const pct = (c) => Number.parseFloat(c.replace(/%$/, "").trim()) || 0;
  if (name.toLowerCase() === "all files") {
    result.summary = { linePercent: pct(cols[0]), branchPercent: pct(cols[1]), funcsPercent: pct(cols[2]) };
    return;
  }
  const col1Num = cols[0].replace(/%$/, "").trim();
  popToIndent(stack, indent);
  if (!/^\d+(\.\d+)?$/.test(col1Num)) { stack.push({ indent, name }); return; }
  const fullPath = stack.length > 0 ? `${stack.map((d) => d.name).join("/")}/${name}` : name;
  result.files[fullPath] = { file: fullPath, linePercent: pct(cols[0]),
    branchPercent: pct(cols[1]), funcsPercent: pct(cols[2]),
    uncoveredLines: parseUncoveredLines(rest),
    uncoveredRanges: rest ? rest.split(/[\s,]+/).filter(Boolean) : [] };
}

export function parseCoverageReport(text) {
  const result = { files: {}, summary: { linePercent: 0, branchPercent: 0, funcsPercent: 0 } };
  if (!text || typeof text !== "string") return result;
  const stack = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const row = splitRow(rawLine);
    if (row) applyRow(result, stack, row);
  }
  return result;
}

export function findFileCoverage(report, target) {
  if (!report || !report.files) return null;
  const normTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (report.files[normTarget]) return report.files[normTarget];
  for (const [key, val] of Object.entries(report.files)) {
    const normKey = key.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normKey === normTarget || normKey.endsWith("/" + normTarget) || normTarget.endsWith("/" + normKey)) {
      return val;
    }
  }
  return null;
}

function coverageStats(covered, total, coveredLines, uncoveredLines) {
  const percent = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
  return {
    covered,
    total,
    percent,
    coveredLines,
    uncoveredLines,
    valueOf() { return this.percent; },
    [Symbol.toPrimitive](hint) { return hint === "number" ? this.percent : `${this.percent}%`; },
  };
}

function toUncoveredSet(uncovered) {
  if (uncovered instanceof Set) return uncovered;
  if (Array.isArray(uncovered)) {
    const ranged = uncovered.length > 0 && typeof uncovered[0] === "string" && uncovered[0].includes("-");
    return new Set(ranged ? parseUncoveredLines(uncovered.join(" ")) : uncovered);
  }
  if (typeof uncovered === "string") return new Set(parseUncoveredLines(uncovered));
  if (uncovered && typeof uncovered === "object") {
    const list = uncovered.uncoveredLines || uncovered.uncovered || [];
    return new Set(Array.isArray(list) ? list : parseUncoveredLines(String(list)));
  }
  return new Set();
}

export function changedLinesCovered(uncovered, changedLines = []) {
  const uncoveredSet = toUncoveredSet(uncovered);

  const lines = Array.isArray(changedLines) ? changedLines : Array.from(changedLines || []);
  const total = lines.length;
  if (total === 0) return coverageStats(0, 0, [], []);

  const uncoveredList = [];
  const coveredList = [];
  for (const line of lines) {
    if (uncoveredSet.has(line)) {
      uncoveredList.push(line);
    } else {
      coveredList.push(line);
    }
  }

  const covered = coveredList.length;
  return coverageStats(covered, total, coveredList, uncoveredList);
}

export function mutantsOnLines(root, target, changedLines) {
  try {
    return mutantsOnLinesSync(root, target, changedLines);
  } catch {
    return -1;
  }
}

function mutantsOnLinesSync(root, target, changedLines) {
  const source = readFileSync(join(root, target), "utf8");
  return generateMutants(source, { maxMutants: 1, onlyLines: changedLines }).length;
}

export function runFileCoverage(root, target, flags, baseRef) {
  const suite = findMatchingSuite(root, target);
  const changedLines = baseRef
    ? getChangedLines(root, baseRef, flags.head, target) || []
    : [];

  if (!suite) {
    if (changedLines.length === 0) {
      console.log(`coverage-changed: ${target} has no matching suite, but 0 changed lines. PASS.`);
      return { passed: true, percent: 100, target, stats: { covered: 0, total: 0, percent: 100 } };
    }
    // Дельта без исполняемого кода (импорты/реэкспорты/комментарии): мутатору нечего
    // ломать — покрытие неприменимо. Явный PASS с причиной, не молчаливый пропуск.
    const mutants = mutantsOnLines(root, target, changedLines);
    if (mutants === 0) {
      console.log(`coverage-changed: ${target} changed lines hold no mutable code (imports/re-exports). PASS (n/a).`);
      return { passed: true, percent: 100, target, stats: { covered: 0, total: 0, percent: 100 }, naReason: "no mutable code" };
    }
    console.error(`coverage-changed: no matching test suite found for ${target} (${changedLines.length} changed lines).`);
    return { passed: false, percent: 0, target, reason: "no matching test suite found" };
  }

  console.log(`\n>>> Running coverage for ${target} via suite ${suite}`);
  const res = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", suite], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  const output = (res.stdout || "") + "\n" + (res.stderr || "");
  const report = parseCoverageReport(output);
  const fileCov = findFileCoverage(report, target);

  if (!fileCov) {
    if (changedLines.length === 0) {
      return { passed: true, percent: 100, target, stats: { covered: 0, total: 0, percent: 100 } };
    }
    console.error(`coverage-changed: ${target} not reported in coverage output for suite ${suite}.`);
    return { passed: false, percent: 0, target, reason: "file not loaded in test suite" };
  }

  if (changedLines.length === 0) {
    console.log(`coverage-changed: ${target} — no changed lines to evaluate (file line%: ${fileCov.linePercent}%). PASS.`);
    return { passed: true, percent: 100, target, stats: { covered: 0, total: 0, percent: 100 } };
  }

  const stats = changedLinesCovered(fileCov.uncoveredLines, changedLines);
  const passed = stats.percent >= flags.threshold;

  console.log(
    `coverage-changed: ${target} — changed lines covered: ${stats.percent}% (${stats.covered}/${stats.total} lines, threshold: ${flags.threshold}%)`
  );
  if (!passed) {
    console.error(`  FAIL: ${target} — changed lines coverage ${stats.percent}% < ${flags.threshold}% threshold.`);
    if (stats.uncoveredLines.length > 0) {
      console.error(`  Uncovered changed lines: ${stats.uncoveredLines.join(", ")}`);
    }
  }

  return { passed, percent: stats.percent, target, stats };
}

function collectRawFiles(flags) {
  if (flags.files) {
    return { rawFiles: flags.files.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      baseRef: flags.base ? resolveBaseRef(ROOT, flags.base) : null };
  }
  const baseRef = resolveBaseRef(ROOT, flags.base);
  if (!baseRef) {
    console.log("coverage-changed: no base ref resolvable; skipping coverage gate.");
    process.exit(0);
  }
  console.log(`coverage-changed: computing changed files vs ${baseRef}...${flags.head}`);
  const diff = getChangedFiles(ROOT, baseRef, flags.head);
  if (diff === null) {
    console.log("coverage-changed: git diff failed or unavailable; skipping coverage gate.");
    process.exit(0);
  }
  return { rawFiles: diff, baseRef };
}

function capTargets(candidateFiles, maxFiles) {
  if (candidateFiles.length <= maxFiles) return candidateFiles;
  console.log(`coverage-changed: runtime ceiling reached — capping to first ${maxFiles} of ${candidateFiles.length} files.`);
  return candidateFiles.slice(0, maxFiles);
}

function reportAggregate(targets, passedFiles, failedFiles, threshold) {
  console.log("\n============================================================");
  console.log("                COVERAGE GATE AGGREGATE RESULT              ");
  console.log("============================================================");
  console.log(`Passed files: ${passedFiles.length}/${targets.length}`);
  if (failedFiles.length === 0) {
    console.log("All evaluated files passed coverage threshold.");
    process.exit(0);
  }
  console.error(`Failed files: ${failedFiles.length}/${targets.length}`);
  for (const f of failedFiles) {
    console.error(`  FAIL: ${f.target} (${f.reason || `coverage ${f.percent}% < ${threshold}%`})`);
  }
  process.exit(1);
}

export function main() {
  const flags = parseCliArgs();

  if (flags.help) {
    console.log(`Usage: node tools/coverage-changed.mjs [options]

Options:
  --base <ref>         Base Git reference for diff
  --head <ref>         Head Git reference for diff (default: HEAD)
  --max-files <n>      Max changed files to check coverage (default: 10)
  --threshold <n>      Minimum changed lines coverage percent (default: 50)
  --files <list>       Explicit comma-separated file list (bypasses git diff)
  --dry-run            Show planned coverage targets without running tests
  --help, -h           Show this help
`);
    process.exit(0);
  }

  const { rawFiles, baseRef } = collectRawFiles(flags);

  const candidateFiles = filterCandidateFiles(ROOT, rawFiles);

  if (candidateFiles.length === 0) {
    console.log("coverage-changed: no changed *.mjs source files detected. Coverage gate PASS (fast exit).");
    process.exit(0);
  }

  // ponytail: cap first 10 files to keep CI bounded | ceiling: 10 files | upgrade: parallel sharded matrix
  const targets = capTargets(candidateFiles, flags.maxFiles || 10);

  console.log(`coverage-changed: evaluating ${targets.length} file(s) (threshold=${flags.threshold}%):`);
  for (const t of targets) {
    console.log(`  - ${t}`);
  }

  if (flags.dryRun) {
    console.log("coverage-changed: dry-run complete.");
    process.exit(0);
  }

  const failedFiles = [];
  const passedFiles = [];

  for (const target of targets) {
    const result = runFileCoverage(ROOT, target, flags, baseRef);
    if (result.passed) {
      passedFiles.push(target);
    } else {
      failedFiles.push(result);
    }
  }

  reportAggregate(targets, passedFiles, failedFiles, flags.threshold);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}
