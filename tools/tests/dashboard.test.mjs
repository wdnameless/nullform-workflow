/**
 * tools/tests/dashboard.test.mjs — Тесты для dashboard.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  scanModules,
  collectDashboardData,
  generateDashboardHtml,
  parseArgs,
} from "../dashboard.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../dashboard.mjs", import.meta.url)));

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "dashboard-test-"));
}

test("scanModules: сканирует модули репозитория и считает файлы/строки", () => {
  const tmp = createTempDir();
  try {
    const toolsDir = join(tmp, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "a.js"), "console.log(1);\nconsole.log(2);\n", "utf8");
    writeFileSync(join(toolsDir, "b.js"), "console.log(3);\n", "utf8");

    const modules = scanModules(tmp);
    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, "tools");
    assert.equal(modules[0].fileCount, 2);
    assert.equal(modules[0].totalLines, 5);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectDashboardData: агрегирует состояние задачи, этапы и метрики", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });

    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({
        task: "Build authentication flow",
        tier: "T2",
        status: "open",
        startedAt: new Date().toISOString(),
        artifacts: {
          lane: { at: new Date().toISOString() },
          recon: { at: new Date().toISOString() },
          manifest: { at: new Date().toISOString() },
        },
      }),
      "utf8"
    );

    writeFileSync(join(tmp, "DEBT-LEDGER.md"), "| defer: auth | ceiling: 100 |\n", "utf8");

    const data = collectDashboardData(tmp);
    assert.equal(data.task.title, "Build authentication flow");
    assert.equal(data.task.tier, "T2");
    assert.ok(data.progressPercent > 0);
    assert.equal(data.metrics.techDebtCount, 1);
    assert.ok(Array.isArray(data.stages));
    assert.ok(Array.isArray(data.fleet));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generateDashboardHtml: генерирует валидный автономный HTML с дашбордом", () => {
  const mockData = {
    timestamp: new Date().toISOString(),
    task: { title: "Test task", tier: "T1", startedAt: new Date().toISOString() },
    progressPercent: 65,
    stages: [{ id: "briefing", name: "Briefing", status: "done" }],
    metrics: {
      briefCoverage: 90,
      unitTestsStatus: "100 / 100 PASS",
      mutationScore: 85,
      techDebtCount: 2,
      memoryStatus: "fresh",
      memoryDaysSince: 1,
    },
    modules: [{ name: "tools", path: "tools", fileCount: 5, totalLines: 200 }],
    fleet: [{ name: "Fixer", role: "@fixer", model: "gemini", status: "active" }],
  };

  const html = generateDashboardHtml(mockData);
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("Engineering Cockpit"));
  assert.ok(html.includes("Test task"));
  assert.ok(html.includes("65%"));
  assert.ok(html.includes("live-timer"));
  assert.ok(html.includes("toggleTheme"));
});

test("parseArgs: валидация аргументов CLI", () => {
  const clean = parseArgs(["--root", "my-project", "--output", "out.html", "--port", "5000", "--open"]);
  assert.equal(clean.root, "my-project");
  assert.equal(clean.output, "out.html");
  assert.equal(clean.port, 5000);
  assert.equal(clean.open, true);
  assert.equal(clean.errors.length, 0);

  const badPort = parseArgs(["--port", "invalid"]);
  assert.ok(badPort.errors.some((e) => e.includes("--port")));

  const unknown = parseArgs(["--bad-flag"]);
  assert.ok(unknown.errors.some((e) => e.includes("неизвестный параметр")));
});

test("CLI: генерирует файл дашборда и возвращает exit code 0", () => {
  const tmp = createTempDir();
  try {
    const outFile = join(tmp, "my-dash.html");
    const proc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--output", outFile, "--json"], {
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.task.status, "idle");

    const genProc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--output", outFile], {
      encoding: "utf8",
    });
    assert.equal(genProc.status, 0);
    assert.ok(readFileSync(outFile, "utf8").includes("Engineering Cockpit"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
