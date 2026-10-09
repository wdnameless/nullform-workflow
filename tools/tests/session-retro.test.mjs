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
  suggestSessions,
  formatSuggestReport,
  sanitizeErrorSample,
  ruleForRepeat,
  isServiceOrReadonlyCommand,
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
test("suggestSessions aggregates repeating bash commands and rules across sessions", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-suggest-cmd-"));
  try {
    // Session 1: npm test repeated 3 times
    writeSession(tmp, "s1.jsonl", [
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);
    // Session 2: npm test repeated 3 times
    writeSession(tmp, "s2.jsonl", [
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);
    // Session 3: single command, no repeat
    writeSession(tmp, "s3.jsonl", [
      toolCall("bash", { command: "git status" }),
    ]);

    const suggestions = suggestSessions(tmp);
    assert.equal(suggestions.length, 1);
    const top = suggestions[0];
    assert.equal(top.repeat, "repeat-bash: npm test");
    assert.equal(top.sessions, 2);
    assert.equal(top.totalSessions, 3);
    assert.equal(top.rule, "guardrail: npm test — проверять <условие> до повтора");

    const report = formatSuggestReport(suggestions);
    assert.equal(
      report,
      "1. repeat-bash: npm test (встречается в 2 сессий из 3) → guardrail: npm test — проверять <условие> до повтора"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("suggestSessions and formatSuggestReport on empty dir return empty string", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-suggest-empty-"));
  try {
    const suggestions = suggestSessions(tmp);
    assert.deepEqual(suggestions, []);
    const report = formatSuggestReport(suggestions);
    assert.equal(report, "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("suggestSessions covers many-reads, long-session, retries/errors rule templates", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-suggest-signals-"));
  try {
    // Session 1: many reads (45 calls)
    const reads = Array.from({ length: 45 }, () => toolCall("read", { path: "a.ts:1-10" }));
    writeSession(tmp, "reads.jsonl", reads);

    // Session 2: long session (130 calls)
    const toolCalls = Array.from({ length: 130 }, () => toolCall("bash", { command: `cmd_${Math.random()}` }));
    writeSession(tmp, "long.jsonl", toolCalls);

    // Session 3: error / retry
    const failBash = {
      type: "toolCall",
      name: "bash",
      arguments: { command: "deploy.sh" },
      result: { exitCode: 1, output: "fatal error: permission denied" },
    };
    writeSession(tmp, "error.jsonl", [failBash, failBash]);

    const suggestions = suggestSessions(tmp, { limit: 5 });
    const rules = suggestions.map((s) => s.rule);

    assert.ok(rules.includes("navigate: читать <паттерн> через диапазон строк вместо полного файла"));
    assert.ok(rules.includes("compaction: разбивать задачи >N вызовов"));
    assert.ok(rules.includes("preflight: <команда> --dry-run перед выполнением"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI suggest supports empty dir, formatted output, and --json flag", () => {
  const tmp = mkdtempSync(join(tmpdir(), "retro-cli-suggest-"));
  try {
    // Empty dir returns empty stdout and exits 0
    const emptyRun = runCli(["suggest", "--sessions", tmp]);
    assert.equal(emptyRun.status, 0);
    assert.equal(emptyRun.stdout.trim(), "");

    // Add session with repeats
    writeSession(tmp, "s1.jsonl", [
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);
    writeSession(tmp, "s2.jsonl", [
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);

    const reportRun = runCli(["suggest", "--sessions", tmp]);
    assert.equal(reportRun.status, 0);
    assert.match(reportRun.stdout, /1\. repeat-bash: npm test \(встречается в 2 сессий из 2\)/);

    const jsonRun = runCli(["suggest", "--sessions", tmp, "--json"]);
    assert.equal(jsonRun.status, 0);
    const parsed = JSON.parse(jsonRun.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].sessions, 2);
    assert.equal(parsed[0].totalSessions, 2);

    const helpRun = runCli(["--help"]);
    assert.equal(helpRun.status, 0);
    assert.match(helpRun.stdout, /suggest/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("sanitizeErrorSample extracts clean error text without raw JSON fragments or tails", () => {
  const jsonSample = JSON.stringify({
    type: "toolResult",
    name: "bash",
    result: { exitCode: 1, output: "fatal: not a git repository (or any of the parent directories): .git" },
  });
  const cleaned = sanitizeErrorSample(jsonSample);
  assert.equal(cleaned, "fatal: not a git repository (or any of the parent directories): .git");
  assert.ok(!cleaned.includes("{") && !cleaned.includes("}") && !cleaned.includes('"'));

  // Truncated JSON without closing brackets
  const truncated = '{"type":"toolResult","result":{"exitCode":1,"output":"error: connection timeout after 30000ms';
  const cleanedTrunc = sanitizeErrorSample(truncated);
  assert.equal(cleanedTrunc, "error: connection timeout after 30000ms");

  // Long error truncated to <= 80 characters with no trailing quotes or punctuation
  const longError = JSON.stringify({
    error: { message: "very long error message that repeats over and over and exceeds the eighty character limit easily" },
  });
  const cleanedLong = sanitizeErrorSample(longError);
  assert.ok(cleanedLong.length <= 80);
  assert.ok(!cleanedLong.endsWith('"') && !cleanedLong.endsWith(",") && !cleanedLong.endsWith(":"));
});

test("ruleForRepeat many-reads returns clean navigate template without <уж>", () => {
  const rule = ruleForRepeat("many-reads");
  assert.equal(rule, "navigate: читать <паттерн> через диапазон строк вместо полного файла");
  assert.ok(!rule.includes("<уж>"));
});

test("suggestSessions ignores service and readonly commands in stop-list", () => {
  assert.ok(isServiceOrReadonlyCommand("git status"));
  assert.ok(isServiceOrReadonlyCommand("git status --short"));
  assert.ok(isServiceOrReadonlyCommand("git diff HEAD~1"));
  assert.ok(isServiceOrReadonlyCommand("git log -n 5"));
  assert.ok(isServiceOrReadonlyCommand("ls -la"));
  assert.ok(isServiceOrReadonlyCommand("pwd"));
  assert.ok(!isServiceOrReadonlyCommand("npm test"));
  assert.ok(!isServiceOrReadonlyCommand("cargo build"));

  const tmp = mkdtempSync(join(tmpdir(), "retro-stoplist-"));
  try {
    // Both sessions repeat git status and ls 5 times, but run npm test 3 times
    writeSession(tmp, "s1.jsonl", [
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "ls -la" }),
      toolCall("bash", { command: "ls -la" }),
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);
    writeSession(tmp, "s2.jsonl", [
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "git status" }),
      toolCall("bash", { command: "pwd" }),
      toolCall("bash", { command: "pwd" }),
      toolCall("bash", { command: "npm test" }),
      toolCall("bash", { command: "npm test" }),
    ]);

    const suggestions = suggestSessions(tmp);
    const repeats = suggestions.map((s) => s.repeat);

    // git status, ls, pwd must NOT be in repeat suggestions
    assert.ok(!repeats.some((r) => r.includes("git status")));
    assert.ok(!repeats.some((r) => r.includes("ls")));
    assert.ok(!repeats.some((r) => r.includes("pwd")));

    // npm test must be suggested
    assert.ok(repeats.includes("repeat-bash: npm test"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
