/**
 * tools/tests/lane-cost.test.mjs — R03: Per-lane USD cost ceiling tests.
 *
 * Verifies:
 * - loadSoftBudgets reads maxCostUsd (global or tiers[tier], default undefined)
 * - buildMetricRecord includes costUsd, costBudgetUsd, and costStatus ('unverified' when unknown, 'overrun' when exceeded)
 * - cmdStatus and check-budget print cost spent/limit, unverified when unknown, and explicit overrun
 * - no maxCostUsd -> no gate
 * - state field injection works without network
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadSoftBudgets,
  buildMetricRecord,
} from "../workflow-core.mjs";
import {
  cmdStart,
  cmdStatus,
  cmdCheckBudget,
  load,
  save,
} from "../workflow.mjs";

const CLI_PATH = fileURLToPath(new URL("../workflow.mjs", import.meta.url));

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function makeTemp(prefix = "lane-cost-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("loadSoftBudgets: default maxCostUsd is undefined when file missing or unspecified", () => {
  const dir = makeTemp("wf-cost-def-");
  try {
    const bDefault = loadSoftBudgets(dir, "T2");
    assert.equal(bDefault.maxCostUsd, undefined);

    const wfDir = join(dir, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "budgets.json"), JSON.stringify({ tokens: 100_000, calls: 30 }));
    const bSpecifiedWithoutCost = loadSoftBudgets(dir, "T2");
    assert.equal(bSpecifiedWithoutCost.maxCostUsd, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSoftBudgets: reads global maxCostUsd or tier-specific override", () => {
  const dir = makeTemp("wf-cost-budgets-");
  try {
    const wfDir = join(dir, ".workflow");
    mkdirSync(wfDir, { recursive: true });

    // Global maxCostUsd
    writeFileSync(join(wfDir, "budgets.json"), JSON.stringify({ maxCostUsd: 3.5 }));
    const bGlobal = loadSoftBudgets(dir, "T2");
    assert.equal(bGlobal.maxCostUsd, 3.5);

    // Tier-specific override via object
    writeFileSync(
      join(wfDir, "budgets.json"),
      JSON.stringify({
        maxCostUsd: 5.0,
        tiers: {
          T1: { maxCostUsd: 1.0 },
          T2: { maxCostUsd: 2.5 },
        },
      })
    );
    assert.equal(loadSoftBudgets(dir, "T1").maxCostUsd, 1.0);
    assert.equal(loadSoftBudgets(dir, "T2").maxCostUsd, 2.5);
    assert.equal(loadSoftBudgets(dir, "T3").maxCostUsd, 5.0); // falls back to global

    // Tier-specific override via scalar number
    writeFileSync(
      join(wfDir, "budgets.json"),
      JSON.stringify({
        maxCostUsd: 4.0,
        tiers: {
          T2: 1.5,
        },
      })
    );
    assert.equal(loadSoftBudgets(dir, "T2").maxCostUsd, 1.5);
    assert.equal(loadSoftBudgets(dir, "T0").maxCostUsd, 4.0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildMetricRecord: includes costUsd, costBudgetUsd and marks unverified when unknown", () => {
  // Unknown cost: costUsd is null, costStatus is 'unverified' (never 'pass')
  const stUnknown = {
    tier: "T2",
    task: "test-unknown-cost",
    startedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    costBudgetUsd: 2.0,
  };
  const metricUnknown = buildMetricRecord(stUnknown);
  assert.equal(metricUnknown.costUsd, null);
  assert.equal(metricUnknown.costBudgetUsd, 2.0);
  assert.equal(metricUnknown.costStatus, "unverified");
  assert.notEqual(metricUnknown.costStatus, "pass");

  // No maxCostUsd: costBudgetUsd is null, costStatus is 'unverified' when unknown
  const stNoBudget = {
    tier: "T1",
    task: "test-no-budget",
    startedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
  };
  const metricNoBudget = buildMetricRecord(stNoBudget);
  assert.equal(metricNoBudget.costUsd, null);
  assert.equal(metricNoBudget.costBudgetUsd, null);
  assert.equal(metricNoBudget.costStatus, "unverified");
});

test("buildMetricRecord: records overrun when cost exceeds budget", () => {
  const stOverrun = {
    tier: "T2",
    task: "test-overrun",
    startedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    costUsd: 3.5,
    costBudgetUsd: 2.0,
  };
  const metric = buildMetricRecord(stOverrun);
  assert.equal(metric.costUsd, 3.5);
  assert.equal(metric.costBudgetUsd, 2.0);
  assert.equal(metric.costStatus, "overrun");
  assert.equal(metric.costOverrun, true);

  // Within budget
  const stOk = {
    tier: "T2",
    task: "test-ok",
    startedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    costUsd: 1.2,
    costBudgetUsd: 2.0,
  };
  const metricOk = buildMetricRecord(stOk);
  assert.equal(metricOk.costUsd, 1.2);
  assert.equal(metricOk.costBudgetUsd, 2.0);
  assert.equal(metricOk.costStatus, "ok");
  assert.equal(metricOk.costOverrun, false);

  // No budget ceiling: no overrun
  const stUnmetered = {
    tier: "T0",
    task: "test-unmetered",
    startedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    costUsd: 10.0,
  };
  const metricUnmetered = buildMetricRecord(stUnmetered);
  assert.equal(metricUnmetered.costUsd, 10.0);
  assert.equal(metricUnmetered.costBudgetUsd, null);
  assert.equal(metricUnmetered.costStatus, "ok");
  assert.equal(metricUnmetered.costOverrun, false);
});

test("status and check-budget: reports unverified when cost unknown", () => {
  const dir = makeTemp("wf-status-unverified-");
  try {
    cmdStart(dir, { tier: "T2", task: "unverified-cost-task" });

    // Status CLI output contains 'cost spent/limit' and 'unverified'
    const statusCli = runCli(["status", "--root", dir], dir);
    assert.equal(statusCli.status, 0);
    assert.match(statusCli.stdout, /cost spent\/limit/i);
    assert.match(statusCli.stdout, /unverified/i);

    // check-budget CLI output contains 'cost spent/limit' and 'unverified'
    const budgetCli = runCli(["check-budget", "--root", dir], dir);
    assert.equal(budgetCli.status, 0);
    assert.match(budgetCli.stdout, /cost spent\/limit/i);
    assert.match(budgetCli.stdout, /unverified/i);

    // check-budget --json contains costStatus: 'unverified'
    const jsonCli = runCli(["check-budget", "--json", "--root", dir], dir);
    assert.equal(jsonCli.status, 0);
    const parsed = JSON.parse(jsonCli.stdout.trim());
    assert.equal(parsed.costStatus, "unverified");
    assert.notEqual(parsed.costStatus, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status and check-budget: reports cost spent/limit and explicit overrun when budget exceeded", () => {
  const dir = makeTemp("wf-status-overrun-");
  try {
    const wfDir = join(dir, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "budgets.json"), JSON.stringify({ maxCostUsd: 1.0 }));

    cmdStart(dir, { tier: "T2", task: "overrun-task" });

    // Inject cost exceeding maxCostUsd via state field
    const st = load(dir);
    st.costUsd = 2.5;
    save(dir, st);

    // Status reports cost spent/limit and overrun
    const statusCli = runCli(["status", "--root", dir], dir);
    assert.equal(statusCli.status, 0);
    assert.match(statusCli.stdout, /cost spent\/limit/i);
    assert.match(statusCli.stdout, /overrun/i);

    // check-budget fails due to overrun without handoff
    const budgetCli = runCli(["check-budget", "--root", dir], dir);
    assert.equal(budgetCli.status, 1);
    const combinedOut = budgetCli.stdout + budgetCli.stderr;
    assert.match(combinedOut, /cost spent\/limit/i);
    assert.match(combinedOut, /overrun/i);

    // check-budget --json reports costStatus: 'overrun' and overBudget: true
    const jsonCli = runCli(["check-budget", "--json", "--root", dir], dir);
    assert.equal(jsonCli.status, 1);
    const parsed = JSON.parse(jsonCli.stdout.trim());
    assert.equal(parsed.costStatus, "overrun");
    assert.equal(parsed.overBudget, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no maxCostUsd -> no cost gate even if cost is high", () => {
  const dir = makeTemp("wf-no-cost-gate-");
  try {
    cmdStart(dir, { tier: "T2", task: "no-gate-task" });

    // Inject high cost in state, but without maxCostUsd configured
    const st = load(dir);
    st.costUsd = 50.0;
    save(dir, st);

    // check-budget must pass because no ceiling is set
    const budgetCli = runCli(["check-budget", "--root", dir], dir);
    assert.equal(budgetCli.status, 0);
    assert.match(budgetCli.stdout, /cost spent\/limit/i);
    assert.match(budgetCli.stdout, /\$50/);

    const jsonCli = runCli(["check-budget", "--json", "--root", dir], dir);
    assert.equal(jsonCli.status, 0);
    const parsed = JSON.parse(jsonCli.stdout.trim());
    assert.equal(parsed.overBudget, false);
    assert.equal(parsed.costStatus, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session plumbing: resolves cost from session JSONL transcript with usage.totalCost", () => {
  const dir = makeTemp("wf-session-cost-");
  try {
    const wfDir = join(dir, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "budgets.json"), JSON.stringify({ maxCostUsd: 2.0 }));

    cmdStart(dir, { tier: "T2", task: "session-cost-task" });

    const sessDir = join(dir, "sessions");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 1000, output: 500, totalTokens: 1500, totalCost: 0.75 },
          },
        }),
      ].join("\n") + "\n"
    );

    const budgetCli = runCli(["check-budget", "--sessions", sessDir, "--root", dir], dir);
    assert.equal(budgetCli.status, 0);
    assert.match(budgetCli.stdout, /\$0\.75/);
    assert.match(budgetCli.stdout, /cost spent\/limit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
