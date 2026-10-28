#!/usr/bin/env node
/**
 * tools/mutation-changed.mjs — CI Mutation Gate wrapper for changed files.
 *
 * Computes changed *.mjs files vs base ref, matches each file to its unit test suite,
 * runs mutation-test.mjs per changed file with bounded mutant budget and threshold,
 * and aggregates exit status. Exits 0 fast when no files changed.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      "max-files": { type: "string", default: "10" },
      "max-mutants": { type: "string", default: "10" },
      threshold: { type: "string", default: "80" },
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
    maxMutants: Number(values["max-mutants"] ?? 10),
    threshold: Number(values.threshold ?? 80),
    dryRun: Boolean(values["dry-run"]),
    files: values.files ?? null,
    help: Boolean(values.help),
  };
}
import { gitRevParse, resolveBaseRef, gitDiff, getChangedFiles, getChangedLines, findMatchingSuite, filterCandidateFiles } from "./changed-scope.mjs";
export { gitRevParse, resolveBaseRef, gitDiff, getChangedFiles, getChangedLines, findMatchingSuite, filterCandidateFiles };

export function main() {
  const flags = parseCliArgs();

  if (flags.help) {
    console.log(`Usage: node tools/mutation-changed.mjs [options]

Options:
  --base <ref>         Base Git reference for diff
  --head <ref>         Head Git reference for diff (default: HEAD)
  --max-files <n>      Max changed files to mutate (default: 10)
  --max-mutants <n>    Max mutants per file (default: 10)
  --threshold <n>      Minimum mutation score percent (default: 80)
  --files <list>       Explicit comma-separated file list (bypasses git diff)
  --dry-run            Show planned mutation targets without running tests
  --help, -h           Show this help
`);
    process.exit(0);
  }

  let rawFiles = [];

  let baseRef = null;
  if (flags.files) {
    rawFiles = flags.files
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    baseRef = resolveBaseRef(ROOT, flags.base);
    if (!baseRef) {
      console.log("mutation-changed: no base ref resolvable; skipping mutation gate.");
      process.exit(0);
    }

    console.log(`mutation-changed: computing changed files vs ${baseRef}...${flags.head}`);
    const diff = getChangedFiles(ROOT, baseRef, flags.head);
    if (diff === null) {
      console.log("mutation-changed: git diff failed or unavailable; skipping mutation gate.");
      process.exit(0);
    }
    rawFiles = diff;
  }

  const candidateFiles = filterCandidateFiles(ROOT, rawFiles);

  if (candidateFiles.length === 0) {
    console.log("mutation-changed: no changed *.mjs source files detected. Mutation gate PASS (fast exit).");
    process.exit(0);
  }

  // ponytail: cap first 10 files to keep CI bounded | ceiling: 10 files | upgrade: parallel sharded matrix
  const maxFiles = flags.maxFiles || 10;
  let targets = candidateFiles;
  if (targets.length > maxFiles) {
    console.log(`mutation-changed: runtime ceiling reached — capping to first ${maxFiles} of ${candidateFiles.length} files.`);
    targets = targets.slice(0, maxFiles);
  }

  console.log(`mutation-changed: evaluating ${targets.length} file(s) (mutants/file=${flags.maxMutants}, threshold=${flags.threshold}%):`);
  for (const t of targets) {
    console.log(`  - ${t}`);
  }

  if (flags.dryRun) {
    console.log("mutation-changed: dry-run complete.");
    process.exit(0);
  }

  const failedFiles = [];
  const passedFiles = [];

  for (const target of targets) {
    if (runFileGate(target, flags, baseRef)) passedFiles.push(target);
    else failedFiles.push({ target, exitCode: 1 });
  }


  console.log("\n============================================================");
  console.log("                MUTATION GATE AGGREGATE RESULT              ");
  console.log("============================================================");
  console.log(`Passed files: ${passedFiles.length}/${targets.length}`);
  if (failedFiles.length > 0) {
    console.error(`Failed files: ${failedFiles.length}/${targets.length}`);
    for (const f of failedFiles) {
      console.error(`  FAIL: ${f.target} (exit code ${f.exitCode})`);
    }
    process.exit(1);
  }

  console.log("All evaluated files passed mutation threshold.");
  process.exit(0);
}
export function runFileGate(target, flags, baseRef) {
  const suite = findMatchingSuite(ROOT, target);
  const fallbackTrue = process.platform === "win32" ? "node -e 'process.exit(0)'" : "true";
  const testCmd = suite ? `node --test ${suite}` : fallbackTrue;
  console.log(`\n>>> Mutating ${target} using cmd "${testCmd}"`);
  const args = ["tools/mutation-test.mjs", "--target", target, "--cmd", testCmd,
    "--max-mutants", String(flags.maxMutants), "--threshold", String(flags.threshold), "--check"];
  if (baseRef) {
    const changedLines = getChangedLines(ROOT, baseRef, flags.head, target);
    if (changedLines && changedLines.length > 0) args.push("--lines", changedLines.join(","));
  }
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
  return result.status === 0;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}
