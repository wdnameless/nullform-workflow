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
} from "../dashboard.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../dashboard.mjs", import.meta.url)));

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "dashboard-test-"));
}

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false , windowsHide: true});
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
    assert.ok(readFileSync(outFile, "utf8").includes("Nullform Console"));
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
    assert.equal(state.task.title, "live test");
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
