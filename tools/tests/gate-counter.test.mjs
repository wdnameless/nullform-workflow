import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  recordGate,
  readGateCounts,
  tallyCounts,
  formatTally,
} from "../gate-counter.mjs";
import { createTempDir } from "./test-helpers.mjs";

const CLI_PATH = fileURLToPath(new URL("../gate-counter.mjs", import.meta.url));

test("recordGate appends valid JSONL record to temporary file", () => {
  const tmp = createTempDir("gate-counter-test-");
  try {
    const file = join(tmp, "gate-counts.jsonl");
    const entry = recordGate({
      gate: "workflow-check",
      role: "fixer",
      result: "pass",
      file,
    });

    assert.equal(entry.gate, "workflow-check");
    assert.equal(entry.role, "fixer");
    assert.equal(entry.result, "pass");
    assert.ok(entry.t && typeof entry.t === "string");

    assert.ok(existsSync(file));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, entry);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recordGate handles optional role (omitted when not supplied)", () => {
  const tmp = createTempDir("gate-counter-test-");
  try {
    const file = join(tmp, "gate-counts.jsonl");
    const entry = recordGate({
      gate: "code-size",
      result: 0,
      file,
    });

    assert.equal(entry.gate, "code-size");
    assert.equal(entry.role, undefined);
    assert.equal(entry.result, 0);

    const rows = readGateCounts(file);
    assert.equal(rows.length, 1);
    assert.equal("role" in rows[0], false);
    assert.equal(rows[0].gate, "code-size");
    assert.equal(rows[0].result, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recordGate appends multiple entries and increments tally", () => {
  const tmp = createTempDir("gate-counter-test-");
  try {
    const file = join(tmp, "gate-counts.jsonl");
    recordGate({ gate: "workflow-check", role: "fixer", result: "ok", file });
    recordGate({ gate: "workflow-check", role: "reviewer", result: "ok", file });
    recordGate({ gate: "workflow-close", role: "oracle", result: "fail", file });

    const rows = readGateCounts(file);
    assert.equal(rows.length, 3);

    const tally = tallyCounts(rows);
    assert.equal(tally.total, 3);
    assert.equal(tally.byGate["workflow-check"], 2);
    assert.equal(tally.byGate["workflow-close"], 1);
    assert.equal(tally.byRole["fixer"], 1);
    assert.equal(tally.byRole["reviewer"], 1);
    assert.equal(tally.byRole["oracle"], 1);
    assert.equal(tally.byResult["ok"], 2);
    assert.equal(tally.byResult["fail"], 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatTally formats summary readable output", () => {
  const empty = formatTally({ total: 0, byGate: {}, byRole: {}, byResult: {} });
  assert.match(empty, /0 recorded/);

  const summary = {
    total: 2,
    byGate: { "workflow-check": 2 },
    byRole: { fixer: 2 },
    byResult: { ok: 2 },
  };
  const text = formatTally(summary);
  assert.match(text, /total: 2/);
  assert.match(text, /workflow-check: 2/);
  assert.match(text, /fixer: 2/);
});

test("CLI tally prints summary to stdout", () => {
  const tmp = createTempDir("gate-counter-cli-");
  try {
    const file = join(tmp, "counts.jsonl");
    recordGate({ gate: "quality", role: "fixer", result: "ok", file });
    recordGate({ gate: "quality", role: "fixer", result: "ok", file });

    const res = spawnSync(process.execPath, [CLI_PATH, "tally", "--file", file], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Gate counts summary \(total: 2\)/);
    assert.match(res.stdout, /quality: 2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI tally --json prints structured JSON summary", () => {
  const tmp = createTempDir("gate-counter-cli-json-");
  try {
    const file = join(tmp, "counts.jsonl");
    recordGate({ gate: "workflow-check", result: "ok", file });

    const res = spawnSync(process.execPath, [CLI_PATH, "tally", "--file", file, "--json"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.byGate["workflow-check"], 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI record writes an entry through CLI invocation", () => {
  const tmp = createTempDir("gate-counter-cli-record-");
  try {
    const file = join(tmp, "counts.jsonl");
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "record", "--gate", "cli-gate", "--role", "worker", "--result", "ok", "--file", file],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0);

    const rows = readGateCounts(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gate, "cli-gate");
    assert.equal(rows[0].role, "worker");
    assert.equal(rows[0].result, "ok");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("records do not leak PII or network information", () => {
  const tmp = createTempDir("gate-counter-pii-");
  try {
    const file = join(tmp, "counts.jsonl");
    const entry = recordGate({ gate: "test-gate", result: true, file });
    const keys = Object.keys(entry).sort();
    assert.deepEqual(keys, ["gate", "result", "t"]);

    // Ensure source code imports zero network modules
    const src = readFileSync(CLI_PATH, "utf8");
    assert.equal(/import.*from\s+["']node:(http|https|net|dgram|tls)["']/.test(src), false);
    assert.equal(/fetch\(/.test(src), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
