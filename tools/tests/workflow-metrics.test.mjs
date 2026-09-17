import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdStart,
  cmdClose,
  cmdArtifact,
  cmdMetrics,
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
