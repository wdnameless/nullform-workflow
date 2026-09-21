import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdStart,
  cmdClose,
  cmdArtifact,
  cmdMetrics,
  cmdCheck,
  cmdStatus,
  loadMetrics,
  appendMetric,
  load,
  save,
} from "../workflow.mjs";

test("verify .workflow/ is present in .gitignore", () => {
  const gitignorePath = join(process.cwd(), ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    assert.ok(
      lines.includes(".workflow/"),
      "expected .gitignore to include .workflow/"
    );
  }
});

test("close appends line with all fields incl. durationMs > 0", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-close-"));
  try {
    // Start a T0 task
    const startCode = cmdStart(tmp, { tier: "T0", task: "test duration" });
    assert.equal(startCode, 0);

    // Overwrite startedAt with an earlier timestamp to ensure durationMs > 0
    const st = load(tmp);
    assert.ok(st);
    const tenSecAgo = new Date(Date.now() - 10000).toISOString();
    st.startedAt = tenSecAgo;
    save(tmp, st);

    // Close the T0 task
    const closeCode = cmdClose(tmp, {});
    assert.equal(closeCode, 0);

    const metricsPath = join(tmp, ".workflow", "metrics.jsonl");
    assert.ok(existsSync(metricsPath), "metrics.jsonl must exist after close");

    const records = loadMetrics(tmp);
    assert.equal(records.length, 1);

    const rec = records[0];
    assert.equal(rec.task, "test duration");
    assert.equal(rec.tier, "T0");
    assert.equal(rec.startedAt, tenSecAgo);
    assert.ok(rec.closedAt);
    assert.ok(typeof rec.durationMs === "number");
    assert.ok(rec.durationMs >= 10000, `durationMs should be >= 10000, got ${rec.durationMs}`);
    assert.equal(rec.forced, false);
    assert.equal(rec.auto, null);
    assert.equal(typeof rec.artifactsCount, "number");
    // lane artifact is recorded at start, so a T0 close carries exactly 1
    assert.equal(rec.artifactsCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("forced close flagged in metrics", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-forced-"));
  try {
    // T2 requires artifacts (manifest, openspec, interfaces, oracle)
    const startCode = cmdStart(tmp, { tier: "T2", task: "forced task" });
    assert.equal(startCode, 0);

    // Close without artifacts using --force and --reason
    const closeCode = cmdClose(tmp, { force: true, reason: "expedited" });
    assert.equal(closeCode, 0);

    const records = loadMetrics(tmp);
    assert.equal(records.length, 1);

    const rec = records[0];
    assert.equal(rec.task, "forced task");
    assert.equal(rec.tier, "T2");
    assert.equal(rec.forced, true);
    assert.equal(rec.artifactsCount, 1); // lane is recorded at start
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("metrics aggregates two fixtures", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-agg-"));
  try {
    appendMetric(tmp, {
      task: "first",
      tier: "T0",
      startedAt: "2026-09-17T10:00:00.000Z",
      closedAt: "2026-09-17T10:01:00.000Z",
      durationMs: 60000,
      forced: false,
      auto: null,
      artifactsCount: 0,
    });
    appendMetric(tmp, {
      task: "second",
      tier: "T2",
      startedAt: "2026-09-17T11:00:00.000Z",
      closedAt: "2026-09-17T11:03:00.000Z",
      durationMs: 180000,
      forced: true,
      auto: { maxDiff: 10 },
      artifactsCount: 2,
    });

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const code = cmdMetrics(tmp);
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    assert.match(output, /Всего задач:\s*2/);
    assert.match(output, /T0:\s*1/);
    assert.match(output, /T2:\s*1/);
    assert.match(output, /Средняя длительность:\s*120000\s*мс/);
    assert.match(output, /Медианная длительность:\s*120000\s*мс/);
    assert.match(output, /Force-закрытий:\s*1/);
    assert.match(output, /Авто-режимов:\s*1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("empty metrics prints message and exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-empty-"));
  try {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    let code;
    try {
      code = cmdMetrics(tmp);
    } finally {
      console.log = origLog;
    }

    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("задач пока нет")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reproduced defects (adversarial pass): corrupted state/metrics must not pass
// a gate, crash a read-only command, or double-count a task.
// ---------------------------------------------------------------------------

test("corrupted state.json reads as no task — check fails instead of reporting COMPLETE", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-corrupt-state-"));
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    const statePath = join(tmp, ".workflow", "state.json");

    for (const body of ['{}', "null", "[]", '{"tier":"T9","artifacts":{}}', "not json"]) {
      writeFileSync(statePath, body, "utf8");
      assert.equal(load(tmp), null, `state ${body} must not read as a task`);
      assert.equal(cmdCheck(tmp), 1, `check must fail on state ${body}, not report COMPLETE`);
      assert.equal(cmdStatus(tmp), 0, `status must survive state ${body}`);
      assert.equal(cmdClose(tmp, {}), 2, `close must refuse state ${body}`);
    }

    // A structurally valid T0 state with a non-object artifacts map still gates:
    // the lane artifact is missing, so check refuses to call it complete.
    writeFileSync(statePath, '{"tier":"T0","task":"t","artifacts":5}', "utf8");
    assert.equal(cmdCheck(tmp), 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("metrics ignores malformed and non-record JSON lines", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-bad-metrics-"));
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    writeFileSync(
      join(tmp, ".workflow", "metrics.jsonl"),
      [
        "null",
        "42",
        '"a string"',
        "[1,2]",
        "{not json",
        JSON.stringify({ task: "real", tier: "T0", durationMs: 1000, forced: false, auto: null }),
      ].join("\n") + "\n",
      "utf8"
    );

    const records = loadMetrics(tmp);
    assert.equal(records.length, 1);
    assert.equal(records[0].task, "real");

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      assert.equal(cmdMetrics(tmp), 0);
    } finally {
      console.log = origLog;
    }
    assert.match(logs.join("\n"), /Всего задач:\s*1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("close on an already closed task is refused and does not double-count metrics", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-double-close-"));
  try {
    assert.equal(cmdStart(tmp, { tier: "T0", task: "single task" }), 0);
    assert.equal(cmdClose(tmp, {}), 0);
    const afterFirst = new Date(load(tmp).closedAt).getTime();

    assert.equal(cmdClose(tmp, {}), 2, "second close must refuse");

    const records = loadMetrics(tmp);
    assert.equal(records.length, 1, "one task must produce exactly one metric");
    assert.equal(load(tmp).status, "closed");
    assert.equal(new Date(load(tmp).closedAt).getTime(), afterFirst, "closedAt must not move");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("close on a refused auto task is refused and writes no metric", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wf-test-refused-close-"));
  try {
    // Guarded auto refuses T2: the state records the refusal, not an open task.
    assert.equal(cmdStart(tmp, { tier: "T2", task: "too big", auto: true, allow: "src/**", "max-diff": "5" }), 1);
    assert.equal(load(tmp).status, "refused");

    assert.equal(cmdClose(tmp, {}), 2);
    assert.equal(existsSync(join(tmp, ".workflow", "metrics.jsonl")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
