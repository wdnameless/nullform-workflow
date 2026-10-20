/**
 * tools/tests/dashboard.test.mjs — Тесты для dashboard.mjs (Nullform Workflow cockpit).
 */
delete process.env.PASEO_AGENT_ID;
delete process.env.OMP_SESSION_ID;

import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_ARTIFACTS_BY_TIER,
  RUNTIME_FILE,
  runtimePath,
  readRuntime,
  writeRuntime,
  isServerAlive,
  startLiveServer,
  ensureDashboard,
  scanModules,
  collectGitStats,
  collectRequirements,
  collectCritique,
  collectHistory,
  collectDashboardData,
  generateDashboardHtml,
  parseArgs,
  DASHBOARD_PROTOCOL,
  DASHBOARD_PROTOCOL_VERSION,
  DASHBOARD_BUILD,
  projectToken,
  isAllowedHost,
  isCompatibleDashboard,
  probeDashboard,
} from "../dashboard.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../dashboard.mjs", import.meta.url)));
import { createTempDir, createGitRepo } from "./test-helpers.mjs";


function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false , windowsHide: true});
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
  assert.ok(html.includes("Nullform Console"), "свой бренд: Nullform Console");
  assert.ok(html.includes('class="brand"'), "логотип отрендерен");
  assert.ok(html.includes("Demo task"));
  assert.ok(html.includes("Покрытие брифа"));
  assert.ok(html.includes("Ход сборки"));
  assert.ok(html.includes("Как это работает"));
  // Вкладки: обзор, архитектура (майндкарта), логи, диффы, критика, долг, история
  // Вкладки описываются массивом TABS и рисуются клиентским renderRail:
  // в статическом HTML их разметки нет — проверяем описание и рендер.
  assert.ok(html.includes('{ id: "arch"') && html.includes('{ id: "logs"'), "описаны вкладки архитектуры и логов");
  assert.ok(html.includes("renderRail"), "рельс вкладок рендерится");
  assert.ok(html.includes("drawTree") && html.includes("drawGraph") && html.includes("visibleTree") && html.includes("treeLayout"), "майндкарта и граф рисуются на клиенте");
  assert.ok(html.includes("d.session.key"), "дашборд привязан к сессии");
  assert.ok(html.includes("collectSessionLog") || html.includes("d.log.entries"), "логи сессии выводятся");
  assert.ok(html.includes("/api/diff"));
  assert.ok(html.includes("data-file="), "рендер диффов делает строки кликабельными");
  assert.ok(html.includes("openDiff"), "есть модалка построчного диффа");
  assert.ok(html.includes("setLang"), "есть переключатель языка");
  assert.ok(html.includes("setTheme"), "есть переключатель темы");
  // Динамика: клиентский рендер + опрос состояния + индикатор LIVE
  assert.ok(html.includes("function render("), "страница рендерится на клиенте");
  assert.ok(html.includes("/api/state"), "есть опрос живого состояния");
  assert.ok(html.includes("POLL_MS"), "интервал опроса задан");
  assert.ok(html.includes('id="live"'), "есть индикатор LIVE");
  assert.ok(html.includes("flashChanged"), "изменения подсвечиваются");
  assert.ok(html.includes("renderOverview") && html.includes("renderLogs") && html.includes("renderDiffs") && html.includes("renderCritique"), "секции перерисовываются без перезагрузки");
});

test("parseArgs: валидация аргументов CLI, включая --checks и --serve", () => {
  const clean = parseArgs(["--root", "proj", "--output", "o.html", "--port", "5000", "--open", "--checks", "--serve", "--ensure", "--no-open"]);
  assert.equal(clean.root, "proj");
  assert.equal(clean.output, "o.html");
  assert.equal(clean.port, 5000);
  assert.equal(clean.open, true);
  assert.equal(clean.checks, true);
  assert.equal(clean.serve, true);
  assert.equal(clean.ensure, true);
  assert.equal(clean.noOpen, true);
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
    const html = readFileSync(outFile, "utf8");
    assert.ok(html.includes("<!DOCTYPE html>") || html.includes("<html"), "generated output must be HTML");
    assert.ok(html.includes("</html>"), "generated output must have closing html tag");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ live mode (автозапуск) */

test("runtime: writeRuntime/readRuntime хранят порт и pid, битый файл не ломает чтение", () => {
  const tmp = createTempDir();
  try {
    assert.equal(readRuntime(tmp), null, "без файла — null");

    const p = writeRuntime(tmp, { pid: 4242, port: 4321, url: "http://localhost:4321", root: tmp });
    assert.equal(p, runtimePath(tmp));
    assert.ok(p.endsWith("dashboard.json"));

    const back = readRuntime(tmp);
    assert.equal(back.port, 4321);
    assert.equal(back.pid, 4242);

    writeFileSync(join(tmp, RUNTIME_FILE), "{ это не json", "utf8");
    assert.equal(readRuntime(tmp), null, "битый рантайм-файл читается как «нет дашборда»");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("live: сервер отвечает на /api/health и /api/state, затем освобождает порт", async () => {
  const tmp = createTempDir();
  let bound = null;
  try {
    writeFileSync(join(tmp, "state.json"), "{}", "utf8");
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({ tier: "T1", task: "live test", status: "open", startedAt: new Date().toISOString(), artifacts: { lane: { at: new Date().toISOString() } } }),
      "utf8"
    );

    bound = await startLiveServer(tmp, 4399, { maxAttempts: 5 });
    assert.ok(bound.port >= 4399, "сервер занял порт из диапазона");
    assert.equal(await isServerAlive(bound.port), true, "health-пинг подтверждает живость");

    const stateRes = await fetch(`http://127.0.0.1:${bound.port}/api/state`);
    const state = await stateRes.json();
    assert.equal(state.task.title, "Задача T1");
    assert.equal(state.task.tier, "T1");

    const htmlRes = await fetch(`http://127.0.0.1:${bound.port}/`);
    const html = await htmlRes.text();
    assert.ok(html.includes("Nullform Console"));
  } finally {
    if (bound) {
      await new Promise((r) => bound.server.close(r));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureDashboard: поднимает фоновый сервер, пишет рантайм и переиспользует его", async () => {
  const tmp = createTempDir();
  let info = null;
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    info = await ensureDashboard(tmp, { open: false, port: 4410 });
    assert.ok(info.url, `ожидали живой URL, получили: ${JSON.stringify(info)}`);
    assert.equal(info.started, true);

    const recorded = readRuntime(tmp);
    assert.equal(recorded.port, info.port);

    // Повторный вызов переиспользует уже поднятый сервер, а не плодит новый
    const again = await ensureDashboard(tmp, { open: false, port: 4410 });
    assert.equal(again.started, false);
    assert.equal(again.port, info.port);
  } finally {
    if (info && info.port) {
      const rec = readRuntime(tmp);
      if (rec && rec.pid) {
        try { process.kill(rec.pid); } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("generateDashboardHtml: клиентский скрипт синтаксически валиден (регресс на съеденные экранирования)", () => {
  const mock = {
    timestamp: new Date().toISOString(),
    root: "/tmp/x",
    project: { name: "demo", branch: "main", commit: { hash: "abc", message: "m", when: "now" } },
    task: { title: "T", tier: "T1", status: "open", startedAt: new Date().toISOString(), elapsedMs: 0, budget: 25 },
    progress: { percent: 10, stagesDone: 1, stagesRequired: 2, stagesSkipped: 0, artifactsDone: 1, artifactsTotal: 2 },
    stages: [{ id: "lane", name: "Ярус", wave: 0, status: "done", detail: "T1" }],
    currentStage: { name: "Разведка", wave: 1, detail: "" },
    timing: { elapsedMs: 0, remainingMin: 1, remainingMax: 2, medianTaskMs: 0 },
    metrics: {
      briefCoverage: 0,
      requirements: { total: 0, byStatus: {}, items: [], change: null },
      debt: { total: 0, noTrigger: 0, items: [] },
      memory: { status: "fresh", daysSince: 0 },
      checks: null,
    },
    waves: [{ wave: 0, title: "ВОЛНА 0", stages: [], agents: [] }],
    git: { isRepo: true, branch: "main", commit: { hash: "abc", when: "now" }, files: [], added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0 },
    modules: [{ name: "tools", path: "tools", fileCount: 1, totalLines: 10, files: [{ name: "tools/a.js", lines: 10 }] }],
    critique: [],
    history: { total: 0, medianMs: 0, byTier: {}, recent: [] },
    fleet: [],
  };

  const html = generateDashboardHtml(mock);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "в странице есть клиентский скрипт");
  // Парсим без выполнения: любая съеденная кавычка/экранирование ловится здесь.
  assert.doesNotThrow(() => new Function(match[1]), "клиентский JS должен парситься браузером");
  assert.ok(match[1].includes('class="mono"'), "классы в шаблонах рендера не искажены");
});

test("ensureDashboard: осиротевший демон усыновляется, а не плодит второй сервер", async () => {
  const tmp = createTempDir();
  let bound = null;
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    // Демон жив, но рантайм-файл потерян — как после ручной чистки .workflow
    bound = await startLiveServer(tmp, 4430, { maxAttempts: 5 });
    assert.equal(readRuntime(tmp), null, "рантайм-файла нет — сирота");

    const info = await ensureDashboard(tmp, { open: false, port: 4430 });
    assert.equal(info.port, bound.port, "усыновили тот же порт, второго сервера нет");
    assert.equal(info.started, false);
    assert.equal(info.adopted, true);

    const rec = readRuntime(tmp);
    assert.equal(rec.port, bound.port);
    assert.equal(rec.adopted, true);
  } finally {
    if (bound) await new Promise((r) => bound.server.close(r));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/* ---------------------------------------------- regressions (bug sweep) */

test("dashboard: история отдаёт medianMs, а не medianTaskMs (регресс на поле-призрак)", () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    const rows = [
      { task: "a", tier: "T1", durationMs: 1000 },
      { task: "b", tier: "T1", durationMs: 5000 },
      { task: "c", tier: "T2", durationMs: 9000 },
    ];
    writeFileSync(join(tmp, ".workflow", "metrics.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");

    const data = collectDashboardData(tmp);
    assert.equal(data.history.medianMs, 5000, "медиана считается");
    assert.equal(data.history.medianTaskMs, undefined, "поля-призрака быть не должно");
    assert.equal(data.timing.medianTaskMs, 5000, "карточка времени берёт медиану из timing");

    // Клиентский рендер читает именно history.medianMs — иначе показывал «—»
    const html = generateDashboardHtml(data);
    assert.ok(html.includes("d.history.medianMs"), "история использует существующее поле");
    assert.ok(!html.includes("d.history.medianTaskMs"), "поле-призрак не читается");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dashboard: индекс таска в волне ищется по id (JSON-раундтрип ломает ссылки)", () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    writeFileSync(
      join(tmp, ".workflow", "state.json"),
      JSON.stringify({
        tier: "T2",
        task: "wave idx",
        status: "open",
        startedAt: new Date().toISOString(),
        artifacts: { lane: { at: new Date().toISOString(), detail: "T2" }, recon: { at: new Date().toISOString() } },
      }),
      "utf8"
    );

    const data = collectDashboardData(tmp);
    // Клиент получает данные через JSON: stages и waves.stages — разные объекты.
    const roundTripped = JSON.parse(JSON.stringify(data));
    const waveStage = roundTripped.waves.find((w) => w.stages.length > 0).stages[0];
    assert.equal(
      roundTripped.stages.indexOf(waveStage),
      -1,
      "после JSON.parse ссылочное равенство теряется — значит indexOf не годится"
    );

    const html = generateDashboardHtml(data);
    assert.ok(html.includes("findIndex(function (x) { return x.id === s.id; })"), "индекс ищется по id");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dashboard: шрифты и медиа не вытесняют исходники из списка файлов модуля", () => {
  const tmp = createTempDir();
  try {
    const dir = join(tmp, "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "huge.ttf"), "x".repeat(100) + "\n".repeat(500), "utf8");
    writeFileSync(join(dir, "photo.png"), "y".repeat(100) + "\n".repeat(400), "utf8");
    writeFileSync(join(dir, "code.mjs"), "line\n".repeat(50), "utf8");

    const modules = scanModules(tmp);
    const skills = modules.find((m) => m.name === "skills");
    assert.ok(skills, "модуль найден");
    assert.equal(skills.files[0].name.endsWith("code.mjs"), true, "первым идёт исходник, а не шрифт");
    assert.ok(skills.fileCount === 3, "бинарные файлы всё ещё посчитаны в общем числе");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dashboard: в клиентском скрипте нет ссылок на несуществующие функции рендера', () => {
  const html = generateDashboardHtml({
    project: { name: 'x' }, task: { title: 't', tier: 'T1', status: 'open' },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 },
    stages: [], waves: [], currentStage: {}, timing: {}, metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { isRepo: false, files: [] }, session: {}, arch: { children: [] }, archGraph: { nodes: [], edges: [] },
    history: { recent: [], byTier: {} }, critique: [], log: { entries: [] }, events: [], fleet: [],
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // Каждое имя вида draw*(...) и render*(...) должно быть объявлено в скрипте
  const declared = new Set([...script.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  [...script.matchAll(/\b(draw[A-Z]\w*|render[A-Z]\w*)\s*\(/g)].forEach(m => {
    assert.ok(declared.has(m[1]), 'вызов ' + m[1] + '() без объявления — устаревшая ссылка');
  });
});

test("CLI: неверный порт завершает процесс с кодом 2, а не с нулём (регресс на async main)", () => {
  const tmp = createTempDir();
  try {
    const proc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--port", "99999"], { encoding: "utf8" });
    assert.equal(proc.status, 2, "код возврата main() должен доходить до process.exit");
    assert.ok(proc.stderr.includes("--port"), "пользователь видит причину");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R05: HTTP-границы (/, /api/state, /api/diff) не отдают чувствительные свободные данные, сохраняя метаданные", async () => {
  const tmp = createTempDir();
  let bound = null;
  try {
    git(tmp, ["init", "-q"]);
    git(tmp, ["config", "user.name", "Workflow Tester"]);
    git(tmp, ["config", "user.email", "workflow@nullform.io"]);

    const MARKER_TASK = "TASK_LEAK_SECRET_9911";
    const MARKER_ORACLE = "ORACLE_DETAIL_SECRET_8822";
    const MARKER_COMMIT = "COMMIT_SUBJECT_SECRET_7733";
    const MARKER_EVENT = "EVENT_TEXT_SECRET_6644";
    const MARKER_DIFF_PATCH = "PATCH_LINE_SECRET_4466";
    const MARKER_DIFF_QUERY = "ARBITRARY_DIFF_QUERY_PARAM_3322";

    const testFile = join(tmp, "service.js");
    writeFileSync(testFile, "const initial = 1;\n", "utf8");
    git(tmp, ["add", "service.js"]);
    git(tmp, ["commit", "-q", "-m", `init ${MARKER_COMMIT}`]);

    writeFileSync(testFile, `const initial = 1;\nconst secret = "${MARKER_DIFF_PATCH}";\n`, "utf8");

    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({
        tier: "T2",
        task: `Secret Task: ${MARKER_TASK}`,
        status: "open",
        startedAt: new Date().toISOString(),
        artifacts: {
          lane: { at: new Date().toISOString(), detail: "T2" },
          recon: { at: new Date().toISOString(), detail: `recon detail ${MARKER_ORACLE}` },
        },
      }),
      "utf8"
    );

    // Создаём файл оракула с маркером
    const oracleDir = join(tmp, "openspec", "changes", "feat-1");
    mkdirSync(oracleDir, { recursive: true });
    writeFileSync(
      join(oracleDir, "oracle.md"),
      `# Oracle Verdict\n\nACCEPT\n\nNotes with ${MARKER_ORACLE}\n`,
      "utf8"
    );

    writeFileSync(
      join(wfDir, "events.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        kind: "artifact",
        text: `recon: detail with ${MARKER_EVENT}`,
      }) + "\n",
      "utf8"
    );

    bound = await startLiveServer(tmp, 4520, { maxAttempts: 10 });
    const port = bound.port;

    // --- 0. /api/health ---
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    const healthRaw = await healthRes.text();
    assert.ok(!healthRaw.includes(tmp), "api/health не должен раскрывать абсолютный путь root");
    const health = JSON.parse(healthRaw);
    assert.equal(health.ok, true);
    assert.equal(health.root, undefined, "поле root удалено из ответа /api/health");
    assert.ok(typeof health.project === "string" && health.project.length >= 8);

    // --- 1. /api/state ---
    const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
    const stateRaw = await stateRes.text();

    assert.ok(!stateRaw.includes(MARKER_TASK), "api/state не должен содержать state.task");
    assert.ok(!stateRaw.includes(MARKER_ORACLE), "api/state не должен содержать детали оракула / артефактов");
    assert.ok(!stateRaw.includes(MARKER_COMMIT), "api/state не должен содержать тему коммита");
    assert.ok(!stateRaw.includes(MARKER_EVENT), "api/state не должен содержать свободный текст событий");
    assert.ok(!stateRaw.includes(MARKER_DIFF_PATCH), "api/state не должен содержать сырой патч");
    assert.ok(!stateRaw.includes(tmp), "api/state не должен содержать абсолютный путь root");
    const state = JSON.parse(stateRaw);
    assert.equal(state.task.tier, "T2");
    assert.equal(state.task.title, "Задача T2", "заголовок задачи проецируется в безопасную форму");
    assert.equal(state.task.status, "open");
    assert.equal(state.git.isRepo, true);
    assert.ok(state.git.branch, "ветка репозитория сохранена");
    assert.equal(state.git.commit.message, undefined, "тема коммита удалена из git.commit");
    assert.equal(state.git.files[0].path, "service.js", "пути файлов в diff-селекторе сохранены для навигации");
    assert.ok(state.git.added > 0);
    assert.ok(state.arch && state.arch.name, "архитектурное дерево доступно");
    assert.ok(Array.isArray(state.modules), "список модулей доступен");
    // Регресс: Схема архитектуры не должна терять fileCount и показывать "файлов 0"
    const totalModuleFiles = state.modules.reduce((s, m) => s + m.fileCount, 0);
    assert.equal(state.arch.files, totalModuleFiles, "количество файлов в корне схемы совпадает с суммой по модулям");
    for (const child of state.arch.children || []) {
      const mod = state.modules.find((m) => m.path === child.name);
      if (mod) {
        assert.equal(child.files, mod.fileCount, `файлы в узле схемы ${child.name} совпадают с модулем`);
      }
      const graphNode = state.archGraph.nodes.find((n) => n.id === child.name);
      if (graphNode) {
        assert.equal(child.files, graphNode.files, `файлы в узле схемы ${child.name} совпадают с графом`);
      }
    }
    assert.equal(state.events[0].kind, "artifact");
    assert.equal(state.events[0].status, "recon");
    // --- 2. / (HTML) ---
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    const htmlRaw = await htmlRes.text();

    assert.ok(!htmlRaw.includes(MARKER_TASK), "HTML не должен содержать state.task");
    assert.ok(!htmlRaw.includes(MARKER_ORACLE), "HTML не должен содержать детали оракула / артефактов");
    assert.ok(!htmlRaw.includes(MARKER_COMMIT), "HTML не должен содержать тему коммита");
    assert.ok(!htmlRaw.includes(MARKER_EVENT), "HTML не должен содержать свободный текст событий");
    assert.ok(!htmlRaw.includes(MARKER_DIFF_PATCH), "HTML не должен содержать сырой патч");
    assert.ok(!htmlRaw.includes(tmp), "HTML не должен содержать абсолютный путь root");
    assert.ok(htmlRaw.includes("Nullform Console"), "HTML каркас консоли сохранен");
    assert.ok(htmlRaw.includes("Задача T2"), "HTML содержит безопасный заголовок");
    assert.ok(htmlRaw.includes("service.js"), "HTML содержит путь файла в diff-списке");
    assert.ok(htmlRaw.includes("data-file="), "HTML сохраняет кликабельность diff-строк");
    // --- 3. /api/diff ---
    const diffRes = await fetch(`http://127.0.0.1:${port}/api/diff?file=${encodeURIComponent(MARKER_DIFF_QUERY)}`);
    const diffRaw = await diffRes.text();

    assert.ok(!diffRaw.includes(MARKER_DIFF_QUERY), "api/diff не должен эхо-повторять путь файла из запроса");
    assert.ok(!diffRaw.includes(MARKER_DIFF_PATCH), "api/diff не должен содержать сырой патч");

    const validDiffRes = await fetch(`http://127.0.0.1:${port}/api/diff?file=service.js`);
    const validDiffRaw = await validDiffRes.text();
    assert.ok(!validDiffRaw.includes(MARKER_DIFF_PATCH), "api/diff для существующего файла не раскрывает патч");
    assert.ok(validDiffRaw.includes("+ добавлено строк: 1"), "api/diff возвращает счетчик добавленных строк");
    assert.ok(validDiffRaw.includes("- удалено строк: 0"), "api/diff возвращает счетчик удаленных строк");
  } finally {
    if (bound) {
      await new Promise((r) => bound.server.close(r));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- R01, R15 regressions */
function requestWithHost(port, path, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("R15: HTTP-маршруты отклоняют не-loopback Host (включая DNS-rebind) и принимают localhost/127.0.0.1", async () => {
  const tmp = createTempDir();
  let bound = null;
  try {
    writeFileSync(join(tmp, "state.json"), "{}", "utf8");
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({ tier: "T1", task: "host test", status: "open", startedAt: new Date().toISOString(), artifacts: { lane: { at: new Date().toISOString() } } }),
      "utf8"
    );

    bound = await startLiveServer(tmp, 4560, { maxAttempts: 10 });
    const port = bound.port;

    // Unit-проверка функции isAllowedHost
    assert.equal(isAllowedHost("localhost"), true);
    assert.equal(isAllowedHost(`localhost:${port}`), true);
    assert.equal(isAllowedHost("127.0.0.1"), true);
    assert.equal(isAllowedHost(`127.0.0.1:${port}`), true);
    assert.equal(isAllowedHost(`[::1]:${port}`), true);
    assert.equal(isAllowedHost("attacker.example"), false);
    assert.equal(isAllowedHost(`attacker.example:${port}`), false);
    assert.equal(isAllowedHost("rebind.evil.com"), false);
    assert.equal(isAllowedHost("localhost.attacker.com"), false);
    assert.equal(isAllowedHost("192.168.1.5"), false);
    assert.equal(isAllowedHost(""), false);
    assert.equal(isAllowedHost(null), false);

    const routes = ["/api/health", "/api/state", "/api/diff", "/"];
    const hostileHosts = ["attacker.example", `attacker.example:${port}`, "rebind.evil.com", "192.168.1.100"];

    for (const route of routes) {
      for (const hostile of hostileHosts) {
        const res = await requestWithHost(port, route, hostile);
        assert.equal(res.status, 403, `маршрут ${route} с Host: ${hostile} должен возвращать 403`);
        assert.equal(res.ok, false);
      }

      // Легитимный localhost / 127.0.0.1
      const resLocalhost = await requestWithHost(port, route, `localhost:${port}`);
      assert.equal(resLocalhost.status, 200, `маршрут ${route} с Host: localhost:${port} должен быть успешен`);

      const resLoopback = await requestWithHost(port, route, `127.0.0.1:${port}`);
      assert.equal(resLoopback.status, 200, `маршрут ${route} с Host: 127.0.0.1:${port} должен быть успешен`);
    }
  } finally {
    if (bound) await new Promise((r) => bound.server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R01: устаревший протокол здоровья ({ok, pid, root}) и чужой проект отвергаются fast path и orphan scan без убийства процесса", async () => {
  const tmp = createTempDir();
  let legacyServer = null;
  let wrongProjectServer = null;
  let boundCurrent = null;
  const legacyPort = 4680;
  const wrongPort = 4681;
  const validPort = 4682;

  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    // Синтетический старый сервер (legacy process shape: { ok: true, pid: 7688, root })
    legacyServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, pid: 7688, root: tmp }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("legacy");
    });
    await new Promise((resolve) => legacyServer.listen(legacyPort, "127.0.0.1", resolve));

    // Синтетический сервер с другим проектом
    wrongProjectServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          pid: 9999,
          project: "foreign_token_123",
          protocol: DASHBOARD_PROTOCOL,
          protocolVersion: DASHBOARD_PROTOCOL_VERSION,
          build: DASHBOARD_BUILD,
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("wrong project");
    });
    await new Promise((resolve) => wrongProjectServer.listen(wrongPort, "127.0.0.1", resolve));

    // 1. Проверка compatibility helper
    const probedLegacy = await probeDashboard(legacyPort);
    assert.equal(isCompatibleDashboard(probedLegacy, tmp), false, "старая форма {ok, pid, root} несовместима");

    const probedWrong = await probeDashboard(wrongPort);
    assert.equal(isCompatibleDashboard(probedWrong, tmp), false, "чужой project несовместим");

    // 2. Fast path: рантайм-файл указывает на legacyPort
    writeRuntime(tmp, {
      key: "local",
      port: legacyPort,
      pid: 7688,
      url: `http://localhost:${legacyPort}`,
      root: tmp,
      startedAt: new Date().toISOString(),
    });

    // ensureDashboard должен отказать в переиспользовании legacyPort
    // и поднять текущий дашборд на свободном порту, обновив маркер
    boundCurrent = await startLiveServer(tmp, validPort, { maxAttempts: 5 });
    assert.ok(boundCurrent.port >= validPort);
    const probedCurrent = await probeDashboard(boundCurrent.port);
    assert.equal(isCompatibleDashboard(probedCurrent, tmp), true, "текущий сервер совместим");

    // Вызов ensureDashboard при наличии несовместимого рантайма:
    // должен отказать в fast path и усыновить совместимый orphan сервер boundCurrent на validPort
    const info = await ensureDashboard(tmp, { open: false, port: legacyPort, session: "local" });
    assert.equal(info.port, boundCurrent.port, "переиспользован совместимый порт, а не старый");
    assert.notEqual(info.port, legacyPort, "legacyPort не был переиспользован");
    // Проверяем, что не верифицированный legacyServer не был убит и продолжает слушать
    assert.equal(legacyServer.listening, true, "старый сервер не завершён");
    const checkLegacy = await probeDashboard(legacyPort);
    assert.equal(checkLegacy?.pid, 7688, "старый процесс по-прежнему отвечает");

    // Маркер в рантайме обновлен на порт актуального сервера
    const marker = readRuntime(tmp, "local");
    assert.equal(marker.port, boundCurrent.port, "маркер обновлен на порт актуального сервера");

    // 3. Orphan scan: удаляем рантайм, сканируем диапазон, начинающийся с legacyPort
    rmSync(runtimePath(tmp, "local"), { force: true });
    rmSync(runtimePath(tmp), { force: true });
    assert.equal(readRuntime(tmp), null);

    const orphanInfo = await ensureDashboard(tmp, { open: false, port: legacyPort, session: "local" });
    assert.equal(orphanInfo.port, boundCurrent.port, "сирота усыновлена только с валидного порта");
    assert.equal(orphanInfo.adopted, true);
    assert.equal(legacyServer.listening, true, "legacyServer жив после orphan scan");
  } finally {
    if (boundCurrent) await new Promise((r) => boundCurrent.server.close(r));
    if (legacyServer) await new Promise((r) => legacyServer.close(r));
    if (wrongProjectServer) await new Promise((r) => wrongProjectServer.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R01: /api/health возвращает протокол, версию сборки и токен проекта, не раскрывая root", async () => {
  const tmp = createTempDir();
  let bound = null;
  try {
    bound = await startLiveServer(tmp, 4710, { maxAttempts: 10 });
    const res = await fetch(`http://127.0.0.1:${bound.port}/api/health`);
    assert.equal(res.status, 200);
    const health = await res.json();

    assert.equal(health.ok, true);
    assert.equal(health.project, projectToken(tmp));
    assert.equal(health.protocol, DASHBOARD_PROTOCOL);
    assert.equal(health.protocolVersion, DASHBOARD_PROTOCOL_VERSION);
    assert.equal(health.build, DASHBOARD_BUILD);
    assert.equal(typeof DASHBOARD_BUILD, "string");
    assert.equal(DASHBOARD_BUILD.length, 16, "DASHBOARD_BUILD вычисляется как 16-значный sha256 хеш исходника");
    assert.equal(health.root, undefined, "поле root не раскрывается в /api/health");
    assert.equal(typeof health.pid, "number");
  } finally {
    if (bound) await new Promise((r) => bound.server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R01: сервер с отличающимся build ID отвергается isCompatibleDashboard, fast path и orphan scan", async () => {
  const tmp = createTempDir();
  let staleBuildServer = null;
  let boundCurrent = null;
  const stalePort = 4720;
  const validPort = 4721;
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    // Сервер со старым build ID (например, после обновления исходного кода)
    staleBuildServer = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          pid: 7689,
          project: projectToken(tmp),
          protocol: DASHBOARD_PROTOCOL,
          protocolVersion: DASHBOARD_PROTOCOL_VERSION,
          build: "stale_build_9999",
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("stale build");
    });
    await new Promise((resolve) => staleBuildServer.listen(stalePort, "127.0.0.1", resolve));

    // 1. isCompatibleDashboard отвергает иной build
    const probedStale = await probeDashboard(stalePort);
    assert.equal(isCompatibleDashboard(probedStale, tmp), false, "сервер с другим build ID отвергается");

    // 2. Fast path: рантайм указывает на stalePort
    writeRuntime(tmp, {
      key: "local",
      port: stalePort,
      pid: 7689,
      url: `http://localhost:${stalePort}`,
      root: tmp,
      startedAt: new Date().toISOString(),
    });

    boundCurrent = await startLiveServer(tmp, validPort, { maxAttempts: 5 });
    const probedCurrent = await probeDashboard(boundCurrent.port);
    assert.equal(isCompatibleDashboard(probedCurrent, tmp), true);

    // ensureDashboard отказывается переиспользовать stalePort с иным build ID
    const info = await ensureDashboard(tmp, { open: false, port: stalePort, session: "local" });
    assert.equal(info.port, boundCurrent.port, "переиспользован актуальный build, а не устаревший");
    assert.notEqual(info.port, stalePort);
    assert.equal(staleBuildServer.listening, true, "процесс со старым build ID не был убит");

    // 3. Orphan scan: не усыновляет порт с устаревшим build ID
    rmSync(runtimePath(tmp, "local"), { force: true });
    rmSync(runtimePath(tmp), { force: true });

    const orphanInfo = await ensureDashboard(tmp, { open: false, port: stalePort, session: "local" });
    assert.equal(orphanInfo.port, boundCurrent.port, "orphan scan усыновил только сервер с текущим build ID");
    assert.equal(orphanInfo.adopted, true);
    assert.equal(staleBuildServer.listening, true);
  } finally {
    if (boundCurrent) await new Promise((r) => boundCurrent.server.close(r));
    if (staleBuildServer) await new Promise((r) => staleBuildServer.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- R06, R07 regressions */

function getFreePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

test("R06: writeRuntime и runtimePath отказывают ключам с выходом за каталог, оставляя внешние файлы нетронутыми", () => {
  const tmp = createTempDir();
  try {
    const outsideFile = join(tmp, "unrelated.json");
    writeFileSync(outsideFile, JSON.stringify({ sentinel: "untouched" }), "utf8");

    const project = join(tmp, "project");
    mkdirSync(join(project, ".workflow"), { recursive: true });

    // 1. Попытка записать с traversal-ключом через writeRuntime
    assert.throws(
      () => writeRuntime(project, { key: "../../../unrelated", port: 9999, pid: 1234 }),
      /ключ сессии|session key/i,
      "writeRuntime должен отклонить traversal-ключ"
    );

    // Внешний файл НЕ должен быть перезаписан
    const outsideContent = JSON.parse(readFileSync(outsideFile, "utf8"));
    assert.equal(outsideContent.sentinel, "untouched", "внешний файл должен остаться нетронутым");

    // 2. Отклонение недопустимых ключей: пустые, слэши, .., буквы диска, зарезервированные имена
    const badKeys = [
      "",
      "   ",
      "sub/dir",
      "sub\\dir",
      "..",
      "../escape",
      "C:drive",
      "CON",
      "con",
      "aux.json",
      "NUL",
      "COM1",
    ];

    for (const bad of badKeys) {
      assert.throws(
        () => runtimePath(project, bad),
        /ключ сессии|session key/i,
        `runtimePath должен отклонить недопустимый ключ ${JSON.stringify(bad)}`
      );
      assert.throws(
        () => writeRuntime(project, { key: bad, port: 9999 }),
        /ключ сессии|session key/i,
        `writeRuntime должен отклонить недопустимый ключ ${JSON.stringify(bad)}`
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R07: CLI --ensure и --url учитывают --session, создавая файл сессии вместо local", async () => {
  const tmp = createTempDir();
  const port = await getFreePort();
  let spawnedPid = null;
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    // Вызов CLI --ensure --session alpha
    const runEnsure = spawnSync(
      process.execPath,
      [CLI_PATH, "--ensure", "--no-open", "--session", "alpha", "--port", String(port), "--root", tmp],
      { encoding: "utf8", env: { ...process.env, NF_NO_OPEN: "1" }, timeout: 15000 }
    );
    assert.equal(runEnsure.status, 0, `CLI --ensure завершился с ошибкой: ${runEnsure.stderr}`);

    // Проверяем, что создан рантайм alpha, а local НЕ создан
    const alphaRuntime = readRuntime(tmp, "alpha");
    assert.ok(alphaRuntime, "файл .workflow/dashboards/alpha.json должен существовать");
    assert.equal(alphaRuntime.port, port);
    spawnedPid = alphaRuntime.pid;

    const localRuntime = readRuntime(tmp, "local");
    assert.equal(localRuntime, null, "файл local.json НЕ должен быть создан при --session alpha");

    // Вызов CLI --url --session alpha
    const runUrl = spawnSync(
      process.execPath,
      [CLI_PATH, "--url", "--session", "alpha", "--root", tmp],
      { encoding: "utf8", env: { ...process.env, NF_NO_OPEN: "1" }, timeout: 15000 }
    );
    assert.equal(runUrl.status, 0, `CLI --url завершился с ошибкой: ${runUrl.stderr}`);
    assert.match(runUrl.stdout.trim(), new RegExp(`http://localhost:${port}`), "--url должен вернуть URL alpha");
  } finally {
    if (spawnedPid) {
      try { process.kill(spawnedPid); } catch {}
      await new Promise((r) => setTimeout(r, 400));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R07: две разные сессии получают разные серверы и не усыновляют друг друга, а та же сессия переиспользуется", async () => {
  const tmp = createTempDir();
  const portA = await getFreePort();
  const portB = await getFreePort();
  let pidA = null;
  let pidB = null;
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    // 1. Запуск сессии alpha
    const infoA = await ensureDashboard(tmp, { open: false, session: "alpha", port: portA });
    assert.ok(infoA.url, "alpha должен запуститься");
    assert.equal(infoA.started, true);
    const recA = readRuntime(tmp, "alpha");
    assert.ok(recA);
    pidA = recA.pid;

    // Проверяем /api/health у сервера alpha
    const healthA = await (await fetch(`http://127.0.0.1:${infoA.port}/api/health`)).json();
    assert.equal(healthA.session, "alpha", "/api/health должен содержать session: alpha");

    // 2. Запуск сессии beta с ТЕМ ЖЕ portA: orphan scan не должен усыновить сервер alpha!
    const infoB = await ensureDashboard(tmp, { open: false, session: "beta", port: portA });
    assert.ok(infoB.url, "beta должен запуститься");
    assert.equal(infoB.started, true, "beta должен запуститься новым сервером, а не усыновить alpha");
    assert.notEqual(infoB.adopted, true, "beta не должен быть помечен как adopted");
    assert.notEqual(infoB.port, infoA.port, "порт beta должен отличаться от alpha, даже при том же запрошенном порту");
    const recB = readRuntime(tmp, "beta");
    assert.ok(recB);
    pidB = recB.pid;

    // Порты и PID должны быть строго разными!
    assert.notEqual(infoA.port, infoB.port, "порты alpha и beta должны различаться");
    assert.notEqual(pidA, pidB, "PID alpha и beta должны различаться");

    // Проверяем /api/health у сервера beta
    const healthB = await (await fetch(`http://127.0.0.1:${infoB.port}/api/health`)).json();
    assert.equal(healthB.session, "beta", "/api/health должен содержать session: beta");

    // 3. Повторный вызов alpha идемпотентно переиспользует тот же сервер alpha
    const againA = await ensureDashboard(tmp, { open: false, session: "alpha", port: portA });
    assert.equal(againA.started, false, "повторный вызов alpha должен переиспользовать сервер");
    assert.equal(againA.port, infoA.port);
  } finally {
    for (const p of [pidA, pidB]) {
      if (p) {
        try { process.kill(p); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R06: генерация статического snapshot дашборда использует проекцию sanitizeHttpState и не раскрывает маркер задачи", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    const MARKER = "SECRET_PRIVATE_TASK_DESCRIPTION_98765";
    writeFileSync(
      join(wfDir, "state.json"),
      JSON.stringify({
        tier: "T2",
        task: `Confidential Task: ${MARKER}`,
        status: "open",
        startedAt: new Date().toISOString(),
        artifacts: {
          lane: { at: new Date().toISOString(), detail: "T2" },
        },
      }),
      "utf8"
    );

    const outPath = join(tmp, "out-dashboard.html");
    const run = spawnSync(
      process.execPath,
      [CLI_PATH, "--root", tmp, "--output", outPath],
      { encoding: "utf8", env: { ...process.env, NF_NO_OPEN: "1" }, timeout: 15000 }
    );
    assert.equal(run.status, 0, `CLI завершился с ошибкой: ${run.stderr}`);

    const html = readFileSync(outPath, "utf8");
    assert.ok(!html.includes(MARKER), "статический snapshot дашборда не должен содержать сырой текст задачи");
    assert.ok(html.includes("Задача T2"), "страница содержит санитизированный заголовок задачи с ярусом");
    assert.ok(html.includes("open"), "страница содержит статус задачи");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R07: /api/diff для мегабайтного неотслеживаемого файла без перевода строк читает чанками без readFileSync и отдаёт метаданные", async () => {
  const tmp = createTempDir();
  let bound = null;
  const origReadFileSync = fs.readFileSync;
  let readFileSyncCalled = false;
  try {
    git(tmp, ["init", "-q"]);
    git(tmp, ["config", "user.name", "Workflow Tester"]);
    git(tmp, ["config", "user.email", "workflow@nullform.io"]);

    const readme = join(tmp, "README.md");
    writeFileSync(readme, "# Test\n", "utf8");
    git(tmp, ["add", "README.md"]);
    git(tmp, ["commit", "-q", "-m", "init"]);

    const RAW_SECRET = "SECRET_UNTRACKED_PAYLOAD_CHUNK_4455";
    const fileName = "large-untracked.txt";
    const bigFile = join(tmp, fileName);
    const buf = Buffer.alloc(2 * 1024 * 1024, 0x61);
    buf.write(RAW_SECRET, 0, "utf8");
    writeFileSync(bigFile, buf);

    // Scoped failure injection: перехватываем readFileSync для целевого файла
    fs.readFileSync = function (path, ...args) {
      if (typeof path === "string" && (path.includes(fileName) || resolve(path) === resolve(bigFile))) {
        readFileSyncCalled = true;
        throw new Error("ERR_UNBOUNDED_READ: readFileSync called on untracked file");
      }
      return Reflect.apply(origReadFileSync, this, [path, ...args]);
    };
    syncBuiltinESMExports();

    const port = await getFreePort();
    bound = await startLiveServer(tmp, port, { maxAttempts: 10 });

    const res = await fetch(`http://127.0.0.1:${port}/api/diff?file=${fileName}`);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.equal(readFileSyncCalled, false, "поточный подсчёт строк не должен вызывать readFileSync для неотслеживаемого файла");
    assert.ok(!body.includes(RAW_SECRET), "/api/diff не должен содержать сырой контент неотслеживаемого файла");
    assert.ok(body.includes("+ добавлено строк: 1"), "файл без перевода строк считается как 1 добавленная строка");
    assert.ok(body.includes("- удалено строк: 0"), "для неотслеживаемого файла удалено строк: 0");
    assert.ok(body.includes("Сводка: 1 изменённых строк"), "сводка указывает 1 изменённую строку");
    assert.ok(body.includes("(Метаданные: исходный патч скрыт политикой безопасности R05)"), "сохранено сообщение о скрытии патча");
  } finally {
    fs.readFileSync = origReadFileSync;
    syncBuiltinESMExports();
    if (bound) {
      await new Promise((r) => bound.server.close(r));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
