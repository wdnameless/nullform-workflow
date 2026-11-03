import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LOG_REL_PATH = join(".workflow", "gate-counts.jsonl");

export function resolveLogPath(opts = {}) {
  if (opts.file) return resolve(opts.file);
  if (process.env.GATE_COUNTS_FILE) return resolve(process.env.GATE_COUNTS_FILE);
  const root = opts.root ? resolve(opts.root) : process.cwd();
  return join(root, DEFAULT_LOG_REL_PATH);
}

/**
 * Append-only gate counter without network or PII.
 *
 * @param {object} params
 * @param {string} params.gate - Gate identifier (e.g. "workflow-check", "workflow-close", "quality", "code-size")
 * @param {string} [params.role] - Optional role identifier (e.g. "fixer", "reviewer", "oracle")
 * @param {any} [params.result] - Gate outcome (e.g. "pass", "fail", 0, 1, true, false, "ok")
 * @param {string} [params.t] - Optional ISO timestamp override (defaults to current time)
 * @param {string} [params.file] - Optional explicit target file path
 * @param {string} [params.root] - Optional root path to anchor .workflow/gate-counts.jsonl
 * @returns {object} The appended record { t, gate, role?, result }
 */
export function recordGate({ gate, role, result, t, file, root } = {}) {
  if (!gate) {
    throw new Error("recordGate: 'gate' parameter is required");
  }

  const entry = {
    t: typeof t === "string" ? t : new Date().toISOString(),
    gate: String(gate),
    ...(role !== undefined && role !== null ? { role: String(role) } : {}),
    result: result !== undefined ? result : "ok",
  };

  const targetPath = resolveLogPath({ file, root });
  mkdirSync(dirname(targetPath), { recursive: true });
  appendFileSync(targetPath, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Read all gate count records from a JSONL file.
 *
 * @param {string} [filePath]
 * @returns {Array<object>}
 */
export function readGateCounts(filePath) {
  const p = resolveLogPath({ file: filePath });
  if (!existsSync(p)) return [];
  const content = readFileSync(p, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Tally entries into summary statistics.
 *
 * @param {Array<object>} entries
 * @returns {object}
 */
export function tallyCounts(entries) {
  const byGate = {};
  const byRole = {};
  const byResult = {};

  for (const entry of entries) {
    const g = entry.gate || "unknown";
    byGate[g] = (byGate[g] || 0) + 1;

    if (entry.role) {
      byRole[entry.role] = (byRole[entry.role] || 0) + 1;
    }

    const resKey = String(entry.result);
    byResult[resKey] = (byResult[resKey] || 0) + 1;
  }

  return {
    total: entries.length,
    byGate,
    byRole,
    byResult,
  };
}

/**
 * Format tally summary for human-readable CLI printing.
 *
 * @param {object} summary
 * @returns {string}
 */
export function formatTally(summary) {
  if (!summary || summary.total === 0) {
    return "Gate counts: 0 recorded.";
  }
  const lines = [`Gate counts summary (total: ${summary.total}):`];
  lines.push("  By gate:");
  for (const [g, count] of Object.entries(summary.byGate)) {
    lines.push(`    ${g}: ${count}`);
  }
  if (Object.keys(summary.byRole).length > 0) {
    lines.push("  By role:");
    for (const [r, count] of Object.entries(summary.byRole)) {
      lines.push(`    ${r}: ${count}`);
    }
  }
  if (Object.keys(summary.byResult).length > 0) {
    lines.push("  By result:");
    for (const [res, count] of Object.entries(summary.byResult)) {
      lines.push(`    ${res}: ${count}`);
    }
  }
  return lines.join("\n");
}

function parseCliArgs(argv) {
  const flags = { result: "ok" };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[arg.slice(2)] = argv[++i];
    }
  }
  return flags;
}

function handleTally(argv) {
  const flags = parseCliArgs(argv);
  const summary = tallyCounts(readGateCounts(resolveLogPath(flags)));
  console.log(flags.json ? JSON.stringify(summary, null, 2) : formatTally(summary));
  return 0;
}

function handleRecord(argv) {
  const flags = parseCliArgs(argv);
  if (!flags.gate) {
    console.error("gate-counter record: missing --gate");
    return 1;
  }
  recordGate(flags);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (cmd === "tally") return handleTally(argv);
  if (cmd === "record") return handleRecord(argv);
  console.log(`Usage: node tools/gate-counter.mjs tally [--file <path>] [--root <dir>] [--json]
       node tools/gate-counter.mjs record --gate <name> [--role <role>] [--result <res>]`);
  return 0;
}

const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
  process.argv[1].endsWith("gate-counter.mjs")
);

if (isMain) {
  const code = main();
  if (code !== 0) process.exit(code);
}
