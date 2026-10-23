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
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { runVerifyProfile } from "./verify-profile.mjs";
import { runAuditProfile } from "./audit-profile.mjs";

function parseArgs(argv) {
  const opts = {
    profile: "verify",
    root: "",
    harness: "",
    scope: [],
    userHome: "",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--profile") {
      opts.profile = argv[++i] || "verify";
    } else if (arg === "--root") {
      opts.root = argv[++i] || "";
    } else if (arg === "--harness" || arg === "--harness-root" || arg === "-HarnessRoot") {
      opts.harness = argv[++i] || "";
    } else if (arg === "--scope" || arg === "-Scope") {
      const val = argv[++i] || "";
      opts.scope = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--user-home") {
      opts.userHome = argv[++i] || "";
    }
  }

  return opts;
}

function resolveRoots(opts = {}) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const scriptParent = dirname(toolsDir);
  const parentOfScriptParent = dirname(scriptParent);

  let harnessRoot = opts.harness ? resolve(opts.harness) : "";
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
  const agentDir = join(userHome, ".omp", "agent");

  return {
    harnessRoot: resolve(harnessRoot),
    repoRoot: resolve(repoRoot),
    userHome: resolve(userHome),
    agentDir: resolve(agentDir),
  };
}
import { runProc } from "./verify-shared.mjs";
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

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(`Usage: node tools/verify.mjs [options]

Options:
  --profile verify|audit   Profile to run (default: verify)
  --root <path>            Project/repo root directory
  --harness <path>         Harness root directory
  --scope <list>           Scope for glossary/coverage check (e.g. agent,tools)
  --user-home <path>       Override user home directory
  --json                   Output results as JSON
  --help, -h               Show this help message
`);
    process.exit(0);
  }

  process.env.NF_NO_DASHBOARD = "1";

  let ctx;
  try {
    ctx = { ...resolveRoots(opts), scope: opts.scope };
  } catch (err) {
    console.error(`Failed to resolve roots: ${err.message}`);
    process.exit(2);
  }

  let results = [];
  if (opts.profile === "audit") {
    results = await runAuditProfile(ctx);
  } else if (opts.profile === "verify") {
    results = await runVerifyProfile(ctx);
  } else {
    console.error(`Unknown profile: ${opts.profile}. Supported: verify, audit.`);
    process.exit(2);
  }

  const failCount = results.filter((r) => r.status === "FAIL").length;
  const setupCount = results.filter((r) => r.status === "SETUP").length;
  const passCount = results.filter((r) => r.status === "PASS").length;
  const total = results.length;

  if (opts.json) {
    const output = {
      results,
      findings: results.filter((r) => r.status === "FAIL").map((r) => r.label),
      ok: failCount === 0,
      passed: passCount,
      total,
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.profile === "audit") {
    console.log("\n=== Harness audit ===\n");
    console.log(formatAuditTable(results));
    console.log("");
    if (failCount === 0) {
      console.log(`all ${total} checks clean\n`);
    } else {
      console.log(`${failCount} check(s) failed\n`);
    }
  } else {
    console.log("\n=== Workflow harness verification ===");
    console.log(`  harness : ${ctx.harnessRoot}`);
    console.log(`  agent   : ${ctx.agentDir}\n`);
    console.log(formatVerifyTable(results));
    console.log(`\n${total - failCount - setupCount}/${total} checks passed`);
    if (setupCount > 0) {
      console.log(`${setupCount} awaiting configuration - see the SETUP rows above.`);
    }
    console.log("");
  }

  // process.exit() discards stdout/stderr still queued on a pipe, which on
  // macOS truncates the JSON document mid-object (seen in CI: a parse error at
  // an arbitrary offset). Set the code and let Node flush before exiting.
  process.exitCode = failCount > 0 ? 1 : 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main().catch((err) => {
    console.error(`Unhandled error: ${err.stack || err.message}`);
    process.exitCode = 2;
  });
}
