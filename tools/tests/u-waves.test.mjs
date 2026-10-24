/**
 * tools/tests/u-waves.test.mjs
 * Behavioral tests for universal-1 Slice C (R06, R07):
 * - collectWaves: ticket parsing, wave grouping, status and lines mapping
 * - calibrationHint: boundary tests for ~3000 lines/ticket (<1500 merge, >4500 split)
 * - runBenchmark: deterministic synthetic T2 benchmark run, normalizedCost reuse
 * - dashboard HTML: waves section with status bars in run view
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectWaves,
  calibrationHint,
  collectRunState,
  sanitizeHttpState,
  generateDashboardHtml,
} from "../dashboard.mjs";
import { runBenchmark, CANONICAL_BENCHMARK } from "../benchmark-run.mjs";
import { normalizedCost } from "../cost-snapshot.mjs";

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "u-waves-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. collectWaves tests
// ---------------------------------------------------------------------------

test("collectWaves: parses fixture tickets.json and groups by wave ascending", () => {
  withTmpDir((tmp) => {
    const fixtureTickets = [
      { id: "T02", title: "Coverage check", status: "open", wave: 2, lines: 1800, zone: ["tools/coverage-check.mjs"] },
      { id: "T01", title: "Plan check", status: "done", wave: 1, lines: 2500, zone: ["tools/plan-check.mjs"] },
      { id: "T03", title: "Blind accept", status: "pending", wave: 2, lines: 4800, zone: ["tools/blind-accept.mjs"] },
    ];
    writeFileSync(join(tmp, "tickets.json"), JSON.stringify(fixtureTickets, null, 2), "utf8");

    const waves = collectWaves(tmp);
    assert.ok(Array.isArray(waves));
    assert.equal(waves.length, 2);

    // Wave 1
    assert.equal(waves[0].n, 1);
    assert.equal(waves[0].tickets.length, 1);
    assert.equal(waves[0].tickets[0].id, "T01");
    assert.equal(waves[0].tickets[0].title, "Plan check");
    assert.equal(waves[0].tickets[0].status, "done");
    assert.equal(waves[0].tickets[0].lines, 2500);

    // Wave 2
    assert.equal(waves[1].n, 2);
    assert.equal(waves[1].tickets.length, 2);
    assert.deepEqual(
      waves[1].tickets.map((t) => t.id),
      ["T02", "T03"]
    );
  });
});

test("collectWaves: parses .workflow/tickets.json and handles missing fields", () => {
  withTmpDir((tmp) => {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    const payload = {
      tickets: [
        { id: "T10", title: "Install detector", wave: 1 },
        { id: "T20" }, // missing wave and lines
      ],
    };
    writeFileSync(join(tmp, ".workflow", "tickets.json"), JSON.stringify(payload, null, 2), "utf8");

    const waves = collectWaves(tmp);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].n, 1);
    assert.equal(waves[0].tickets.length, 2);

    const t1 = waves[0].tickets[0];
    assert.equal(t1.id, "T10");
    assert.equal(t1.title, "Install detector");
    assert.equal(t1.status, "pending");
    assert.equal(t1.lines, 0);

    const t2 = waves[0].tickets[1];
    assert.equal(t2.id, "T20");
    assert.equal(t2.title, "T20"); // fallback to id
    assert.equal(t2.status, "pending");
    assert.equal(t2.lines, 0);
  });
});

test("collectWaves: accepts direct array or object in-memory", () => {
  const direct = [
    { id: "A01", title: "Task A", wave: 1, status: "done", lines: 3200 },
    { id: "B01", title: "Task B", wave: 3, status: "in_progress", lines: 1100 },
  ];
  const resArray = collectWaves(direct);
  assert.equal(resArray.length, 2);
  assert.equal(resArray[0].n, 1);
  assert.equal(resArray[1].n, 3);

  const resObj = collectWaves({ tickets: direct });
  assert.equal(resObj.length, 2);
  assert.equal(resObj[0].tickets[0].id, "A01");
});

test("collectWaves: returns empty array on empty dir or invalid input", () => {
  withTmpDir((tmp) => {
    assert.deepEqual(collectWaves(tmp), []);
    assert.deepEqual(collectWaves(null), []);
    assert.deepEqual(collectWaves("non-existent-path-1234"), []);
  });
});

// ---------------------------------------------------------------------------
// 2. calibrationHint boundaries
// ---------------------------------------------------------------------------

test("calibrationHint: boundaries for ~3000 lines/ticket (<1500 merge, >4500 split)", () => {
  // < 1500: merge
  assert.equal(calibrationHint(0), "merge");
  assert.equal(calibrationHint(500), "merge");
  assert.equal(calibrationHint(1499), "merge");
  assert.equal(calibrationHint(null), "merge");
  assert.equal(calibrationHint(-100), "merge");

  // 1500..4500: ok
  assert.equal(calibrationHint(1500), "ok");
  assert.equal(calibrationHint(2000), "ok");
  assert.equal(calibrationHint(3000), "ok");
  assert.equal(calibrationHint(4000), "ok");
  assert.equal(calibrationHint(4500), "ok");

  // > 4500: split
  assert.equal(calibrationHint(4501), "split");
  assert.equal(calibrationHint(5000), "split");
  assert.equal(calibrationHint(12000), "split");
});

// ---------------------------------------------------------------------------
// 3. runBenchmark tests
// ---------------------------------------------------------------------------

test("runBenchmark: canonical fixture returns expected roles, total, tests, ms", () => {
  const res = runBenchmark();
  assert.ok(res);
  assert.ok(typeof res.total === "number");
  assert.ok(res.total > 0);
  assert.equal(typeof res.tests, "number");
  assert.equal(typeof res.ms, "number");

  assert.ok(res.roles["@orchestrator"]);
  assert.ok(res.roles["@explorer"]);
  assert.ok(res.roles["@fixer"]);
  assert.ok(res.roles["@oracle"]);

  // Verify normalizedCost formula: out*5 + write*1.25 + read*0.1
  const orch = res.roles["@orchestrator"];
  const expectedOrchUnits = orch.output * 5 + orch.cacheWrite * 1.25 + orch.cacheRead * 0.1;
  assert.equal(orch.units, expectedOrchUnits);
  assert.equal(orch.units, 4350);

  const fixer = res.roles["@fixer"];
  const expectedFixerUnits = fixer.output * 5 + fixer.cacheWrite * 1.25 + fixer.cacheRead * 0.1;
  assert.equal(fixer.units, expectedFixerUnits);
  assert.equal(fixer.units, 17200);

  assert.equal(res.total, 33450);
  assert.equal(res.tests, 16);
  assert.equal(res.ms, 9900);
});

test("runBenchmark: deterministic across multiple runs (two runs = identical total)", () => {
  const r1 = runBenchmark();
  const r2 = runBenchmark();

  assert.equal(r1.total, r2.total);
  assert.deepEqual(r1.roles, r2.roles);
  assert.equal(r1.tests, r2.tests);
  assert.equal(r1.ms, r2.ms);
});

test("runBenchmark: parses custom fixture directory with benchmark.json", () => {
  withTmpDir((tmp) => {
    const customFixture = {
      roles: {
        "@worker-a": { output: 200, cacheWrite: 100, cacheRead: 1000, ms: 500, tests: 3, calls: 2 },
        "@worker-b": { output: 400, cacheWrite: 200, cacheRead: 2000, ms: 700, tests: 5, calls: 3 },
      },
      tests: 8,
      ms: 1200,
    };
    writeFileSync(join(tmp, "benchmark.json"), JSON.stringify(customFixture, null, 2), "utf8");

    const res = runBenchmark(tmp);
    assert.equal(res.tests, 8);
    assert.equal(res.ms, 1200);

    // worker-a: 200*5 + 100*1.25 + 1000*0.1 = 1000 + 125 + 100 = 1225
    assert.equal(res.roles["@worker-a"].units, 1225);
    // worker-b: 400*5 + 200*1.25 + 2000*0.1 = 2000 + 250 + 200 = 2450
    assert.equal(res.roles["@worker-b"].units, 2450);

    assert.equal(res.total, 1225 + 2450);

    // Verify determinism on custom fixture too
    const res2 = runBenchmark(tmp);
    assert.equal(res.total, res2.total);
  });
});

test("runBenchmark: CLI execution with --json outputs valid JSON", () => {
  const run = spawnSync(process.execPath, ["tools/benchmark-run.mjs", "--json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(run.status, 0);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.total, 33450);
  assert.equal(parsed.tests, 16);
});

// ---------------------------------------------------------------------------
// 4. Dashboard run view: waves section, status bars, and /api/state
// ---------------------------------------------------------------------------

test("dashboard: HTML contains waves section and calibration target", () => {
  const mock = {
    project: { name: "test-proj", branch: "main", commit: "abc" },
    session: { key: "local", name: "local", usage: null },
    progress: { percent: 50, stagesDone: 3, stagesRequired: 6, stagesSkipped: 0, artifactsDone: 3, artifactsTotal: 6 },
    stages: [{ id: "lane", name: "Ярус", wave: 0, status: "done" }],
    currentStage: { id: "recon", name: "Разведка", wave: 1, detail: "" },
    timing: { elapsedMs: 1000, remainingMin: 5, remainingMax: 10, medianTaskMs: 60000 },
    metrics: { briefCoverage: 50, requirements: { total: 2, byStatus: { done: 1 }, items: [], change: null }, debt: { total: 0, noTrigger: 0, items: [] }, memory: { status: "fresh", daysSince: null }, checks: null },
    waves: [{ wave: 0, title: "ВОЛНА 0", stages: [], agents: [] }],
    git: { isRepo: true, branch: "main", commit: { hash: "123", when: "now" }, files: [], added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0 },
    modules: [],
    critique: [],
    history: { total: 0, medianMs: 0, byTier: {}, recent: [] },
    fleet: [],
    log: { file: null, entries: [] },
    events: [],
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тестовая задача волн",
      stages: [{ id: "lane", status: "done", durationMs: 500 }],
      requirements: [{ id: "R06", text: "джборд волны", status: "open" }],
      waves: [
        {
          n: 1,
          tickets: [
            { id: "T01", title: "Smart install", status: "done", lines: 2800 },
            { id: "T02", title: "Briefing rounds", status: "in_progress", lines: 1200 },
          ],
        },
        {
          n: 2,
          tickets: [
            { id: "T03", title: "Waves bench", status: "pending", lines: 5200 },
          ],
        },
      ],
      calibration: {
        targetLines: 3000,
        linesPerTicket: 3000,
        minLines: 1500,
        maxLines: 4500,
        totalLines: 9200,
        totalTickets: 3,
        avgLinesPerTicket: 3067,
        hint: "ok",
      },
    },
  };

  const html = generateDashboardHtml(mock);
  assert.ok(html.includes("run-waves-section"), "HTML must contain run-waves-section");
  // The run-view redesign (live-dash-parity) replaced the flat wave card with a
  // lane + task matrix; the section container is unchanged.
  assert.ok(html.includes("run-wave-lane"), "HTML must contain run-wave-lane");
  assert.ok(html.includes("run-wave-bar"), "HTML must contain run-wave-bar");
  assert.ok(html.includes("Smart install"), "HTML must contain ticket title");
  assert.ok(html.includes("calibMerge") || html.includes("слить"), "HTML must render calibration merge hint");
  assert.ok(html.includes("calibSplit") || html.includes("разбить"), "HTML must render calibration split hint");
});

test("dashboard: sanitizeHttpState preserves run.waves and run.calibration for /api/state", () => {
  const rawData = {
    run: {
      open: true,
      status: "open",
      tier: "T2",
      waves: [
        { n: 1, tickets: [{ id: "T01", title: "Task 1", status: "done", lines: 3000 }] },
      ],
      calibration: {
        targetLines: 3000,
        linesPerTicket: 3000,
        totalLines: 3000,
        totalTickets: 1,
        avgLinesPerTicket: 3000,
        hint: "ok",
      },
    },
  };

  const sanitized = sanitizeHttpState(rawData);
  assert.ok(sanitized.run);
  assert.ok(Array.isArray(sanitized.run.waves));
  assert.equal(sanitized.run.waves.length, 1);
  assert.equal(sanitized.run.waves[0].n, 1);
  assert.equal(sanitized.run.waves[0].tickets[0].id, "T01");
  assert.equal(sanitized.run.waves[0].tickets[0].lines, 3000);

  assert.ok(sanitized.run.calibration);
  assert.equal(sanitized.run.calibration.targetLines, 3000);
  assert.equal(sanitized.run.calibration.hint, "ok");
});

test("dashboard: collectRunState populates run.waves and run.calibration", () => {
  withTmpDir((tmp) => {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    writeFileSync(
      join(tmp, ".workflow", "state.json"),
      JSON.stringify({ status: "open", tier: "T2", task: "Waves run test" }),
      "utf8"
    );
    writeFileSync(
      join(tmp, "tickets.json"),
      JSON.stringify([{ id: "T01", title: "Wave 1 Task", wave: 1, status: "open", lines: 2500 }]),
      "utf8"
    );

    const run = collectRunState(tmp);
    assert.ok(run);
    assert.ok(Array.isArray(run.waves));
    assert.equal(run.waves.length, 1);
    assert.equal(run.waves[0].n, 1);
    assert.equal(run.waves[0].tickets[0].id, "T01");
    assert.equal(run.waves[0].tickets[0].lines, 2500);

    assert.ok(run.calibration);
    assert.equal(run.calibration.targetLines, 3000);
    assert.equal(run.calibration.totalLines, 2500);
    assert.equal(run.calibration.hint, "ok");
  });
});
