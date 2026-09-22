/**
 * tools/tests/dashboard.test.mjs — Тесты для dashboard.mjs (Nullform Workflow cockpit).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_ARTIFACTS_BY_TIER,
  scanModules,
  collectGitStats,
  collectRequirements,
  collectCritique,
  collectHistory,
  collectDashboardData,
  generateDashboardHtml,
  parseArgs,
} from "../dashboard.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../dashboard.mjs", import.meta.url)));

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "dashboard-test-"));
}

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false });
}

/** Временный git-репозиторий с одним коммитом. */
function createGitRepo() {
  const dir = createTempDir();
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.js"), "line1\nline2\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("REQUIRED_ARTIFACTS_BY_TIER: ярусы требуют разный набор артефактов", () => {
  assert.deepEqual(REQUIRED_ARTIFACTS_BY_TIER.T0, ["lane"]);
  assert.deepEqual(REQUIRED_ARTIFACTS_BY_TIER.T1, ["lane", "recon"]);
  assert.ok(REQUIRED_ARTIFACTS_BY_TIER.T2.includes("oracle"));
  assert.equal(REQUIRED_ARTIFACTS_BY_TIER.T2.length, 6);
});

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
    assert.equal(modules[0].files.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectGitStats: unstaged-правка не выдаёт себя за staged (регресс на trim porcelain)", () => {
  const dir = createGitRepo();
  try {
    // 1. Правка без индексации: porcelain = " M path" — ведущий пробел значим
    writeFileSync(join(dir, "a.js"), "line1\nline2\nline3\n", "utf8");
    const unstaged = collectGitStats(dir);
    assert.equal(unstaged.isRepo, true);
    assert.equal(unstaged.staged, 0, "unstaged-правка не должна считаться staged");
    assert.equal(unstaged.unstaged, 1);
    assert.equal(unstaged.files.length, 1);
    assert.equal(unstaged.files[0].added, 1);

    // 2. После git add — уже staged
    git(dir, ["add", "a.js"]);
    const staged = collectGitStats(dir);
    assert.equal(staged.staged, 1);
    assert.equal(staged.unstaged, 0);

    // 3. Untracked-файл
    writeFileSync(join(dir, "new.js"), "x\n", "utf8");
    const withUntracked = collectGitStats(dir);
    assert.equal(withUntracked.untracked, 1);
    assert.ok(withUntracked.files.some((f) => f.status === "untracked"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectGitStats: не-git каталог не падает и честно сообщает isRepo=false", () => {
  const tmp = createTempDir();
  try {
    const stats = collectGitStats(tmp);
    assert.equal(stats.isRepo, false);
    assert.equal(stats.branch, null);
    assert.deepEqual(stats.files, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectRequirements: парсит R##-таблицу манифеста и статусы", () => {
  const tmp = createTempDir();
  try {
    const changeDir = join(tmp, "openspec", "changes", "feat-x");
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(
      join(changeDir, "manifest.md"),
      [
        "# Requirements",
        "",
        "| ID | Verbatim requirement | Acceptance | Status |",
        "|---|---|---|---|",
        "| R01 | «первое требование» | Проверка первая | done |",
        "| R02 | «второе требование» | Проверка вторая | in-spec |",
        "| R03 | «третье требование» | Проверка третья | deferred |",
        "",
      ].join("\n"),
      "utf8"
    );

    const reqs = collectRequirements(tmp);
    assert.equal(reqs.total, 3);
    assert.equal(reqs.change, "feat-x");
    assert.equal(reqs.byStatus.done, 1);
    assert.equal(reqs.byStatus["in-spec"], 1);
    assert.equal(reqs.byStatus.deferred, 1);
    assert.equal(reqs.items[0].id, "R01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCritique: распознаёт вердикты оракула по changes/*/oracle.md", () => {
  const tmp = createTempDir();
  try {
    const changesDir = join(tmp, "openspec", "changes");
    mkdirSync(join(changesDir, "feat-ok"), { recursive: true });
    mkdirSync(join(changesDir, "feat-bad"), { recursive: true });
    writeFileSync(join(changesDir, "feat-ok", "oracle.md"), "## Verdict\nACCEPT\nCONCERN: minor\n", "utf8");
    writeFileSync(join(changesDir, "feat-bad", "oracle.md"), "## Verdict\nREJECT\nBLOCKER: broken\n", "utf8");

    const critique = collectCritique(tmp);
    assert.equal(critique.verdicts.length, 2);
    const ok = critique.verdicts.find((v) => v.change === "feat-ok");
    const bad = critique.verdicts.find((v) => v.change === "feat-bad");
    assert.equal(ok.verdict, "accept");
    assert.equal(bad.verdict, "reject");
    assert.ok(bad.blockers >= 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectHistory: считает медиану и разбивку по ярусам из metrics.jsonl", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    const rows = [
      { task: "a", tier: "T1", durationMs: 1000 },
      { task: "b", tier: "T1", durationMs: 3000 },
      { task: "c", tier: "T2", durationMs: 5000 },
      "не json",
    ];
    writeFileSync(
      join(wfDir, "metrics.jsonl"),
      rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"),
      "utf8"
    );

    const hist = collectHistory(tmp);
    assert.equal(hist.total, 3);
    assert.equal(hist.medianMs, 3000);
    assert.equal(hist.byTier.T1, 2);
    assert.equal(hist.byTier.T2, 1);
    assert.equal(hist.recent.length, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectDashboardData: стадии вне яруса помечаются skipped, а не pending", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({
        tier: "T1",
        task: "Малая задача",
        status: "closed",
        startedAt: "2026-09-22T00:00:00.000Z",
        closedAt: "2026-09-22T00:10:00.000Z",
        artifacts: {
          lane: { at: "2026-09-22T00:00:00.000Z", detail: "T1" },
          recon: { at: "2026-09-22T00:05:00.000Z", detail: "done" },
        },
      }),
      "utf8"
    );

    const data = collectDashboardData(tmp);
    const byId = Object.fromEntries(data.stages.map((s) => [s.id, s.status]));

    assert.equal(byId.lane, "done");
    assert.equal(byId.recon, "done");
    assert.equal(byId.manifest, "skipped", "манифест не требуется ярусом T1");
    assert.equal(byId.oracle, "skipped");
    assert.equal(byId.closed, "done");

    assert.equal(data.progress.percent, 100);
    assert.equal(data.progress.stagesRequired, 2);
    assert.equal(data.progress.artifactsDone, 2);
    assert.ok(data.progress.stagesSkipped >= 4);

    assert.equal(data.timing.remainingMin, null, "для закрытой задачи оценка остатка не выдумывается");
    assert.equal(data.currentStage.name, "Задача закрыта");
    assert.ok(data.stages.find((s) => s.id === "recon").durationMs === 300000, "тайминг этапа берётся из меток артефактов");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generateDashboardHtml: содержит ключевые секции дашборда", () => {
  const mock = {
    timestamp: new Date().toISOString(),
    root: "/tmp/x",
    project: { name: "demo", branch: "main", commit: { hash: "abc1234", message: "msg", when: "now" } },
    task: { title: "Demo task", tier: "T2", status: "open", startedAt: new Date().toISOString(), elapsedMs: 1000, budget: 45 },
    progress: { percent: 42, stagesDone: 2, stagesRequired: 6, stagesSkipped: 0, artifactsDone: 2, artifactsTotal: 6 },
    stages: [{ id: "lane", name: "Ярус и постановка", wave: 0, status: "done", detail: "T2" }],
    currentStage: { name: "Разведка и контекст", wave: 1, detail: "" },
    timing: { elapsedMs: 1000, remainingMin: 5, remainingMax: 12, medianTaskMs: 60000 },
    metrics: {
      briefCoverage: 50,
      requirements: { total: 2, byStatus: { done: 1 }, items: [{ id: "R01" }], change: "feat-x" },
      debt: { total: 1, noTrigger: 0, items: [{ file: "a.js", line: 3, what: "w", ceiling: "c", upgrade: "u" }] },
      memory: { status: "fresh", daysSince: 1 },
      checks: null,
    },
    waves: [{ wave: 0, title: "ВОЛНА 0", stages: [], agents: [] }],
    git: { isRepo: true, branch: "main", commit: { hash: "abc1234", when: "now" }, files: [{ path: "a.js", added: 1, deleted: 0, status: "modified" }], added: 1, deleted: 0, staged: 0, unstaged: 1, untracked: 0 },
    modules: [{ name: "tools", path: "tools", fileCount: 3, totalLines: 100, files: [{ name: "tools/a.js", lines: 100 }] }],
    critique: [{ change: "feat-x", file: "oracle.md", verdict: "accept", concerns: 0, blockers: 0 }],
    history: { total: 3, medianMs: 60000, byTier: { T1: 3 }, recent: [{ task: "t", tier: "T1", durationMs: 1000, forced: false }] },
    fleet: [{ role: "@fixer", name: "Fixer", wave: 3, status: "ready" }],
  };

  const html = generateDashboardHtml(mock);
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("Nullform"), "заголовок переименован в Nullform Workflow");
  assert.ok(html.includes('class="logo"'), "логотип отрендерен");
  assert.ok(html.includes("Demo task"));
  assert.ok(html.includes("Покрытие брифа"));
  assert.ok(html.includes("Ход сборки"));
  assert.ok(html.includes("Архитектура и модули"));
  assert.ok(html.includes("Диффы (git)"));
  assert.ok(html.includes("Критика и ревью"));
  assert.ok(html.includes("Технический долг"));
  assert.ok(html.includes("Как это работает"));
  assert.ok(html.includes("/api/diff"));
  assert.ok(html.includes("data-file=\"a.js\""), "строка диффа кликабельна");
  assert.ok(html.includes("setLang"), "есть переключатель языка");
  assert.ok(html.includes("setTheme"), "есть переключатель темы");
});

test("parseArgs: валидация аргументов CLI, включая --checks и --serve", () => {
  const clean = parseArgs(["--root", "proj", "--output", "o.html", "--port", "5000", "--open", "--checks", "--serve"]);
  assert.equal(clean.root, "proj");
  assert.equal(clean.output, "o.html");
  assert.equal(clean.port, 5000);
  assert.equal(clean.open, true);
  assert.equal(clean.checks, true);
  assert.equal(clean.serve, true);
  assert.equal(clean.errors.length, 0);

  assert.ok(parseArgs(["--port", "nope"]).errors.some((e) => e.includes("--port")));
  assert.ok(parseArgs(["--bad-flag"]).errors.some((e) => e.includes("неизвестный параметр")));
});

test("CLI: --json и генерация файла дашборда работают на пустом каталоге", () => {
  const tmp = createTempDir();
  try {
    const jsonProc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--json"], { encoding: "utf8" });
    assert.equal(jsonProc.status, 0);
    const parsed = JSON.parse(jsonProc.stdout);
    assert.equal(parsed.task.status, "idle");
    assert.equal(parsed.progress.percent, 0);

    const outFile = join(tmp, "dash.html");
    const genProc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--output", outFile], { encoding: "utf8" });
    assert.equal(genProc.status, 0);
    assert.ok(readFileSync(outFile, "utf8").includes("Nullform"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
