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
function emptyLeadTime() {
  const byTier = {};
  for (const t of ["T0", "T1", "T2", "T3"]) byTier[t] = { medianStartCloseMs: 0, n: 0 };
  return { byTier, medianAskAnsweredMs: 0, medianOracleCloseMs: 0 };
}

function tierOf(text) {
  const m = text.match(/^(T[0-3])\b/);
  return m ? m[1] : null;
}

function isOracleEvent(kind, text) {
  return kind === "oracle" || (kind === "artifact" && /^oracle\b/i.test(text));
}

function applyStart(st, text, atMs) {
  st.currentStart = { tier: tierOf(text), at: atMs };
  st.pendingAskAt = null;
  st.pendingOracleAt = null;
}

function applyClose(st, text, atMs) {
  if (st.currentStart) {
    const duration = atMs - st.currentStart.at;
    if (duration >= 0) {
      const tier = tierOf(text) || st.currentStart.tier || "T1";
      (st.byTier[tier] ??= []).push(duration);
    }
    st.currentStart = null;
  }
  if (st.pendingOracleAt != null && atMs >= st.pendingOracleAt) {
    st.oracleClose.push(atMs - st.pendingOracleAt);
    st.pendingOracleAt = null;
  }
}

function applyEvent(st, kind, text, atMs) {
  if (kind === "start") applyStart(st, text, atMs);
  else if (kind === "ask") st.pendingAskAt = atMs;
  else if (kind === "answered" && st.pendingAskAt != null && atMs >= st.pendingAskAt) {
    st.askAnswered.push(atMs - st.pendingAskAt);
    st.pendingAskAt = null;
  }
  else if (isOracleEvent(kind, text)) st.pendingOracleAt = atMs;
  else if (kind === "close") applyClose(st, text, atMs);
}

export function computeLeadTime(events) {
  if (!Array.isArray(events) || events.length === 0) return emptyLeadTime();
  const st = { byTier: { T0: [], T1: [], T2: [], T3: [] }, askAnswered: [], oracleClose: [],
    currentStart: null, pendingAskAt: null, pendingOracleAt: null };
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const atMs = ev.at ? new Date(ev.at).getTime() : NaN;
    if (Number.isNaN(atMs)) continue;
    applyEvent(st, ev.kind, typeof ev.text === "string" ? ev.text : "", atMs);
  }
  const out = emptyLeadTime();
  for (const [tier, list] of Object.entries(st.byTier)) {
    out.byTier[tier] = { medianStartCloseMs: median(list), n: list.length };
  }
  out.medianAskAnsweredMs = median(st.askAnswered);
  out.medianOracleCloseMs = median(st.oracleClose);
  return out;
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
