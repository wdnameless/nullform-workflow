#!/usr/bin/env node
/**
 * tools/cfr-report.mjs — Change Failure Rate (CFR) report based on conventional commits.
 *
 * Reads git log --since=Nd --format=%H|%at|%s in root.
 * Detects conventional fix( and feat( commits.
 * A fix within 48h after a feat is treated as a post-merge fix.
 * Read-only report, no gate.
 *
 * CLI:
 *   node tools/cfr-report.mjs [--root <dir>] [--since <interval>] [--json] [--help]
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = ["Usage: cfr-report.mjs [--root <dir>] [--since <interval>] [--json] [--help]", "", "Options:", "  --root <dir>       Repository root (default: .)", "  --since <interval> Git since window, e.g. 7d, 14d (default: 7d)", "  --json             Output results as JSON", "  -h, --help         Show this help message", ""].join("\n");

const WINDOW_48H_MS = 48 * 60 * 60 * 1000;

function scaleEpoch(num) {
  return num < 1e11 ? num * 1000 : num;
}

function toTimestampMs(at) {
  if (typeof at === "number") return scaleEpoch(at);
  if (typeof at !== "string") return 0;
  const num = Number(at);
  if (!Number.isNaN(num)) return scaleEpoch(num);
  const parsed = new Date(at).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isFeat(subject) {
  return /^(?:feat(?:\([^)]*\))?!?:|feat\()/i.test(subject.trim());
}

function isFix(subject) {
  return /^(?:fix(?:\([^)]*\))?!?:|fix\()/i.test(subject.trim());
}

export function parseGitLog(output) {
  if (!output || typeof output !== "string") return [];
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const commits = [];
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length >= 3) {
      commits.push({
        hash: parts[0],
        at: Number(parts[1]) || parts[1],
        subject: parts.slice(2).join("|"),
      });
    }
  }
  return commits;
}

/**
 * Pure calculation of Change Failure Rate from commit list or git log output.
 * @param {Array<{hash: string, at: number|string, subject: string}>|string} input
 * @returns {{rate: number, ratePercent: number, totalCommits: number, totalFeats: number, totalFixes: number, postMergeFixes: Array<object>}}
 */
export function computeCfr(input) {
  const commits = typeof input === "string" ? parseGitLog(input) : (Array.isArray(input) ? input : []);
  if (!commits.length) {
    return {
      rate: 0,
      ratePercent: 0,
      totalCommits: 0,
      totalFeats: 0,
      totalFixes: 0,
      postMergeFixes: [],
    };
  }

  const sorted = commits
    .slice()
    .map((c) => ({
      hash: String(c.hash || ""),
      at: c.at,
      atMs: toTimestampMs(c.at),
      subject: String(c.subject || ""),
    }))
    .sort((a, b) => a.atMs - b.atMs);

  const feats = [];
  const fixes = [];
  for (const c of sorted) {
    if (isFeat(c.subject)) feats.push(c);
    else if (isFix(c.subject)) fixes.push(c);
  }

  const postMergeFixes = [];
  for (const fix of fixes) {
    const candidateFeats = feats.filter(
      (f) => f.atMs <= fix.atMs && fix.atMs - f.atMs <= WINDOW_48H_MS
    );
    if (candidateFeats.length > 0) {
      const nearestFeat = candidateFeats[candidateFeats.length - 1];
      const deltaMs = fix.atMs - nearestFeat.atMs;
      postMergeFixes.push({
        hash: fix.hash,
        at: fix.at,
        subject: fix.subject,
        featHash: nearestFeat.hash,
        deltaHours: Number((deltaMs / (3600 * 1000)).toFixed(1)),
      });
    }
  }

  const totalFeats = feats.length;
  const rate = totalFeats > 0 ? Number((postMergeFixes.length / totalFeats).toFixed(4)) : 0;
  const ratePercent = totalFeats > 0 ? Number(((postMergeFixes.length / totalFeats) * 100).toFixed(2)) : 0;

  return {
    rate,
    ratePercent,
    totalCommits: sorted.length,
    totalFeats,
    totalFixes: fixes.length,
    postMergeFixes,
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      since: { type: "string", default: "7d" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  return {
    root: values.root ?? ".",
    since: values.since ?? "7d",
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

function readGitLog(root, since) {
  try {
    const raw = execFileSync("git", ["log", `--since=${since}`, "--format=%H|%at|%s"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseGitLog(raw);
  } catch {
    return [];
  }
}

export function main() {
  let flags;
  try {
    flags = parseCliArgs();
  } catch (err) {
    console.error(`cfr-report: ${err.message}`);
    process.exit(2);
  }

  if (flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const root = resolve(flags.root);
  const commits = readGitLog(root, flags.since);
  const result = computeCfr(commits);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log("Change Failure Rate (CFR) Report:");
  console.log(`  Rate: ${result.ratePercent}%`);
  console.log(`  Counts: total=${result.totalCommits}, feat=${result.totalFeats}, fix=${result.totalFixes}, post-merge-fix=${result.postMergeFixes.length}`);
  if (result.postMergeFixes.length > 0) {
    console.log("  Post-merge fixes (within 48h of feat):");
    for (const fix of result.postMergeFixes) {
      console.log(`    - [${fix.hash.slice(0, 8)}] ${fix.subject} (${fix.deltaHours}h after feat ${fix.featHash.slice(0, 8)})`);
    }
  } else {
    console.log("  Post-merge fixes: (none)");
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
