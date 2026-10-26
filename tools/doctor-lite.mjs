#!/usr/bin/env node
/**
 * tools/doctor-lite.mjs — Fast lightweight health probe for workflow operations.
 * Checks: node (>=18), harness-files, tools-syntax (node --check), skills-lock.
 * Budget: <= 2000ms. Zero network.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { verifySkillsLock } from "./carry.mjs";

const PRIORITY_TOOLS = [
  "workflow.mjs",
  "doctor.mjs",
  "install-harness.mjs",
  "install-detect.mjs",
  "doctor-lite.mjs",
];

/**
 * Run lightweight health checks on target root.
 *
 * @param {string} root - Path to repository or harness root (default ".")
 * @returns {{ ok: boolean, warns: string[], ms: number }}
 */
/** Harness files live next to this tool, never in the project root. */
function missingHarnessFiles() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const missing = [];
  if (!existsSync(join(harnessRoot, "agent", "AGENTS.md")) && !existsSync(join(harnessRoot, "AGENTS.md")) && !existsSync(join(harnessRoot, "CLAUDE.md"))) missing.push("agent/AGENTS.md");
  if (!existsSync(join(harnessRoot, "rules", "enterprise-directives.md"))) missing.push("rules/enterprise-directives.md");
  if (!existsSync(join(harnessRoot, "core", "PORTABLE.md"))) missing.push("core/PORTABLE.md");
  if (!existsSync(join(harnessRoot, "CONTEXT.md"))) missing.push("CONTEXT.md");
  if (!existsSync(join(harnessRoot, "README.md"))) missing.push("README.md");
  return missing;
}

export function doctorLite(root = ".") {
  const start = performance.now();
  const targetRoot = resolve(root);
  const warns = [];

  // 1. check 'node': version >= 18
  const majorVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (isNaN(majorVersion) || majorVersion < 18) {
    warns.push(`Node.js v${process.versions.node} устарел (требуется >= 18)`);
  }

  // 2. check 'harness-files'
  // These are HARNESS files, not project files: checking them against the project
  // root made every `workflow start --root <project>` report missing harness files
  // about a directory that is not supposed to contain them.
  const missingHarness = missingHarnessFiles();
  if (missingHarness.length) warns.push(`Harness files missing: ${missingHarness.join(", ")}`);


  // 3. check 'tools-syntax'
  const toolsDir = join(targetRoot, "tools");
  if (!existsSync(toolsDir)) {
    warns.push("tools/ directory missing");
  } else {
    let files = [];
    try {
      const entries = readdirSync(toolsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".mjs")) {
          files.push(entry.name);
        }
      }
    } catch (err) {
      warns.push(`tools/ directory read error: ${err.message}`);
    }

    // Order by priority first
    const ordered = [
      ...PRIORITY_TOOLS.filter((t) => files.includes(t)),
      ...files.filter((t) => !PRIORITY_TOOLS.includes(t)),
    ];

    const checker = (!process.versions.bun && process.execPath) || "node";
    const syntaxErrors = [];

    // One child process for the whole set instead of one `node --check` per file:
    // ~250 spawns cost ~1.5 s and grew with the repo until the probe timed out and
    // silently skipped files. A single `--experimental-vm-modules` pass compiles
    // every file in-process and reports exactly the same verdict in milliseconds.
    const CHECKER = `const vm=require("vm"),fs=require("fs");
for(const f of process.argv.slice(1)){try{new vm.SourceTextModule(fs.readFileSync(f,"utf8"),{identifier:f})}catch(e){console.log(f)}}`;
    try {
      const res = spawnSync(checker, ["--experimental-vm-modules", "-e", CHECKER, ...ordered.map((f) => join(toolsDir, f))], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (res.status !== 0 || res.error) {
        // A failed checker run is not evidence that the files are broken; say so.
        warns.push(`Проверка синтаксиса не выполнена: ${res.error?.message || `exit ${res.status}`}`);
      } else {
        for (const line of String(res.stdout).split(/\r?\n/)) {
          const file = line.trim();
          if (file) syntaxErrors.push(file.slice(file.lastIndexOf("\\") + 1).slice(file.lastIndexOf("/") + 1));
        }
      }
    } catch (err) {
      warns.push(`Проверка синтаксиса не выполнена: ${err.message}`);
    }

    if (syntaxErrors.length > 0) {
      warns.push(`Синтаксические ошибки в: ${syntaxErrors.join(", ")}`);
    }
  }

  // 4. check 'skills-lock' verify
  const lockCandidates = [
    join(targetRoot, "skills-lock.json"),
    join(targetRoot, ".workflow", "skills-lock.json"),
  ];

  for (const lockPath of lockCandidates) {
    if (existsSync(lockPath)) {
      try {
        const res = verifySkillsLock(lockPath, targetRoot, { throws: false });
        if (!res.ok) {
          warns.push(`skills-lock verification failed: ${res.error || res.skill || "hash mismatch"}`);
        }
      } catch (err) {
        warns.push(`skills-lock verification error: ${err.message}`);
      }
    }
  }

  const ms = Math.round(performance.now() - start);
  return {
    ok: warns.length === 0,
    warns,
    ms,
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("doctor-lite.mjs")) {
  const root = process.argv[2] || ".";
  const res = doctorLite(root);
  console.log(JSON.stringify(res, null, 2));
  process.exitCode = res.ok ? 0 : 1;
}
