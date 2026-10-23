import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { measureSession } from "../measure-session.mjs";
import { normalizedCost } from "../cost-snapshot.mjs";

function makeTmpDir(prefix = "p-bench-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("measure-session: детерминизм (два прогона = равно)", () => {
  const root = makeTmpDir();
  try {
    mkdirSync(join(root, ".workflow"), { recursive: true });
    writeFileSync(
      join(root, ".workflow", "state.json"),
      JSON.stringify({
        task: "deterministic-check",
        tier: "T2",
        startedAt: "2026-10-22T12:00:00.000Z",
        closedAt: "2026-10-22T12:20:00.000Z",
        tests: 12,
      }),
      "utf8"
    );

    const usageLog = [
      { role: "@orchestrator", output: 500, cacheWrite: 1000, cacheRead: 5000, ms: 1200 },
      { role: "@fixer", output: 2000, cacheWrite: 4000, cacheRead: 20000, ms: 4500, tests: 12 },
    ];

    const run1 = measureSession(root, { usageLog });
    const run2 = measureSession(root, { usageLog });

    assert.deepStrictEqual(run1, run2);
    assert.equal(run1.total, run2.total);
    assert.equal(run1.wallMs, 20 * 60 * 1000);
    assert.equal(run1.activeMs, 20 * 60 * 1000);
    assert.equal(run1.tests, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measure-session: нормировка совпадает с normalizedCost", () => {
  const sample = [
    { role: "@orchestrator", output: 450, cacheWrite: 1200, cacheRead: 6000 },
    { role: "@fixer", output: 1600, cacheWrite: 4800, cacheRead: 32000 },
    { role: "@oracle", output: 350, cacheWrite: 800, cacheRead: 4500 },
  ];

  const root = makeTmpDir();
  try {
    const res = measureSession(root, { usageLog: sample });

    let expectedTotal = 0;
    for (const item of sample) {
      const expected = normalizedCost(item, item.role);
      const measured = res.roles[item.role];
      assert.ok(measured, `Role ${item.role} should be present`);
      assert.equal(measured.units, Math.round(expected.units * 100) / 100);
      assert.equal(measured.cacheChurn, expected.cacheChurn);
      expectedTotal += expected.units;
    }

    assert.equal(res.total, Math.round(expectedTotal * 100) / 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measure-session: waits вычитаются из activeMs", () => {
  const root = makeTmpDir();
  try {
    mkdirSync(join(root, ".workflow"), { recursive: true });

    // 30 минут всего (1,800,000 ms), wait 6 минут (360,000 ms)
    writeFileSync(
      join(root, ".workflow", "state.json"),
      JSON.stringify({
        task: "waits-test",
        tier: "T2",
        startedAt: "2026-10-22T14:00:00.000Z",
        closedAt: "2026-10-22T14:30:00.000Z",
        waits: [
          {
            kind: "ask-user",
            from: "2026-10-22T14:10:00.000Z",
            to: "2026-10-22T14:16:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    const res = measureSession(root, { usageLog: [] });

    const expectedWall = 30 * 60 * 1000;
    const expectedWait = 6 * 60 * 1000;
    const expectedActive = expectedWall - expectedWait; // 24 minutes

    assert.equal(res.wallMs, expectedWall);
    assert.equal(res.activeMs, expectedActive);
    assert.equal(res.wallMs - res.activeMs, expectedWait);
    assert.equal(res.ms, expectedActive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measure-session: CLI --usage JSON работает", () => {
  const root = makeTmpDir();
  try {
    const usageFile = join(root, "usage.json");
    const usageData = [
      { role: "@orchestrator", output: 100, cacheWrite: 200, cacheRead: 1000, ms: 500 },
      { role: "@fixer", output: 400, cacheWrite: 800, cacheRead: 4000, ms: 2000, tests: 8 },
    ];
    writeFileSync(usageFile, JSON.stringify(usageData), "utf8");

    const cli = join(process.cwd(), "tools", "measure-session.mjs");
    const child = spawnSync(
      process.execPath,
      [cli, "--root", root, "--usage", usageFile, "--json"],
      { encoding: "utf8" }
    );

    assert.equal(child.status, 0, `CLI failed: ${child.stderr}`);
    const parsed = JSON.parse(child.stdout);

    assert.ok(parsed.roles["@orchestrator"]);
    assert.ok(parsed.roles["@fixer"]);
    // orchestrator: 100*5 + 200*1.25 + 1000*0.1 = 500 + 250 + 100 = 850
    // fixer: 400*5 + 800*1.25 + 4000*0.1 = 2000 + 1000 + 400 = 3400
    // total = 4250
    assert.equal(parsed.total, 4250);
    assert.equal(parsed.tests, 8);
    assert.equal(parsed.ms, parsed.activeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measure-session: читает живые metrics.jsonl и events.jsonl", () => {
  const root = makeTmpDir();
  try {
    mkdirSync(join(root, ".workflow"), { recursive: true });
    writeFileSync(
      join(root, ".workflow", "state.json"),
      JSON.stringify({ status: "open", tier: "T1", startedAt: "2026-10-23T10:00:00.000Z" }),
      "utf8"
    );
    writeFileSync(
      join(root, ".workflow", "metrics.jsonl"),
      '{"task":"a","durationMs":60000}\nnot-json\n{"task":"b","durationMs":120000}\n',
      "utf8"
    );
    writeFileSync(
      join(root, ".workflow", "events.jsonl"),
      '{"at":"2026-10-23T10:01:00.000Z","kind":"start","text":"hi"}\n',
      "utf8"
    );
    const run = measureSession(root, { usageLog: [{ role: "fixer", output: 10, cacheWrite: 20, cacheRead: 30 }] });
    assert.equal(typeof run.total, "number");
    assert.ok(run.total > 0);
    assert.equal(typeof run.wallMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
