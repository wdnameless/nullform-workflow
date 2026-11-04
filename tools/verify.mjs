#!/usr/bin/env node
/**
 * tools/verify.mjs — Cross-platform verification and audit runner for the workflow harness.
 *
 * Runs verification gates across POSIX (Linux, macOS) and Windows.
 *
 * Usage:
 *   node tools/verify.mjs [--profile verify|audit] [--root <path>] [--harness <path>]
 *                         [--scope <list>] [--user-home <path>] [--json] [--help]
 */

import {
  existsSync,
  realpathSync
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { runVerifyProfile } from "./verify-profile.mjs";
import { runAuditProfile } from "./audit-profile.mjs";
import { resolveHostHome } from "./installation/profiles.mjs";

export const SUPPORTED_VERIFY_HARNESSES = ["claude", "codex", "opencode"];
function parseHarnessArg(arg, argv, i, opts) {
  if (arg === "--harness-root" || arg.startsWith("--harness-root=") || arg === "-HarnessRoot") {
    opts.harnessRoot = arg.startsWith("--harness-root=") ? arg.slice(15) : argv[++i] || "";
    return i;
  }
  if (arg === "--harness" || arg.startsWith("--harness=") || arg === "-Harness" || arg === "-harness") {
    opts.harness = arg.startsWith("--harness=") ? arg.slice(10) : argv[++i] || "";
    return i;
  }
  return -1;
}

function parseArgs(argv) {
  const opts = {
    profile: "verify",
    root: "",
    harness: "",
    harnessRoot: "",
    scope: [],
    userHome: "",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const hIdx = parseHarnessArg(arg, argv, i, opts);
    if (hIdx !== -1) {
      i = hIdx;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      opts.profile = arg.startsWith("--profile=") ? arg.slice(10) : argv[++i] || "verify";
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      opts.root = arg.startsWith("--root=") ? arg.slice(7) : argv[++i] || "";
    } else if (arg === "--scope" || arg === "-Scope") {
      const val = argv[++i] || "";
      opts.scope = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--user-home") {
      opts.userHome = argv[++i] || "";
    }
  }

  return opts;
}

function isHarnessPath(harness) {
  return Boolean(harness && (harness.includes("/") || harness.includes("\\") || existsSync(harness)));
}

function resolveVerifyHarness(opts, userHome) {
  let selectedHarness = opts.harness || "";
  const isPath = isHarnessPath(selectedHarness);
  if (selectedHarness && !isPath && !SUPPORTED_VERIFY_HARNESSES.includes(selectedHarness)) {
    throw new Error(
      `Unsupported harness "${selectedHarness}". Supported harnesses: ${SUPPORTED_VERIFY_HARNESSES.join(", ")}`
    );
  }
  if (!selectedHarness || isPath) {
    selectedHarness = "claude";
  }

  const hostInfo = resolveHostHome({ harness: selectedHarness, userHome });
  return {
    selectedHarness,
    agentDir: resolve(hostInfo.path),
  };
}
function resolveInitialHarnessRoot(opts) {
  if (opts.harnessRoot) return resolve(opts.harnessRoot);
  if (isHarnessPath(opts.harness)) {
    return resolve(opts.harness);
  }
  return "";
}

export function resolveRoots(opts = {}) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const scriptParent = dirname(toolsDir);
  const parentOfScriptParent = dirname(scriptParent);

  let harnessRoot = resolveInitialHarnessRoot(opts);
  if (!harnessRoot) {
    if (existsSync(join(parentOfScriptParent, "agent", "AGENTS.md"))) {
      harnessRoot = parentOfScriptParent;
    } else if (existsSync(join(scriptParent, "agent", "AGENTS.md"))) {
      harnessRoot = scriptParent;
    } else {
      let cur = scriptParent;
      while (cur) {
        if (existsSync(join(cur, "agent", "AGENTS.md"))) {
          harnessRoot = cur;
          break;
        }
        const up = dirname(cur);
        if (up === cur) break;
        cur = up;
      }
      if (!harnessRoot) harnessRoot = scriptParent;
    }
  }

  let repoRoot = opts.root ? resolve(opts.root) : "";
  if (!repoRoot) {
    const candidates = [
      scriptParent,
      join(harnessRoot, "workflow-repo"),
      join(dirname(harnessRoot), "workflow-repo"),
      harnessRoot,
    ];
    for (const cand of candidates) {
      if (
        cand &&
        existsSync(join(cand, "install.ps1")) &&
        existsSync(join(cand, "agent", "models.yml.example"))
      ) {
        repoRoot = cand;
        break;
      }
    }
    if (!repoRoot) {
      for (const cand of candidates) {
        if (cand && existsSync(join(cand, "install.ps1"))) {
          repoRoot = cand;
          break;
        }
      }
    }
    if (!repoRoot) repoRoot = harnessRoot;
  }

  const userHome = opts.userHome ? resolve(opts.userHome) : homedir();
  const { selectedHarness, agentDir } = resolveVerifyHarness(opts, userHome);

  return {
    harness: selectedHarness,
    harnessRoot: resolve(harnessRoot),
    repoRoot: resolve(repoRoot),
    userHome: resolve(userHome),
    agentDir: resolve(agentDir),
  };
}
export { testTierGate } from "./verify-shared.mjs";


function formatVerifyTable(results) {
  const maxLabelLen = Math.max(63, ...results.map((r) => r.label.length));
  const col1W = maxLabelLen;
  const col2W = 6;

  let out = "";
  out += "Check".padEnd(col1W) + " " + "Result".padEnd(col2W) + " Detail\n";
  out += "-".repeat(col1W) + " " + "-".repeat(col2W) + " " + "------\n";
  for (const r of results) {
    const label = r.label.padEnd(col1W);
    const status = r.status.padEnd(col2W);
    out += `${label} ${status} ${r.detail}\n`;
  }
  return out;
}

function formatAuditTable(results) {
  const col1W = 29;
  const col2W = 6;
  const col3W = 46;

  let out = "";
  out +=
    "Check".padEnd(col1W) +
    " " +
    "Result".padEnd(col2W) +
    " " +
    "Detail".padEnd(col3W) +
    " Ms\n";
  out += "-".repeat(col1W) + " " + "-".repeat(col2W) + " " + "-".repeat(col3W) + " --\n";
  for (const r of results) {
    const label = r.label.padEnd(col1W);
    const status = r.status.padEnd(col2W);
    const detail = (r.detail || "").padEnd(col3W);
    out += `${label} ${status} ${detail} ${r.ms ?? 0}\n`;
  }
  return out;
}

const USAGE = `Usage: node tools/verify.mjs [options]

Options:
  --profile verify|audit   Profile to run (default: verify)
  --harness <name|path>    Harness to verify: claude, codex, opencode (default: claude)
  --root <path>            Project/repo root directory
  --harness-root <path>    Harness root directory
  --scope <list>           Scope for glossary/coverage check (e.g. agent,tools)
  --user-home <path>       Override user home directory
  --json                   Output results as JSON
  --help, -h               Show this help message
`;

/** Run the selected profile, or null when the name is unknown. */
async function runProfile(profile, ctx) {
  if (profile === "audit") return runAuditProfile(ctx);
  if (profile === "verify") return runVerifyProfile(ctx);
  return null;
}

/** Print the run and return its exit code.
 *
 * A check that could not decide is not a pass: counting only FAIL as red let an UNVERIFIED
 * row disappear from the tally while the run still exited 0.
 */
function reportResults(results, opts, ctx) {
  const counts = {
    fail: results.filter((r) => r.status === "FAIL").length,
    setup: results.filter((r) => r.status === "SETUP").length,
    pass: results.filter((r) => r.status === "PASS").length,
    unverified: results.filter((r) => r.status === "UNVERIFIED").length,
    total: results.length,
  };

  if (opts.json) {
    console.log(JSON.stringify({
      results,
      findings: results.filter((r) => r.status === "FAIL").map((r) => r.label),
      ok: counts.fail === 0 && counts.unverified === 0,
      passed: counts.pass,
      unverified: counts.unverified,
      total: counts.total,
    }, null, 2));
  } else if (opts.profile === "audit") {
    printAuditReport(results, counts);
  } else {
    printVerifyReport(results, counts, ctx);
  }
  return counts.fail > 0 || counts.unverified > 0 ? 1 : 0;
}

function printAuditReport(results, counts) {
  console.log("\n=== Harness audit ===\n");
  console.log(formatAuditTable(results));
  console.log("");
  console.log(counts.fail === 0 && counts.unverified === 0
    ? `all ${counts.total} checks clean\n`
    : `${counts.fail} check(s) failed, ${counts.unverified} unverified\n`);
}

function printVerifyReport(results, counts, ctx) {
  console.log("\n=== Workflow harness verification ===");
  console.log(`  harness : ${ctx.harnessRoot}`);
  console.log(`  agent   : ${ctx.agentDir}\n`);
  console.log(formatVerifyTable(results));
  console.log(`\n${counts.total - counts.fail - counts.setup - counts.unverified}/${counts.total} checks passed`);
  if (counts.unverified > 0) console.log(`${counts.unverified} could not be verified - see the UNVERIFIED rows above.`);
  if (counts.setup > 0) console.log(`${counts.setup} awaiting configuration - see the SETUP rows above.`);
  console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  process.env.NF_NO_DASHBOARD = "1";

  if (opts.harness && !isHarnessPath(opts.harness) && !SUPPORTED_VERIFY_HARNESSES.includes(opts.harness)) {
    console.error(`Unsupported harness "${opts.harness}". Supported harnesses: ${SUPPORTED_VERIFY_HARNESSES.join(", ")}`);
    process.exit(2);
  }

  let ctx;
  try {
    ctx = { ...resolveRoots(opts), scope: opts.scope };
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const results = await runProfile(opts.profile, ctx);
  if (!results) {
    console.error(`Unknown profile: ${opts.profile}. Supported: verify, audit.`);
    process.exit(2);
  }

  // process.exit() discards stdout/stderr still queued on a pipe, which on macOS
  // truncates the JSON document mid-object (seen in CI: a parse error at an arbitrary
  // offset). Set the code and let Node flush before exiting.
  process.exitCode = reportResults(results, opts, ctx);
}

if (process.argv[1] && (() => { try { const a = resolve(process.argv[1]).toLowerCase(), b = fileURLToPath(import.meta.url).toLowerCase(); return a === b || realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; } })()) {
  main().catch((err) => {
    console.error(`Unhandled error: ${err.stack || err.message}`);
    process.exitCode = 2;
  });
}
