/**
 * tools/tests/lead-time.test.mjs — tests for workflow lead-time calculator.
 *
 * Covers:
 *   - computeLeadTime: empty/invalid events returns zero metrics
 *   - computeLeadTime: start->close per-tier medians and counts
 *   - computeLeadTime: ask->answered pauses median
 *   - computeLeadTime: artifact-oracle->close median
 *   - CLI: --root with missing or empty journal exits 0 with zero metrics
 *   - CLI: --root with valid events exits 0 and formats output
 *   - CLI: --json outputs structured JSON
 *   - CLI: --help exits 0
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeLeadTime } from "../lead-time.mjs";

const CLI = fileURLToPath(new URL("../lead-time.mjs", import.meta.url));

function runCli(args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("computeLeadTime returns zero metrics for empty or invalid input", () => {
  const emptyRes = computeLeadTime([]);
  assert.equal(emptyRes.medianAskAnsweredMs, 0);
  assert.equal(emptyRes.medianOracleCloseMs, 0);
  assert.deepEqual(emptyRes.byTier.T0, { medianStartCloseMs: 0, n: 0 });
  assert.deepEqual(emptyRes.byTier.T1, { medianStartCloseMs: 0, n: 0 });
  assert.deepEqual(emptyRes.byTier.T2, { medianStartCloseMs: 0, n: 0 });
  assert.deepEqual(emptyRes.byTier.T3, { medianStartCloseMs: 0, n: 0 });

  const nullRes = computeLeadTime(null);
  assert.equal(nullRes.medianAskAnsweredMs, 0);
  assert.deepEqual(nullRes.byTier.T1, { medianStartCloseMs: 0, n: 0 });
});

test("computeLeadTime computes start->close per-tier median and count", () => {
  const events = [
    // T1 task 1: 20s
    { at: "2026-10-23T10:00:00.000Z", kind: "start", text: "T1 — task 1" },
    { at: "2026-10-23T10:00:20.000Z", kind: "close", text: "T1 — task 1" },
    // T1 task 2: 40s
    { at: "2026-10-23T10:05:00.000Z", kind: "start", text: "T1 — task 2" },
    { at: "2026-10-23T10:05:40.000Z", kind: "close", text: "T1 — task 2" },
    // T1 task 3: 60s -> T1 durations: [20000, 40000, 60000] -> median 40000, n: 3
    { at: "2026-10-23T10:10:00.000Z", kind: "start", text: "T1 — task 3" },
    { at: "2026-10-23T10:11:00.000Z", kind: "close", text: "T1 — task 3" },
    // T2 task 1: 100s
    { at: "2026-10-23T11:00:00.000Z", kind: "start", text: "T2 — big task" },
    { at: "2026-10-23T11:01:40.000Z", kind: "close", text: "T2 — big task" },
  ];

  const res = computeLeadTime(events);
  assert.equal(res.byTier.T1.n, 3);
  assert.equal(res.byTier.T1.medianStartCloseMs, 40000);
  assert.equal(res.byTier.T2.n, 1);
  assert.equal(res.byTier.T2.medianStartCloseMs, 100000);
  assert.equal(res.byTier.T0.n, 0);
  assert.equal(res.byTier.T0.medianStartCloseMs, 0);
});

test("computeLeadTime computes ask->answered pauses median", () => {
  const events = [
    { at: "2026-10-23T10:00:00.000Z", kind: "start", text: "T1 — task" },
    { at: "2026-10-23T10:02:00.000Z", kind: "ask", text: "clarify spec" },
    { at: "2026-10-23T10:03:00.000Z", kind: "answered", text: "spec clarified" }, // 60s
    { at: "2026-10-23T10:04:00.000Z", kind: "ask", text: "confirm scope" },
    { at: "2026-10-23T10:06:00.000Z", kind: "answered", text: "scope confirmed" }, // 120s
    { at: "2026-10-23T10:10:00.000Z", kind: "close", text: "T1 — task" },
  ];

  const res = computeLeadTime(events);
  // durations: [60000, 120000] -> median: 90000
  assert.equal(res.medianAskAnsweredMs, 90000);
});

test("computeLeadTime computes artifact-oracle->close median", () => {
  const events = [
    { at: "2026-10-23T10:00:00.000Z", kind: "start", text: "T2 — change" },
    { at: "2026-10-23T10:25:00.000Z", kind: "artifact", text: "oracle: ACCEPT all gates green" },
    { at: "2026-10-23T10:30:00.000Z", kind: "close", text: "T2 — change" },
  ];

  const res = computeLeadTime(events);
  // oracle (10:25) -> close (10:30): 5 min = 300000 ms
  assert.equal(res.medianOracleCloseMs, 300000);
});

test("CLI: missing or empty journal exits 0 with zero values", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lead-time-empty-"));
  try {
    const resMissing = runCli(["--root", tmp]);
    assert.equal(resMissing.status, 0);
    assert.match(resMissing.stdout, /T1: median start->close = 0ms/i);

    const resJson = runCli(["--root", tmp, "--json"]);
    assert.equal(resJson.status, 0);
    const parsed = JSON.parse(resJson.stdout);
    assert.equal(parsed.byTier.T1.medianStartCloseMs, 0);
    assert.equal(parsed.medianAskAnsweredMs, 0);

    // Now test existing but empty file
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    writeFileSync(join(tmp, ".workflow", "events.jsonl"), "", "utf8");
    const resEmpty = runCli(["--root", tmp, "--json"]);
    assert.equal(resEmpty.status, 0);
    const parsedEmpty = JSON.parse(resEmpty.stdout);
    assert.equal(parsedEmpty.byTier.T1.n, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: valid journal computes metrics and exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lead-time-valid-"));
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    const lines = [
      JSON.stringify({ at: "2026-10-23T10:00:00.000Z", kind: "start", text: "T1 — sample" }),
      JSON.stringify({ at: "2026-10-23T10:05:00.000Z", kind: "close", text: "T1 — sample" }),
    ].join("\n");
    writeFileSync(join(tmp, ".workflow", "events.jsonl"), lines, "utf8");

    const res = runCli(["--root", tmp, "--json"]);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.byTier.T1.n, 1);
    assert.equal(parsed.byTier.T1.medianStartCloseMs, 300000);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --help exits 0 with usage instructions", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: lead-time\.mjs/i);
});
