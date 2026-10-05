/**
 * tools/tests/session-retro.test.mjs — tests for session-retro signal scanner.
 *
 * Verifies R-session-retro:
 *   - parseSessionFile tolerates empty/malformed lines
 *   - scoreSession ranks retries, heavy reads, long sessions, repeat commands
 *   - scanSessions respects days/limit and misses nothing on fixtures
 *   - CLI exit codes (0 scan incl. empty, 2 malformed input)
 *   - record/status cadence round-trip
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseSessionFile,
  scoreSession,
  scanSessions,
  formatRetroReport,
  recordRetroReview,
  loadRetroState,
} from "../session-retro.mjs";

const CLI_PATH = fileURLToPath(new URL("../session-retro.mjs", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

function writeSession(dir, name, records, mtimeMs = Date.now()) {
  const p = join(dir, name);
  writeFileSync(p, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

const toolCall = (toolName, extra = {}) => ({
  type: "toolCall",
  name: toolName,
  arguments: { command: "vitest run", ...extra },
});

test("parseSessionFile tolerates empty and malformed lines", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-parse-"));
  try {
    const p = writeSession(tmp, "s.jsonl", ["", "{bad json", { type: "toolCall", name: "read", arguments: { path: "a.ts:1-10" } }, ""]);
    const s = parseSessionFile(p);
    assert.equal(s.lines, 2);
    assert.equal(s.malformed, 1);
    assert.equal(s.readCalls, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scoreSession flags retries, heavy reads, long sessions, repeat commands", () => {
  const retry = { errors: 6, retries: 2, failedBash: 1, readBytes: 0, readCalls: 2, toolCalls: 10, lines: 10, malformed: 0, lastCommandCounts: new Map() };
  const r1 = scoreSession(retry);
  assert.ok(r1.score > 0);
  assert.ok(r1.signals.some((s) => s.startsWith("retries:")));
  assert.ok(r1.hints.includes("guardrail/tool-economy"));

  const heavy = { errors: 0, retries: 0, failedBash: 0, readBytes: 200000, readCalls: 5, toolCalls: 10, lines: 10, malformed: 0, lastCommandCounts: new Map() };
  const r2 = scoreSession(heavy);
  assert.ok(r2.hints.includes("navigate/tokens"));

  const long = { errors: 0, retries: 0, failedBash: 0, readBytes: 0, readCalls: 1, toolCalls: 500, lines: 500, malformed: 0, lastCommandCounts: new Map() };
  const r3 = scoreSession(long);
  assert.ok(r3.hints.includes("compaction/instructions"));

  const repeat = { errors: 0, retries: 0, failedBash: 0, readBytes: 0, readCalls: 0, toolCalls: 5, lines: 5, malformed: 0, lastCommandCounts: new Map([["git status", 4]]) };
  const r4 = scoreSession(repeat);
  assert.ok(r4.signals.some((s) => s.startsWith("repeat-x4")));

  const clean = { errors: 0, retries: 0, failedBash: 0, readBytes: 0, readCalls: 1, toolCalls: 5, lines: 5, malformed: 0, lastCommandCounts: new Map() };
  assert.equal(scoreSession(clean).score, 0);
});

test("scanSessions ranks worst first and respects days/limit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-scan-"));
  try {
    const now = Date.now();
    const errRec = { message: { role: "assistant" }, text: "failed with error exception timeout" };
    writeSession(tmp, "bad.jsonl", [errRec, errRec, errRec, errRec, errRec, errRec, toolCall("bash")], now);
    writeSession(tmp, "ok.jsonl", [{ message: { role: "assistant" }, text: "done" }], now);
    writeSession(tmp, "old.jsonl", [errRec, errRec, errRec, errRec, errRec, errRec], now - 40 * 86400000);
    const res = scanSessions(tmp, { days: 30, limit: 10, now });
    assert.equal(res.scanned, 2);
    assert.equal(res.candidates.length, 1);
    assert.match(res.candidates[0].file, /bad\.jsonl$/);

    writeSession(tmp, "bad2.jsonl", [errRec, errRec, errRec, errRec, errRec, errRec, errRec], now);
    const limited = scanSessions(tmp, { days: 30, limit: 1, now });
    assert.equal(limited.candidates.length, 1);

    const report = formatRetroReport(limited);
    assert.match(report, /session-retro:/);
    assert.match(report, /bad2?\.jsonl/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanSessions on missing/empty dir returns empty envelope", () => {
  const missing = scanSessions(join(tmpdir(), "retro-nope-missing"), {});
  assert.equal(missing.empty, true);
  const tmp = mkdtempSync(join(tmpdir(), "retro-empty-"));
  try {
    const res = scanSessions(tmp, {});
    assert.equal(res.empty, true);
    assert.match(formatRetroReport(res), /нет \.jsonl/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("record/status cadence round-trip", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-state-"));
  try {
    const state = join(tmp, "retro.json");
    recordRetroReview(state, { detail: "reviewed top-3" });
    const loaded = loadRetroState(state);
    assert.equal(loaded.reviews.length, 1);
    assert.equal(loaded.reviews[0].detail, "reviewed top-3");

    const st = spawnSync(process.execPath, [CLI_PATH, "status", "--state", state, "--max-days", "7"], { encoding: "utf8" });
    assert.equal(st.status, 0);
    assert.match(st.stdout, /в норме/);

    const stale = spawnSync(process.execPath, [CLI_PATH, "status", "--state", join(tmp, "nope.json"), "--max-days", "7"], { encoding: "utf8" });
    assert.equal(stale.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan exits 0 on empty dir; bad flag exits 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-cli-"));
  try {
    const ok = runCli(["scan", "--sessions", tmp, "--days", "7"]);
    assert.equal(ok.status, 0);
    const bad = runCli(["scan", "--bogus"]);
    assert.equal(bad.status, 2);
    const js = runCli(["scan", "--sessions", tmp, "--json"]);
    assert.equal(js.status, 0);
    assert.doesNotThrow(() => JSON.parse(js.stdout));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseSessionFile detects retry on repeated failed bash command", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-retry-"));
  try {
    const failBash = (out) => ({ type: "toolCall", name: "bash", arguments: { command: "npm test" }, result: { exitCode: 1, output: out } });
    const p = writeSession(tmp, "r.jsonl", [failBash("error failed"), failBash("error failed")]);
    const s = parseSessionFile(p);
    assert.equal(s.bashCalls, 2);
    assert.equal(s.failedBash, 2);
    assert.equal(s.retries, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
