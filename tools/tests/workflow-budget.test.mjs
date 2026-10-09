/**
 * tools/tests/workflow-budget.test.mjs — tests for workflow budget warning (R02) and check-budget gate (R03).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cmdStart,
  cmdStatus,
  cmdCheckBudget,
  BUDGET_WARN_RATIO,
  BUDGET_WARN_DEFAULT_TOKENS,
  BUDGET_WARN_DEFAULT_CALLS,
} from "../workflow.mjs";

const CLI_PATH = fileURLToPath(new URL("../workflow.mjs", import.meta.url));

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function writeSessionJsonl(dir, filename, records, mtimeMs = Date.now()) {
  const filePath = join(dir, filename);
  const content = records
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n") + "\n";
  writeFileSync(filePath, content, "utf8");
  utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  return filePath;
}

test("budget constants: default soft budget and warn ratio", () => {
  assert.equal(BUDGET_WARN_RATIO, 0.8, "warn ratio must be 80%");
  assert.equal(BUDGET_WARN_DEFAULT_TOKENS, 200000, "default tokens budget is 200K");
  assert.equal(BUDGET_WARN_DEFAULT_CALLS, 45, "default calls budget is 45");
});

test("check-budget: under threshold exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-under-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "under-budget-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    // Under threshold: 50K tokens, 10 tool calls (< 80% of 200K and 45)
    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 30000, output: 20000, totalTokens: 50000 },
        },
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "toolCall",
        name: "read",
        arguments: { path: `file${i}.ts` },
      })),
    ]);

    // Programmatic check
    const exitCode = cmdCheckBudget(tmp, { sessions: sessDir });
    assert.equal(exitCode, 0, "must exit 0 when under threshold");

    // CLI check
    const cliRes = runCli(["check-budget", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 0, "CLI must exit 0 when under threshold");

    // JSON flag
    const cliJson = runCli(["check-budget", "--sessions", sessDir, "--json", "--root", tmp], tmp);
    assert.equal(cliJson.status, 0);
    const parsed = JSON.parse(cliJson.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.overBudget, false);
    assert.equal(parsed.consumption.tokens, 50000);
    assert.equal(parsed.consumption.calls, 10);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("check-budget: over threshold without handoff exits 1 and names missing handoff.md", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-over-no-handoff-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "over-budget-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    // Over threshold: 180K tokens (90% >= 80%) and 40 calls (88% >= 80%)
    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100000, output: 80000, totalTokens: 180000 },
        },
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        type: "toolCall",
        name: "read",
        arguments: { path: `file${i}.ts` },
      })),
    ]);

    const exitCode = cmdCheckBudget(tmp, { sessions: sessDir });
    assert.equal(exitCode, 1, "must exit 1 when over threshold without handoff");

    const cliRes = runCli(["check-budget", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 1, "CLI must exit 1 when over threshold without handoff");
    const combinedOut = (cliRes.stdout + cliRes.stderr);
    assert.match(combinedOut, /\.workflow\/handoff\.md/, "output must name missing .workflow/handoff.md");
    assert.match(combinedOut, /РЕШЕНИЯ/, "output must mention РЕШЕНИЯ");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("check-budget: over threshold with fresh valid handoff exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-over-with-handoff-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "over-budget-handoff-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 120000, output: 80000, totalTokens: 200000 },
        },
      },
    ]);

    // Create fresh .workflow/handoff.md with all three required sections
    const handoffPath = join(tmp, ".workflow", "handoff.md");
    writeFileSync(
      handoffPath,
      "# HANDOFF\n\n## РЕШЕНИЯ\n- Принято решение X\n\n## ТУПИКИ\n- Попытка Y не сработала\n\n## ДАЛЬШЕ\n- Сделать Z\n",
      "utf8"
    );
    // Ensure mtime > startedAt
    const futureMs = Date.now() + 5000;
    utimesSync(handoffPath, new Date(futureMs), new Date(futureMs));

    const exitCode = cmdCheckBudget(tmp, { sessions: sessDir });
    assert.equal(exitCode, 0, "must exit 0 when over threshold but valid fresh handoff exists");

    const cliRes = runCli(["check-budget", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 0, "CLI must exit 0 with fresh handoff");

    const cliJson = runCli(["check-budget", "--sessions", sessDir, "--json", "--root", tmp], tmp);
    assert.equal(cliJson.status, 0);
    const parsed = JSON.parse(cliJson.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.handoff.exists, true);
    assert.equal(parsed.handoff.valid, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("check-budget: rejects handoff missing required sections or with stale mtime", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-bad-handoff-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "bad-handoff-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 190000 },
        },
      },
    ]);

    const handoffPath = join(tmp, ".workflow", "handoff.md");

    // Case A: Missing "ТУПИКИ" and "ДАЛЬШЕ"
    writeFileSync(handoffPath, "## РЕШЕНИЯ\n- Только решения\n", "utf8");
    const futureMs = Date.now() + 5000;
    utimesSync(handoffPath, new Date(futureMs), new Date(futureMs));

    let exitCode = cmdCheckBudget(tmp, { sessions: sessDir });
    assert.equal(exitCode, 1, "must reject handoff missing sections");

    // Case B: Has sections but stale mtime (older than startedAt)
    writeFileSync(
      handoffPath,
      "## РЕШЕНИЯ\n...## ТУПИКИ\n...## ДАЛЬШЕ\n...",
      "utf8"
    );
    const pastMs = Date.now() - 3600000;
    utimesSync(handoffPath, new Date(pastMs), new Date(pastMs));

    exitCode = cmdCheckBudget(tmp, { sessions: sessDir });
    assert.equal(exitCode, 1, "must reject stale handoff");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("status: contains BUDGET warning line when consumption >= 80%", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-status-warn-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "status-warn-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    // 170K tokens (85% >= 80%)
    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 170000 },
        },
      },
      ...Array.from({ length: 38 }, (_, i) => ({
        type: "toolCall",
        name: "bash",
        arguments: { command: `echo ${i}` },
      })),
    ]);

    const cliRes = runCli(["status", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 0);
    const out = cliRes.stdout;
    assert.match(out, /budget\s+consumption/i, "status must display consumption line");
    assert.match(out, /BUDGET warning/i, "status must contain BUDGET warning line");
    assert.match(out, /170000\/200000 tokens/, "status must display token numbers");
    assert.match(out, /38\/45 calls/, "status must display call numbers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("status: does not warn when consumption < 80%", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-status-nowarn-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "status-nowarn-task" });
    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    // 50K tokens (25%) and 10 calls (22%)
    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 50000 },
        },
      },
      { type: "toolCall", name: "read", arguments: {} },
    ]);

    const cliRes = runCli(["status", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 0);
    const out = cliRes.stdout;
    assert.match(out, /budget\s+consumption/i, "status must display consumption line");
    assert.doesNotMatch(out, /BUDGET warning/i, "status must not warn when under 80%");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("budgets.json: overrides default soft budget limits", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-override-"));
  try {
    cmdStart(tmp, { tier: "T1", task: "override-task" });
    const wfDir = join(tmp, ".workflow");
    writeFileSync(
      join(wfDir, "budgets.json"),
      JSON.stringify({ tokens: 1000, calls: 10 }),
      "utf8"
    );

    const sessDir = join(tmp, "sessions");
    mkdirSync(sessDir, { recursive: true });

    // 850 tokens (85% of 1000)
    writeSessionJsonl(sessDir, "session.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 850 },
        },
      },
    ]);

    // Status warns on custom budget
    const cliRes = runCli(["status", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /850\/1000 tokens/);
    assert.match(cliRes.stdout, /BUDGET warning/i);

    // check-budget fails on custom budget without handoff
    const checkRes = runCli(["check-budget", "--sessions", sessDir, "--root", tmp], tmp);
    assert.equal(checkRes.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("session search: recursive nested directory discovery via --sessions", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-nested-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "nested-task" });
    const deepDir = join(tmp, "sessions", "2026-10-09", "runs", "sub");
    mkdirSync(deepDir, { recursive: true });

    writeSessionJsonl(deepDir, "deep.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 175000 },
        },
      },
      { type: "toolCall", name: "bash", arguments: {} },
      { type: "toolCall", name: "read", arguments: {} },
    ]);

    // Status finds session in nested directory
    const cliRes = runCli(["status", "--sessions", join(tmp, "sessions"), "--root", tmp], tmp);
    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /175000\/200000 tokens/);
    assert.match(cliRes.stdout, /2\/45 calls/);
    assert.match(cliRes.stdout, /BUDGET warning/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("session search: homedir fallback (~/.omp/agent/sessions) with nested directories", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-budget-home-root-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "wf-budget-home-user-"));
  try {
    cmdStart(tmp, { tier: "T2", task: "home-fallback-task" });
    // Notice: tmp has NO local sessions directory at all!
    const ompSessDir = join(fakeHome, ".omp", "agent", "sessions", "nested", "active");
    mkdirSync(ompSessDir, { recursive: true });

    writeSessionJsonl(ompSessDir, "live.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 185000 },
        },
      },
      { type: "toolCall", name: "read", arguments: {} },
    ]);

    const cliRes = spawnSync(process.execPath, [CLI_PATH, "status", "--root", tmp], {
      cwd: tmp,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    });

    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /185000\/200000 tokens/, "must pick up session from homedir ~/.omp/agent/sessions");
    assert.match(cliRes.stdout, /1\/45 calls/);
    assert.match(cliRes.stdout, /BUDGET warning/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
