#!/usr/bin/env node
/**
 * tools/doctor-lite.mjs — Fast lightweight health probe for workflow operations.
 * Checks: node (>=18), harness-files, tools-syntax (node --check), skills-lock.
 * Budget: <= 2000ms. Zero network.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  const missing = [];
  const hasAgents =
    existsSync(join(targetRoot, "agent", "AGENTS.md")) ||
    existsSync(join(targetRoot, "AGENTS.md")) ||
    existsSync(join(targetRoot, "CLAUDE.md"));
  if (!hasAgents) missing.push("agent/AGENTS.md");

  const edFile = join(targetRoot, "rules", "enterprise-directives.md");
  if (!existsSync(edFile)) missing.push("rules/enterprise-directives.md");

  const portableFile = join(targetRoot, "core", "PORTABLE.md");
  if (!existsSync(portableFile)) missing.push("core/PORTABLE.md");

  const contextMd = join(targetRoot, "CONTEXT.md");
  if (!existsSync(contextMd)) missing.push("CONTEXT.md");

  const readmeMd = join(targetRoot, "README.md");
  if (!existsSync(readmeMd)) missing.push("README.md");

  if (missing.length > 0) {
    warns.push(`Отсутствуют обязательные файлы харнесса: ${missing.join(", ")}`);
  }

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

    for (const file of ordered) {
      // Stay well within 2000ms budget
      if (performance.now() - start > 1500) break;

      const fullPath = join(toolsDir, file);
      try {
        const res = spawnSync(checker, ["--check", fullPath], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 1000,
        });
        if (res.status !== 0) {
          syntaxErrors.push(file);
        }
      } catch {
        syntaxErrors.push(file);
      }
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
