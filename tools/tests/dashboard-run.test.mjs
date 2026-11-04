/**
 * tools/tests/dashboard-run.test.mjs — Тесты run view, autopilot-parity и live dash.
 *
 * defer: dashboard run-view and autopilot-parity test suite | ceiling: 800 lines | upgrade: split parity tests into dashboard-parity.test.mjs
 */
delete process.env.PASEO_AGENT_ID;
delete process.env.OMP_SESSION_ID;

import test from "node:test";
import assert from "node:assert/strict";
import fs, { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseManifestRequirements,
  computeGates,
  collectRunState,
  sanitizeHttpState,
  generateDashboardHtml,
  parseArgs,
  main,
  esc,
  embedSnapshot,
  ensureDashboard,
} from "../dashboard.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../dashboard.mjs", import.meta.url)));
import { createTempDir, createGitRepo } from "./test-helpers.mjs";

/* ---------------------------------------------- D01, D02: Run View and --freeze */

test("D01: parseManifestRequirements парсит 3-колоночные и 4-колоночные манифесты с verbatim до 200 символов", () => {
  const mf3 = `# Manifest\n\n| ID | Requirement (user words) | Interpretation |\n|----|--------------------------|----------------|\n| R01 | "проанализруй детально autopilot" | Детальный разбор |\n| R02 | "длинное требование ${"a".repeat(250)}" | Описание |\n`;
  const reqs3 = parseManifestRequirements(mf3);
  assert.equal(reqs3.length, 2);
  assert.equal(reqs3[0].id, "R01");
  assert.equal(reqs3[0].text, "проанализруй детально autopilot");
  assert.equal(reqs3[0].status, "open");
  assert.equal(reqs3[1].text.length, 200, "текст обрезается ровно до 200 символов");

  // При закрытом state все открытые требования закрываются
  const closedReqs = parseManifestRequirements(mf3, { status: "closed" });
  assert.equal(closedReqs[0].status, "done");

  // 4-колоночный манифест с явным статусом
  const mf4 = `| ID | Req | Detail | Status |\n|---|---|---|---|\n| R01 | "первое" | det | done |\n| R02 | "второе" | det | in-spec |\n`;
  const reqs4 = parseManifestRequirements(mf4);
  assert.equal(reqs4[0].status, "done");
  assert.equal(reqs4[1].status, "open");
});

test("D01: computeGates вычисляет G1-G4 из артефактов и файлов", () => {
  const tmp = createTempDir();
  try {
    // 1. Пустой прогон: все гейты open
    const gEmpty = computeGates({ root: tmp, artifacts: {} });
    assert.equal(gEmpty.G1.ok, null);
    assert.equal(gEmpty.G1.status, "open");
    assert.equal(gEmpty.G2.ok, null);
    assert.equal(gEmpty.G3.ok, null);
    assert.equal(gEmpty.G4.ok, null);

    // 2. Только манифест записан
    const mfPath = join(tmp, "manifest.md");
    writeFileSync(mfPath, "| R01 | test | test | done |\n");
    const gManifest = computeGates({
      root: tmp,
      artifacts: { manifest: { path: "manifest.md" } },
    });
    assert.equal(gManifest.G1.ok, true);
    assert.equal(gManifest.G1.status, "pass");
    assert.equal(gManifest.G2.ok, null);
    assert.equal(gManifest.G2.status, "open");

    // 3. OpenSpec валиден: proposal + tasks + specs
    const chDir = join(tmp, "openspec", "changes", "test-change");
    mkdirSync(join(chDir, "specs"), { recursive: true });
    writeFileSync(join(chDir, "proposal.md"), "# Proposal\n");
    writeFileSync(join(chDir, "tasks.md"), "# Tasks\n");
    writeFileSync(join(chDir, "specs", "spec.md"), "# Spec\n");
    const gOpenSpec = computeGates({
      root: tmp,
      change: "test-change",
      artifacts: {
        manifest: { path: "manifest.md" },
        openspec: { path: "openspec/changes/test-change" },
      },
    });
    assert.equal(gOpenSpec.G2.ok, true);
    assert.equal(gOpenSpec.G2.status, "pass");

    // 4. Interfaces записан
    writeFileSync(join(chDir, "interfaces.md"), "# Interfaces\n");
    const gInterfaces = computeGates({
      root: tmp,
      change: "test-change",
      artifacts: {
        manifest: { path: "manifest.md" },
        openspec: { path: "openspec/changes/test-change" },
        interfaces: { path: "openspec/changes/test-change/interfaces.md" },
      },
    });
    assert.equal(gInterfaces.G3.ok, true);
    assert.equal(gInterfaces.G3.status, "pass");

    // 5. Oracle ACCEPT
    const gOracleAccept = computeGates({
      root: tmp,
      change: "test-change",
      artifacts: {
        oracle: { detail: "ACCEPT: blind oracle proven" },
      },
    });
    assert.equal(gOracleAccept.G4.ok, true);
    assert.equal(gOracleAccept.G4.status, "pass");

    // 6. Oracle REJECT
    const gOracleReject = computeGates({
      root: tmp,
      change: "test-change",
      artifacts: {
        oracle: { detail: "REJECT: 3 failures" },
      },
    });
    assert.equal(gOracleReject.G4.ok, false);
    assert.equal(gOracleReject.G4.status, "fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D01: collectRunState собирает состояние прогона, исключая waits из activeMs", () => {
  const tmp = createTempDir();
  try {
    // Нет state.json -> null
    assert.equal(collectRunState(tmp), null);

    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });

    const t0 = new Date(Date.now() - 60000).toISOString();
    const state = {
      tier: "T2",
      task: "Test Run",
      status: "open",
      startedAt: t0,
      artifacts: {
        lane: { at: t0 },
        recon: { at: t0 },
      },
      waits: [
        { kind: "ask", from: new Date(Date.now() - 40000).toISOString(), to: new Date(Date.now() - 20000).toISOString(), durationMs: 20000 },
      ],
    };
    writeFileSync(join(wfDir, "state.json"), JSON.stringify(state));
    writeFileSync(join(wfDir, "events.jsonl"), JSON.stringify({ at: t0, kind: "start", text: "start test" }) + "\n");

    const run = collectRunState(tmp);
    assert.ok(run);
    assert.equal(run.open, true);
    assert.equal(run.tier, "T2");
    assert.equal(run.stages.length, 6);
    assert.equal(run.stages[0].status, "done");
    assert.equal(run.stages[1].status, "done");
    assert.equal(run.stages[2].status, "in_progress");
    assert.equal(run.waits.length, 1);
    assert.equal(run.waitMs, 20000);
    assert.ok(run.activeMs >= 35000 && run.activeMs <= 45000, `activeMs (${run.activeMs}) должен быть около 40000 (60s - 20s)`);
    assert.ok(run.rev, "rev присутствует");
    assert.equal(run.feed.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D01: /api/state и sanitizeHttpState включают run со всеми полями", () => {
  const raw = {
    project: { name: "test", branch: "main" },
    task: { tier: "T2", status: "open" },
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Задача T2",
      stages: [{ id: "lane", status: "done" }],
      requirements: [{ id: "R01", text: "требование", status: "open" }],
      gates: {
        G1: { ok: true, status: "pass", label: "Manifest recorded" },
        G2: { ok: null, status: "open", label: "OpenSpec valid" },
        G3: { ok: null, status: "open", label: "Interfaces recorded" },
        G4: { ok: null, status: "open", label: "Oracle ACCEPT" },
      },
      waits: [],
      beats: [],
      activeMs: 5000,
      waitMs: 0,
      rev: "abc123",
      feed: [{ t: new Date().toISOString(), kind: "start", text: "старт" }],
    },
  };
  const s = sanitizeHttpState(raw);
  assert.ok(s.run, "run сохранён в санитизированном состоянии");
  assert.equal(s.run.tier, "T2");
  assert.equal(s.run.activeMs, 5000);
  assert.equal(s.run.rev, "abc123");
  assert.equal(s.run.gates.G1.ok, true);
  assert.equal(s.run.requirements[0].id, "R01");
});

test("D01 + D02: generateDashboardHtml содержит run секции и offline-бейдж", () => {
  const data = {
    project: { name: "test-proj", branch: "main", commit: { hash: "123", when: "" } },
    task: { tier: "T2", status: "open", title: "Задача T2", elapsedMs: 0, budget: 25 },
    progress: { percent: 10, stagesDone: 1, stagesRequired: 6, stagesSkipped: 0, artifactsDone: 1, artifactsTotal: 6 },
    stages: [{ id: "lane", name: "Ярус", wave: 0, status: "done" }],
    currentStage: { id: "recon", name: "Разведка", wave: 1, detail: "" },
    timing: { elapsedMs: 0, remainingMin: null, remainingMax: null, medianTaskMs: 0 },
    metrics: { briefCoverage: 20, requirements: { total: 1, byStatus: {}, items: [], change: null }, debt: { total: 0, noTrigger: 0, items: [] }, memory: { status: "fresh", daysSince: null }, checks: null },
    git: { isRepo: false, branch: "main", commit: { hash: "", when: "" }, files: [], added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0 },
    arch: { name: "root", kind: "dir", lines: 0, files: 0, children: [] },
    archGraph: { nodes: [], edges: [] },
    modules: [],
    critique: [],
    history: { total: 0, medianMs: 0, byTier: {}, recent: [] },
    fleet: [],
    events: [],
    log: { file: null, entries: [] },
    session: { key: "local", name: null },
    waves: [],
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тестовая задача",
      stages: [{ id: "lane", status: "done" }, { id: "recon", status: "in_progress" }],
      requirements: [{ id: "R01", text: "Сделать вкладку run", status: "open" }],
      gates: {
        G1: { ok: true, status: "pass", label: "Manifest recorded" },
        G2: { ok: null, status: "open", label: "OpenSpec valid" },
        G3: { ok: null, status: "open", label: "Interfaces recorded" },
        G4: { ok: null, status: "open", label: "Oracle ACCEPT" },
      },
      waits: [],
      beats: [],
      activeMs: 12000,
      waitMs: 3000,
      rev: "rev-12345",
      feed: [{ t: new Date().toISOString(), kind: "start", text: "запуск" }],
    },
  };

  const html = generateDashboardHtml(data);
  assert.ok(html.includes("run-hero"), "HTML содержит hero-блок");
  assert.ok(html.includes("run-track"), "HTML содержит stage track");
  assert.ok(html.includes("run-words"), "HTML содержит words (R##)");
  assert.ok(html.includes("run-gates"), "HTML содержит gates (G1-G4)");
  assert.ok(html.includes("run-feed"), "HTML содержит feed");
  assert.ok(html.includes("badge-offline"), "HTML содержит freeze-бейдж");
  assert.ok(html.includes("window.NF_SNAPSHOT"), "HTML содержит window.NF_SNAPSHOT");
  assert.ok(html.includes("renderRun"), "HTML содержит функцию renderRun");
  assert.ok(html.includes("tickRun"), "HTML содержит функцию tickRun");
});

test("D02: parseArgs распознаёт --freeze", () => {
  const opts = parseArgs(["--freeze"]);
  assert.equal(opts.freeze, true);
});

test("D02: main --freeze создаёт dashboard-frozen.html со снапшотом", async () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "state.json"), JSON.stringify({ tier: "T1", status: "open", startedAt: new Date().toISOString() }));

    const res = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--freeze"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(res.status, 0, `вызов завершился успешно: ${res.stderr}`);
    const frozenFile = join(tmp, "dashboard-frozen.html");
    assert.ok(existsSync(frozenFile), "dashboard-frozen.html создан");
    const content = readFileSync(frozenFile, "utf8");
    assert.ok(content.includes("window.NF_SNAPSHOT"), "снапшот записан в window.NF_SNAPSHOT");
    assert.ok(content.includes("badge-offline"), "бейдж offline присутствует");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("F01 (1): generateDashboardHtml экранирует project.name в <title>", () => {
  const data = {
    project: { name: '</title><script>alert("xss")</script>' },
    task: { tier: "T1", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
  };
  const html = generateDashboardHtml(data);
  assert.ok(!html.includes('</title><script>alert("xss")</script>'));
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
});

test("F01 (2): esc экранирует одинарные кавычки", () => {
  assert.equal(esc("O'Reilly & \"Co\" <test>"), "O&#39;Reilly &amp; &quot;Co&quot; &lt;test&gt;");
});

test("F01 (3): embedSnapshot записывает window.NF_SNAPSHOT в разметку", () => {
  const html = '<!DOCTYPE html><html><head><script>/*STATE-BEGIN*//*STATE-END*/</script></head><body></body></html>';
  const state = { project: { name: "snap-test" } };
  const res = embedSnapshot(html, state);
  assert.ok(res.includes("window.NF_SNAPSHOT ="));
  assert.ok(res.includes('"name":"snap-test"'));
});

test("F01 (4): generateDashboardHtml с frozen: true не запускает polling/fetch", () => {
  const data = {
    project: { name: "p" }, task: { tier: "T1", status: "open", title: "t" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
  };
  const html = generateDashboardHtml(data, { frozen: true });
  assert.ok(html.includes("if (!IS_FROZEN) {\n    refreshNow();\n    setInterval(refreshNow, POLL_MS);\n  }"));
  assert.ok(html.includes("if (IS_FROZEN) return;"));
});

test("F01 (5): клиентские таймеры при IS_FROZEN выходят досрочно", () => {
  const data = {
    project: { name: "p" }, task: { tier: "T1", status: "open", title: "t" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
  };
  const html = generateDashboardHtml(data);
  assert.ok(html.includes("if (IS_FROZEN || DATA.task.status === \"closed\") return;"));
  assert.ok(html.includes("if (IS_FROZEN) return;\n    tickRun();"));
  assert.ok(html.includes("if (IS_FROZEN || !DATA || !DATA.run || DATA.run.status === \"closed\") return;"));
});

test("F01 (6): ensureDashboard не спавнит дублирующие серверы при одновременных вызовах", async () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, ".workflow"), { recursive: true });
    const [res1, res2] = await Promise.all([
      ensureDashboard(tmp, { open: false, port: 4470, session: "single-flight" }),
      ensureDashboard(tmp, { open: false, port: 4470, session: "single-flight" }),
    ]);
    assert.equal(res1.port, res2.port, "оба вызова вернули один и тот же порт");
    assert.ok(res1.url, "сервер поднялся");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- D01: Parity run-view assertions (R01, R02, R03) */

test("D01: hero отображает цветовые состояния, WIP-бейдж, summary и pending question (R01, R03)", () => {
  const baseData = {
    project: { name: "test-hero" },
    task: { tier: "T2", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 8, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 8 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
    run: {
      open: true,
      status: "waiting",
      tier: "T2",
      task: "Тестовая задача согласования",
      pendingQuestion: "Подтверждаете ли вы изменения?",
      stages: [{ id: "lane", status: "done" }],
      requirements: [{ id: "R01", text: "req", status: "open" }],
      waves: [],
      gates: { G1: { ok: true, status: "pass" }, G2: { ok: null, status: "open" }, G3: { ok: null, status: "open" }, G4: { ok: null, status: "open" } },
      waits: [], beats: [], activeMs: 1000, waitMs: 500, rev: "r1", feed: [],
    },
  };

  const htmlWaiting = generateDashboardHtml(baseData);
  assert.ok(htmlWaiting.includes(".run-hero.run-waiting { background: #FF6B35; }"), "CSS содержит цвет orange для waiting");
  assert.ok(htmlWaiting.includes(".run-hero.run-working { background: #2F45E0; }"), "CSS содержит цвет blue для working");
  assert.ok(htmlWaiting.includes(".run-hero.run-closed { background: #17864A; }"), "CSS содержит цвет green для closed");
  assert.ok(htmlWaiting.includes(".run-hero.run-failed { background: #C81E1E; }"), "CSS содержит цвет red для failed");
  assert.ok(htmlWaiting.includes("run-wip-badge"), "разметка содержит класс run-wip-badge");
  assert.ok(htmlWaiting.includes("run-hero-question"), "разметка содержит контейнер run-hero-question");
  assert.ok(htmlWaiting.includes("run-question-badge"), "разметка содержит бейдж вопроса");
  assert.ok(htmlWaiting.includes("Подтверждаете ли вы изменения?"), "снапшот содержит текст вопроса");
});

test("D01: 8-stage track содержит этапы Preflight, Manifest, Briefing, Spec, Plan, Dev, Review, Accept (R01)", () => {
  const data = {
    project: { name: "test-track" },
    task: { tier: "T2", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 8, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 8 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тест 8-стадийного трека",
      stages: [
        { id: "lane", status: "done" },
        { id: "recon", status: "done" },
        { id: "manifest", status: "done" },
        { id: "openspec", status: "done" },
        { id: "interfaces", status: "in_progress" },
      ],
      requirements: [],
      waves: [],
      gates: {},
      waits: [], beats: [], activeMs: 1000, waitMs: 0, rev: "r2", feed: [],
    },
  };
  const html = generateDashboardHtml(data);
  assert.ok(html.includes("Preflight"), "трек включает этап Preflight");
  assert.ok(html.includes("Manifest"), "трек включает этап Manifest");
  assert.ok(html.includes("Briefing"), "трек включает этап Briefing");
  assert.ok(html.includes("Spec"), "трек включает этап Spec");
  assert.ok(html.includes("Plan"), "трек включает этап Plan");
  assert.ok(html.includes("Dev"), "трек включает этап Dev");
  assert.ok(html.includes("Review"), "трек включает этап Review");
  assert.ok(html.includes("Accept"), "трек включает этап Accept");
  assert.ok(html.includes("getTrackStages"), "клиентский код содержит функцию маппинга 8 стадий getTrackStages");
});

test("D01: waves task matrix отображает lanes, 5 состояний задач и счётчики ремонтов (R01, R03)", () => {
  const data = {
    project: { name: "test-matrix" },
    task: { tier: "T2", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 8, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 8 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тест матрицы задач волн",
      stages: [],
      requirements: [],
      waves: [
        {
          n: 1,
          tickets: [
            { id: "T01", title: "done ticket", status: "done", lines: 200, repairs: 0 },
            { id: "T02", title: "waiting ticket", status: "waiting", lines: 150, repairs: 1 },
            { id: "T03", title: "in-progress ticket", status: "in_progress", lines: 300, repairs: 0 },
            { id: "T04", title: "repair ticket", status: "repair", lines: 400, repairs: 2 },
            { id: "T05", title: "pending ticket", status: "pending", lines: 100, repairs: 0 },
          ],
        },
      ],
      gates: {},
      waits: [], beats: [], activeMs: 1000, waitMs: 0, rev: "r3", feed: [],
    },
  };
  const html = generateDashboardHtml(data);
  assert.ok(html.includes("run-wave-lane"), "разметка содержит класс лейнов run-wave-lane");
  assert.ok(html.includes("run-tasks-matrix"), "разметка содержит матрицу задач run-tasks-matrix");
  assert.ok(html.includes(".task-card-green"), "стили содержат зелёное состояние задачи");
  assert.ok(html.includes(".task-card-orange"), "стили содержат оранжевое состояние задачи");
  assert.ok(html.includes(".task-card-purple"), "стили содержат фиолетовое состояние задачи");
  assert.ok(html.includes(".task-card-cyan"), "стили содержат циан состояние задачи ремонта");
  assert.ok(html.includes(".task-card-white"), "стили содержат белое состояние задачи");
  assert.ok(html.includes("run-task-repairs"), "разметка содержит класс счётчика ремонтов");
  assert.ok(html.includes("/2 repairs"), "разметка выводит счётчик ремонтов с лимитом 2");
});

test("D01: verbatim requirements содержит бейджи типов R/Ri/G/A/D и фильтры статусов (R01)", () => {
  const data = {
    project: { name: "test-verbatim" },
    task: { tier: "T2", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 8, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 8 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тест бейджей требований",
      stages: [],
      requirements: [
        { id: "R01", text: "базовое требование", status: "open" },
        { id: "R01i", text: "неявное требование", status: "done" },
        { id: "G01", text: "добавка пользователя", status: "open" },
        { id: "A01", text: "фича агента", status: "open" },
        { id: "D01", text: "расхождение", status: "deferred" },
      ],
      waves: [],
      gates: {},
      waits: [], beats: [], activeMs: 1000, waitMs: 0, rev: "r4", feed: [],
    },
  };
  const html = generateDashboardHtml(data);
  assert.ok(html.includes("getReqType"), "клиентский код содержит функцию распознавания типов getReqType");
  assert.ok(html.includes("req-badge-r"), "стили содержат бейдж типа R");
  assert.ok(html.includes("req-badge-ri"), "стили содержат бейдж типа Ri");
  assert.ok(html.includes("req-badge-g"), "стили содержат бейдж типа G");
  assert.ok(html.includes("req-badge-a"), "стили содержат бейдж типа A");
  assert.ok(html.includes("req-badge-d"), "стили содержат бейдж типа D");
  assert.ok(html.includes('data-filter="all"'), "фильтр All присутствует");
  assert.ok(html.includes('data-filter="done"'), "фильтр Done присутствует");
  assert.ok(html.includes('data-filter="open"'), "фильтр Open присутствует");
  assert.ok(html.includes('data-filter="in-spec"'), "фильтр In-Spec присутствует");
  assert.ok(html.includes('data-filter="deferred"'), "фильтр Deferred присутствует");
});

test("D01: gates G1-G4 и timing с live 1s tick и beats <= 45m без пауз (R01, R02, R03)", () => {
  const data = {
    project: { name: "test-gates" },
    task: { tier: "T2", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 8, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 8 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
    run: {
      open: true,
      status: "open",
      tier: "T2",
      task: "Тест гейтов и таймингов",
      stages: [],
      requirements: [],
      waves: [],
      gates: {
        G1: { ok: true, status: "pass", label: "Manifest recorded" },
        G2: { ok: true, status: "pass", label: "OpenSpec valid" },
        G3: { ok: false, status: "fail", label: "Interfaces recorded" },
        G4: { ok: null, status: "open", label: "Oracle ACCEPT" },
      },
      waits: [{ kind: "user_wait", from: new Date().toISOString(), to: new Date().toISOString(), durationMs: 15000 }],
      beats: ["beat-1", "beat-2", "beat-3"],
      activeMs: 90000,
      waitMs: 15000,
      rev: "r5",
      feed: [{ t: new Date().toISOString(), kind: "event", text: "test event" }],
    },
  };
  const html = generateDashboardHtml(data);
  assert.ok(html.includes("run-gates-grid"), "разметка содержит сетку гейтов G1-G4");
  assert.ok(html.includes("gatePass"), "словарь содержит статус gatePass");
  assert.ok(html.includes("run-clock-active"), "разметка содержит id run-clock-active для 1s tick");
  assert.ok(html.includes("run-clock-wait"), "разметка содержит id run-clock-wait для 1s tick");
  assert.ok(html.includes("beats (≤45m)"), "разметка учитывает отсечение beats <= 45m без пауз");
});

test("D01 + D02: freeze-silence и конфигурируемый pollMs 1000-3000 default 2000 (R02)", () => {
  const data = {
    project: { name: "test-poll" },
    task: { tier: "T1", status: "open", title: "task" },
    progress: { percent: 0, stagesDone: 0, stagesRequired: 1, stagesSkipped: 0, artifactsDone: 0, artifactsTotal: 1 },
    stages: [], waves: [], currentStage: {}, timing: {},
    metrics: { requirements: { items: [], byStatus: {} }, debt: { items: [] }, memory: {}, checks: null },
    git: { files: [] }, log: { entries: [] }, critique: [], history: { total: 0, recent: [], byTier: {} },
  };

  // По умолчанию: 2000 мс
  const htmlDefault = generateDashboardHtml(data);
  assert.ok(htmlDefault.includes("var POLL_MS = 2000;"), "интервал по умолчанию равен 2000 мс");

  // Кастомный в пределах 1000-3000
  const htmlCustom = generateDashboardHtml(data, { pollMs: 1500 });
  assert.ok(htmlCustom.includes("var POLL_MS = 1500;"), "кастомный pollMs 1500 передаётся в разметку");

  // Клампинг < 1000
  const htmlLow = generateDashboardHtml(data, { pollMs: 500 });
  assert.ok(htmlLow.includes("var POLL_MS = 1000;"), "pollMs < 1000 клампится до 1000");

  // Клампинг > 3000
  const htmlHigh = generateDashboardHtml(data, { pollMs: 5000 });
  assert.ok(htmlHigh.includes("var POLL_MS = 3000;"), "pollMs > 3000 клампится до 3000");

  // Frozen режим: zero timers, zero fetches
  const htmlFrozen = generateDashboardHtml(data, { frozen: true });
  assert.ok(htmlFrozen.includes("var IS_FROZEN = true;"), "IS_FROZEN равен true");
  assert.ok(htmlFrozen.includes("if (!IS_FROZEN) {\n    refreshNow();\n    setInterval(refreshNow, POLL_MS);\n  }"));
  assert.ok(htmlFrozen.includes("if (!IS_FROZEN) {\n    var startMs = DATA.task.startedAt ? new Date(DATA.task.startedAt).getTime() : Date.now();"));

  // parseArgs для --poll
  const opts1 = parseArgs(["--poll", "2500"]);
  assert.equal(opts1.pollMs, 2500);
  const opts2 = parseArgs(["--poll-ms=1800"]);
  assert.equal(opts2.pollMs, 1800);
  const optsErr = parseArgs(["--poll", "5000"]);
  assert.ok(optsErr.errors.length > 0, "недопустимый pollMs регистрирует ошибку");

  // --help содержит строку с --poll
  const helpProc = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(helpProc.status, 0);
  assert.ok(helpProc.stdout.includes("--poll <ms>"), "справка --help содержит строку с --poll <ms>");
});

test("D03: tokens aggregate: собирает tokens из session usage и безопасно обрабатывает null usage", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "state.json"), JSON.stringify({ status: "open", tier: "T1", task: "Tokens test" }));

    // Случай 1: usage передан в session
    const runWithUsage = collectRunState(tmp, {
      usage: { inputTokens: 5000, outputTokens: 1200, cachedTokens: 3000, costUsd: 0.025 },
    });
    assert.ok(runWithUsage.tokens, "tokens присутствуют в run");
    assert.equal(runWithUsage.tokens.input, 5000);
    assert.equal(runWithUsage.tokens.output, 1200);
    assert.equal(runWithUsage.tokens.cached, 3000);
    assert.equal(runWithUsage.tokens.costUsd, 0.025);

    // Случай 2: null usage (без PASEO_AGENT_ID)
    const runNullUsage = collectRunState(tmp, null);
    assert.ok(runNullUsage.tokens, "tokens присутствуют при null usage");
    assert.equal(runNullUsage.tokens.input, 0);
    assert.equal(runNullUsage.tokens.output, 0);
    assert.equal(runNullUsage.tokens.cached, 0);
    assert.equal(runNullUsage.tokens.costUsd, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D03: zones aggregate: группирует тикеты по green/orange/red с учётом правила repairs>=2 -> red", () => {
  const tmp = createTempDir();
  try {
    const wfDir = join(tmp, ".workflow");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "state.json"), JSON.stringify({
      status: "open",
      tier: "T2",
      task: "Zones test",
      tickets: [
        { id: "T-DONE", title: "Done ticket", status: "done", lines: 100, repairs: 0 },
        { id: "T-VERIFIED", title: "Verified ticket", status: "verified", lines: 150, repairs: 1 },
        { id: "T-PROG", title: "In-progress ticket", status: "in_progress", lines: 200, repairs: 0 },
        { id: "T-WAIT", title: "Waiting ticket", status: "waiting", lines: 50, repairs: 1 },
        { id: "T-FAIL", title: "Failed ticket", status: "failed", lines: 300, repairs: 0 },
        { id: "T-REPAIR2", title: "Done but 2 repairs", status: "done", lines: 250, repairs: 2 },
        { id: "T-REPAIR3", title: "Active but 3 repairs", status: "active", lines: 180, repairs: 3 },
      ],
    }));

    const run = collectRunState(tmp);
    assert.ok(run.zones, "zones присутствуют в run");

    // Green: done/verified с repairs < 2
    assert.deepEqual(run.zones.green.tickets, ["T-DONE", "T-VERIFIED"]);
    assert.equal(run.zones.green.count, 2);

    // Orange: in_progress/waiting с repairs < 2
    assert.deepEqual(run.zones.orange.tickets, ["T-PROG", "T-WAIT"]);
    assert.equal(run.zones.orange.count, 2);

    // Red: failed + repairs >= 2 (T-REPAIR2, T-REPAIR3)
    assert.deepEqual(run.zones.red.tickets, ["T-FAIL", "T-REPAIR2", "T-REPAIR3"]);
    assert.equal(run.zones.red.count, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D03: HTML contains run-tokens + run-zones sections via generateDashboardHtml", () => {
  const data = {
    project: { name: "test-tokens-zones", branch: "main", commit: { hash: "abc", when: "" } },
    task: { tier: "T1", status: "open", title: "Test tokens and zones", elapsedMs: 1000, budget: 25 },
    progress: { percent: 50, stagesDone: 1, stagesRequired: 2, stagesSkipped: 0, artifactsDone: 1, artifactsTotal: 2 },
    stages: [{ id: "lane", name: "Ярус", wave: 0, status: "done" }],
    currentStage: { id: "lane", name: "Ярус", wave: 0, detail: "" },
    timing: { elapsedMs: 1000, remainingMin: 5, remainingMax: 10, medianTaskMs: 1000 },
    metrics: { briefCoverage: 50, requirements: { total: 1, byStatus: {}, items: [], change: null }, debt: { total: 0, noTrigger: 0, items: [] }, memory: { status: "fresh", daysSince: null }, checks: null },
    git: { isRepo: false, branch: "main", commit: { hash: "", when: "" }, files: [], added: 0, deleted: 0, staged: 0, unstaged: 0, untracked: 0 },
    arch: { name: "root", kind: "dir", lines: 0, files: 0, children: [] },
    archGraph: { nodes: [], edges: [] },
    modules: [], critique: [], history: { total: 0, medianMs: 0, byTier: {}, recent: [] }, fleet: [], events: [],
    log: { file: null, entries: [] },
    session: { key: "local", name: null },
    waves: [],
    run: {
      open: true,
      status: "open",
      tier: "T1",
      task: "Tokens & Zones UI Test",
      tokens: { input: 12500, output: 4300, cached: 8500, costUsd: 0.045 },
      zones: {
        green: { count: 1, tickets: ["T01"] },
        orange: { count: 1, tickets: ["T02"] },
        red: { count: 1, tickets: ["T03"] },
      },
      waves: [
        {
          n: 1,
          tickets: [
            { id: "T01", title: "Ticket green", status: "done", lines: 200, repairs: 0 },
            { id: "T02", title: "Ticket orange", status: "in_progress", lines: 150, repairs: 0 },
            { id: "T03", title: "Ticket red", status: "failed", lines: 300, repairs: 0 },
          ],
        },
      ],
      stages: [{ id: "lane", status: "done" }],
      requirements: [],
      gates: {},
      waits: [],
      beats: [],
      activeMs: 5000,
      waitMs: 1000,
      rev: "rev-tokens",
      feed: [],
    },
  };

  const html = generateDashboardHtml(data);
  assert.ok(html.includes("run-tokens"), "HTML содержит hero tokens row (.run-tokens)");
  assert.ok(html.includes("run-zones"), "HTML содержит status zones strip (.run-zones)");
  assert.ok(html.includes("zone-green"), "HTML содержит green zone card");
  assert.ok(html.includes("zone-orange"), "HTML содержит orange zone card");
  assert.ok(html.includes("zone-red"), "HTML содержит red zone card");
  assert.ok(html.includes("run-zone-tickets"), "HTML содержит контейнер тикетов зоны");

  // Проверка генерации скрипта со стилями токенов и зон
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "HTML содержит блок <script>");
  assert.ok(html.includes("tokensHtml"), "скрипт содержит вычисление tokensHtml");
  assert.ok(html.includes("zonesHtml"), "скрипт содержит вычисление zonesHtml");
  assert.ok(html.includes(".run-tokens"), "стили содержат класс .run-tokens");
  assert.ok(html.includes(".run-zones"), "стили содержат класс .run-zones");
});
