#!/usr/bin/env node
/**
 * tools/orchestrator-evals.mjs
 * Declarative behavioral evals for the orchestrator return contract (R07).
 *
 * Cases: [{ id, input, expect }] where expect is { field, contains? | equals? }
 * checked against subject[field].
 * Exports: runEvals(cases, subject), DEFAULT_CASES.
 * CLI: node tools/orchestrator-evals.mjs --subject <json-file> [--cases <json-file>]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_CASES = [
  {
    id: "eval-status",
    input: {},
    expect: { field: "status", contains: "DONE" },
  },
  {
    id: "eval-files",
    input: {},
    expect: { field: "files", contains: "tools/" },
  },
  {
    id: "eval-tests",
    input: {},
    expect: { field: "tests", contains: "→" },
  },
  {
    id: "eval-interfaces",
    input: {},
    expect: { field: "interfaces", contains: "suggestTier" },
  },
  {
    id: "eval-requirements",
    input: {},
    expect: { field: "requirements", contains: "R0" },
  },
  {
    id: "eval-concerns",
    input: {},
    expect: { field: "concerns", equals: "none" },
  },
];

export function runEvals(cases = [], subject = {}) {
  const results = [];

  for (const c of cases) {
    const target = typeof subject === "function" ? subject(c.input) : subject;
    const field = c.expect?.field;
    let val = target != null ? target[field] : undefined;

    // Case-insensitive property lookup fallback
    if (val === undefined && target && typeof target === "object" && field) {
      const lower = field.toLowerCase();
      for (const k of Object.keys(target)) {
        if (k.toLowerCase() === lower) {
          val = target[k];
          break;
        }
      }
    }

    let pass = true;
    let detail = "ok";

    if (val === undefined) {
      pass = false;
      detail = `field "${field}" is undefined`;
    } else if (c.expect && "equals" in c.expect) {
      const expected = c.expect.equals;
      const matches = typeof expected === "object" && expected !== null
        ? JSON.stringify(val) === JSON.stringify(expected)
        : val === expected;
      if (!matches) {
        pass = false;
        detail = `expected field "${field}" to equal ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`;
      }
    } else if (c.expect && "contains" in c.expect) {
      const expected = c.expect.contains;
      if (Array.isArray(val)) {
        const found = val.some((item) => {
          if (item === expected) return true;
          if (typeof item === "string" && typeof expected === "string") {
            return item.includes(expected);
          }
          return false;
        });
        if (!found) {
          pass = false;
          detail = `expected field "${field}" array to contain ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`;
        }
      } else if (typeof val === "string") {
        if (!val.includes(String(expected))) {
          pass = false;
          detail = `expected field "${field}" to contain ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`;
        }
      } else {
        pass = false;
        detail = `field "${field}" cannot be checked with contains (type: ${typeof val})`;
      }
    }

    results.push({
      id: c.id,
      pass,
      detail,
    });
  }

  return results;
}

const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
  process.argv[1].endsWith("orchestrator-evals.mjs")
);

if (isDirectRun) {
  const args = process.argv.slice(2);
  let subjectPath = null;
  let casesPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--subject" && args[i + 1]) {
      subjectPath = args[++i];
    } else if (args[i] === "--cases" && args[i + 1]) {
      casesPath = args[++i];
    }
  }

  if (!subjectPath) {
    console.error("Usage: node tools/orchestrator-evals.mjs --subject <json-file> [--cases <json-file>]");
    process.exit(1);
  }

  try {
    const raw = readFileSync(subjectPath, "utf8");
    const subject = JSON.parse(raw);
    const cases = casesPath ? JSON.parse(readFileSync(casesPath, "utf8")) : DEFAULT_CASES;
    const results = runEvals(cases, subject);
    let anyFailed = false;

    for (const r of results) {
      if (r.pass) {
        console.log(`PASS ${r.id}: ${r.detail}`);
      } else {
        anyFailed = true;
        console.error(`FAIL ${r.id}: ${r.detail}`);
      }
    }

    process.exit(anyFailed ? 1 : 0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
