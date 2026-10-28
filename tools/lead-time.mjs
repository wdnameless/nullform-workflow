#!/usr/bin/env node
/**
 * tools/lead-time.mjs — Lead time measurement per tier and pause from events.jsonl.
 *
 * Reads <root>/.workflow/events.jsonl and extracts tier from text prefix (T0..T3).
 * Computes medians: start->close per tier, ask->answered pauses, and artifact-oracle->close.
 * Missing or empty journal prints zeros and exits 0.
 *
 * CLI:
 *   node tools/lead-time.mjs [--root <dir>] [--json] [--help]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: lead-time.mjs [--root <dir>] [--json] [--help]

Options:
  --root <dir>   Path to repository root (default: .)
  --json         Output results as JSON
  -h, --help     Show this help message
`;

function median(numbers) {
  if (!numbers || numbers.length === 0) return 0;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Pure calculation of lead times from events array.
 * @param {Array<{at: string, kind: string, text?: string}>} events
 * @returns {{byTier: Record<string, {medianStartCloseMs: number, n: number}>, medianAskAnsweredMs: number, medianOracleCloseMs: number}}
 */
export function computeLeadTime(events) {
  const byTier = {
    T0: { medianStartCloseMs: 0, n: 0 },
    T1: { medianStartCloseMs: 0, n: 0 },
    T2: { medianStartCloseMs: 0, n: 0 },
    T3: { medianStartCloseMs: 0, n: 0 },
  };

  if (!Array.isArray(events) || events.length === 0) {
    return {
      byTier,
      medianAskAnsweredMs: 0,
      medianOracleCloseMs: 0,
    };
  }

  const startCloseDurationsByTier = { T0: [], T1: [], T2: [], T3: [] };
  const askAnsweredDurations = [];
  const oracleCloseDurations = [];

  let currentStart = null;
  let pendingAskAt = null;
  let pendingOracleAt = null;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const kind = ev.kind;
    const text = typeof ev.text === "string" ? ev.text : "";
    const atMs = ev.at ? new Date(ev.at).getTime() : NaN;
    if (Number.isNaN(atMs)) continue;

    if (kind === "start") {
      const tierMatch = text.match(/^(T[0-3])\b/);
      const tier = tierMatch ? tierMatch[1] : null;
      currentStart = { tier, at: atMs };
      pendingAskAt = null;
      pendingOracleAt = null;
    } else if (kind === "ask") {
      pendingAskAt = atMs;
    } else if (kind === "answered") {
      if (pendingAskAt != null && atMs >= pendingAskAt) {
        askAnsweredDurations.push(atMs - pendingAskAt);
        pendingAskAt = null;
      }
    } else if (kind === "oracle" || (kind === "artifact" && /^oracle\b/i.test(text))) {
      pendingOracleAt = atMs;
    } else if (kind === "close") {
      if (currentStart) {
        const tierMatch = text.match(/^(T[0-3])\b/);
        const tier = tierMatch ? tierMatch[1] : (currentStart.tier || "T1");
        const duration = atMs - currentStart.at;
        if (duration >= 0) {
          if (!startCloseDurationsByTier[tier]) {
            startCloseDurationsByTier[tier] = [];
          }
          startCloseDurationsByTier[tier].push(duration);
        }
        currentStart = null;
      }
      if (pendingOracleAt != null && atMs >= pendingOracleAt) {
        oracleCloseDurations.push(atMs - pendingOracleAt);
        pendingOracleAt = null;
      }
    }
  }

  for (const [tier, list] of Object.entries(startCloseDurationsByTier)) {
    byTier[tier] = {
      medianStartCloseMs: median(list),
      n: list.length,
    };
  }

  return {
    byTier,
    medianAskAnsweredMs: median(askAnsweredDurations),
    medianOracleCloseMs: median(oracleCloseDurations),
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  return {
    root: values.root ?? ".",
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

export function main() {
  let flags;
  try {
    flags = parseCliArgs();
  } catch (err) {
    console.error(`lead-time: ${err.message}`);
    process.exit(2);
  }

  if (flags.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const eventsFile = join(resolve(flags.root), ".workflow", "events.jsonl");
  let events = [];

  if (existsSync(eventsFile)) {
    try {
      const content = readFileSync(eventsFile, "utf8");
      events = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      events = [];
    }
  }

  const result = computeLeadTime(events);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log("Workflow Lead Time Report:");
  for (const [tier, data] of Object.entries(result.byTier)) {
    console.log(`  Tier ${tier}: median start->close = ${data.medianStartCloseMs}ms (n=${data.n})`);
  }
  console.log(`  Ask -> Answered pauses: median = ${result.medianAskAnsweredMs}ms`);
  console.log(`  Artifact Oracle -> Close: median = ${result.medianOracleCloseMs}ms`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}
