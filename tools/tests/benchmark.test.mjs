// defer: benchmark eval-metrics test suite expansion | ceiling: 1200 lines | upgrade: split unit and integration benchmark tests
/**
 * benchmark.test.mjs — тесты для инструмента benchmark.
 *
 * Покрывает (согласно interfaces.md и R01-R05):
 *   1. Метрики (2 added строки, 1 файл) в result.json
 *   2. Check passed → отчёт / passed: true
 *   3. Check failed → passed: false и exit-код проверки записан
 *   4. Отказ без --yes (exitCode 1)
 *   5. --dry-run ничего не создаёт на диске
 *   6. compare на синтетических прогонах даёт верные дельты и агрегат
 *   7. не-git root → exit 2
 *   8. report без прогонов → честное пустое сообщение, exit 0
 *   9. init создает tasks.json, README.md, .gitignore и идемпотентен
 *   10. parseArgs разбирает флаги и команды
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  TASKS_FILE,
  RUNS_DIR,
  initBenchmark,
  loadTasks,
  runBenchmark,
  summarizeRuns,
  compareArms,
  formatReport,
  formatCompare,
  computePassK,
  validateTasks,
  runSmoke,
  findRecentSessionTranscript,
  parseArgs,
} from "../benchmark.mjs";

const CLI_PATH = fileURLToPath(new URL("../benchmark.mjs", import.meta.url));
import { recordCassette, loadCassette, hashPrompt } from "../lm-replay.mjs";
import { createTempDir, createGitRepo } from "./test-helpers.mjs";


test("parseArgs: разбирает команды и все флаги", () => {
  const args = parseArgs([
    "run",
    "--root",
    "my-root",
    "--task=t1",
    "--arm",
    "arm1",
    "--cmd",
    "echo test",
    "--runs=3",
    "--timeout=60",
    "--transcript",
    "t.json",
    "--dry-run",
    "--yes",
    "--json",
    "--baseline",
    "b-arm",
    "--candidate=c-arm",
    "--replay",
    "bench/cassettes/task.json",
    "--record=bench/cassettes/out.json",
  ]);

  assert.equal(args.command, "run");
  assert.equal(args.root, "my-root");
  assert.equal(args.task, "t1");
  assert.equal(args.arm, "arm1");
  assert.equal(args.cmd, "echo test");
  assert.equal(args.runs, 3);
  assert.equal(args.timeout, 60);
  assert.equal(args.transcript, "t.json");
  assert.equal(args.dryRun, true);
  assert.equal(args.yes, true);
  assert.equal(args.json, true);
  assert.equal(args.baseline, "b-arm");
  assert.equal(args.candidate, "c-arm");
  assert.equal(args.replay, "bench/cassettes/task.json");
  assert.equal(args.record, "bench/cassettes/out.json");
});

test("initBenchmark: создает структуру bench/ и работает идемпотентно", () => {
  const tmp = createTempDir();
  try {
    const res1 = initBenchmark(tmp);
    assert.deepEqual(res1.created, [TASKS_FILE, "bench/README.md", "bench/.gitignore"]);
    assert.deepEqual(res1.skipped, []);

    assert.equal(existsSync(join(tmp, TASKS_FILE)), true);
    assert.equal(existsSync(join(tmp, "bench/README.md")), true);
    assert.equal(existsSync(join(tmp, "bench/.gitignore")), true);

    const loaded = loadTasks(tmp);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.tasks.length, 2);
    assert.equal(loaded.tasks[0].id, "sample-task");
    assert.equal(loaded.tasks[1].id, "safety-edge-case");
    assert.equal(loaded.tasks[1].tier, "safety");

    // Идемпотентность
    const res2 = initBenchmark(tmp);
    assert.deepEqual(res2.created, []);
    assert.deepEqual(res2.skipped, [TASKS_FILE, "bench/README.md", "bench/.gitignore"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("не-git root → runBenchmark выбрасывает ошибку с exitCode 2, CLI завершается с 2", () => {
  const tmp = createTempDir();
  try {
    initBenchmark(tmp);

    // Вызов функции
    assert.throws(
      () => {
        runBenchmark({
          root: tmp,
          taskId: "sample-task",
          arm: "test-arm",
          cmd: "node -v",
          yes: true,
        });
      },
      (err) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /не является git-репозиторием/);
        return true;
      }
    );

    // Вызов CLI
    const cliRes = spawnSync(
      process.execPath,
      [CLI_PATH, "run", "--root", tmp, "--task", "sample-task", "--arm", "test", "--cmd", "node -v", "--yes"],
      { encoding: "utf8" }
    );
    assert.equal(cliRes.status, 2);
    assert.match(cliRes.stderr, /не является git-репозиторием/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("отказ без --yes: выбрасывает ошибку с exitCode 1, CLI завершается с 1", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    assert.throws(
      () => {
        runBenchmark({
          root: repoDir,
          taskId: "sample-task",
          arm: "test-arm",
          cmd: "node -v",
          yes: false,
        });
      },
      (err) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /требует подтверждения флагом --yes/);
        return true;
      }
    );

    const cliRes = spawnSync(
      process.execPath,
      [CLI_PATH, "run", "--root", repoDir, "--task", "sample-task", "--arm", "test", "--cmd", "node -v"],
      { encoding: "utf8" }
    );
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stderr, /требует подтверждения флагом --yes/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("--dry-run ничего не создает на диске и возвращает план", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    const plan = runBenchmark({
      root: repoDir,
      taskId: "sample-task",
      arm: "test-arm",
      cmd: "node -v",
      dryRun: true,
    });

    assert.equal(plan.taskId, "sample-task");
    assert.equal(plan.arm, "test-arm");
    assert.equal(plan.plannedRuns.length, 1);

    // Проверяем, что runs/ директория пуста или отсутствует
    const runsDir = join(repoDir, RUNS_DIR);
    assert.equal(existsSync(runsDir), false);

    // Через CLI
    const cliRes = spawnSync(
      process.execPath,
      [CLI_PATH, "run", "--root", repoDir, "--task", "sample-task", "--arm", "test-arm", "--cmd", "node -v", "--dry-run"],
      { encoding: "utf8" }
    );
    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /План запуска бенчмарка/);
    assert.equal(existsSync(runsDir), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runBenchmark: метрики (2 added строки, 1 файл) и check passed → отчёт", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    // Настраиваем задачу с проверкой успешности
    const customTasks = {
      version: 1,
      tasks: [
        {
          id: "add-lines",
          title: "Добавить 2 строки в out.txt",
          prompt: "Запишите в out.txt две строки: a и b",
          setup: [],
          checks: [
            "node -e \"const fs=require('fs'); if(!fs.existsSync('out.txt')) process.exit(1); const c=fs.readFileSync('out.txt','utf8'); if(c !== 'a\\nb\\n') process.exit(1); console.log('CHECK_OK');\"",
          ],
          timeoutSec: 30,
        },
      ],
    };
    writeFileSync(join(repoDir, TASKS_FILE), JSON.stringify(customTasks, null, 2), "utf8");

    // arm command: записывает ровно 'a\nb\n' в out.txt
    const armCmd = `node -e "require('fs').writeFileSync('out.txt', 'a\\nb\\n')"`;

    const results = runBenchmark({
      root: repoDir,
      taskId: "add-lines",
      arm: "test-writer",
      cmd: armCmd,
      yes: true,
      runs: 1,
    });

    assert.equal(results.length, 1);
    const r = results[0];

    assert.equal(r.status, "ok");
    assert.equal(r.agentExit, 0);
    assert.equal(r.task, "add-lines");
    assert.equal(r.arm, "test-writer");

    // Метрики
    assert.equal(r.metrics.linesAdded, 2);
    assert.equal(r.metrics.linesDeleted, 0);
    assert.equal(r.metrics.filesChanged, 1);
    assert.equal(r.metrics.files.length, 1);
    assert.equal(r.metrics.files[0].file, "out.txt");
    assert.equal(r.metrics.files[0].added, 2);
    assert.equal(r.metrics.files[0].deleted, 0);

    // Проверки
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].passed, true);
    assert.equal(r.checks[0].code, 0);
    assert.match(r.checks[0].tail, /CHECK_OK/);

    // Проверяем, что result.json и agent.log созданы
    assert.equal(existsSync(r.logPath), true);
    const runDir = join(r.logPath, "..");
    const savedResult = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    assert.equal(savedResult.metrics.linesAdded, 2);

    // Проверяем CLI report
    const reportRes = spawnSync(process.execPath, [CLI_PATH, "report", "--root", repoDir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(reportRes.status, 0);
    const reportData = JSON.parse(reportRes.stdout);
    assert.equal(reportData.total, 1);
    const group = reportData.byTaskArm["add-lines::test-writer"];
    assert.equal(group.runs, 1);
    assert.equal(group.medianLinesAdded, 2);
    assert.equal(group.medianFilesChanged, 1);
    assert.equal(group.checksPassed, 1);
    assert.equal(group.checksTotal, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runBenchmark: check failed → passed=false и exit-код проверки записан", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    const customTasks = {
      version: 1,
      tasks: [
        {
          id: "fail-check-task",
          title: "Задача с падающей проверкой",
          prompt: "Делаем что-то",
          checks: [
            "node -e \"console.error('FAIL_OUTPUT'); process.exit(42);\"",
          ],
        },
      ],
    };
    writeFileSync(join(repoDir, TASKS_FILE), JSON.stringify(customTasks, null, 2), "utf8");

    const armCmd = `node -e "console.log('done')"`;

    const results = runBenchmark({
      root: repoDir,
      taskId: "fail-check-task",
      arm: "arm-fail",
      cmd: armCmd,
      yes: true,
    });

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.status, "ok"); // Агент завершился успешно, но проверка упала
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].passed, false);
    assert.equal(r.checks[0].code, 42);
    assert.match(r.checks[0].tail, /FAIL_OUTPUT/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("report без прогонов: честное пустое сообщение, exit 0", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    const summary = summarizeRuns(repoDir);
    assert.equal(summary.total, 0);
    assert.deepEqual(summary.byTaskArm, {});

    // CLI текстовый вывод
    const cliText = spawnSync(process.execPath, [CLI_PATH, "report", "--root", repoDir], {
      encoding: "utf8",
    });
    assert.equal(cliText.status, 0);
    assert.match(cliText.stdout, /Запусков нет: сначала выполните benchmark run\./);

    // CLI JSON вывод
    const cliJson = spawnSync(process.execPath, [CLI_PATH, "report", "--root", repoDir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(cliJson.status, 0);
    const data = JSON.parse(cliJson.stdout);
    assert.equal(data.total, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/** Фикстура: репозиторий с задачей и src/x.js в истории. */
function createMetricsRepo(taskId) {
  const repoDir = createGitRepo();
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "x.js"), "const x = 1;\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "add src"], { cwd: repoDir });

  initBenchmark(repoDir);
  writeFileSync(
    join(repoDir, TASKS_FILE),
    JSON.stringify({
      version: 1,
      tasks: [{
        id: taskId,
        title: "t",
        prompt: "p",
        setup: [
          "git config user.name BenchTester",
          "git config user.email bench@test.local",
          "git config commit.gpgsign false",
        ],
        checks: [],
        timeoutSec: 60,
      }],
    }, null, 2),
    "utf8"
  );
  return repoDir;
}

test("метрики: служебные артефакты инструментов не приписываются агенту", () => {
  const repoDir = createMetricsRepo("artifact-task");
  try {
    const armCmd =
      `node -e "const fs=require('fs');` +
      `fs.writeFileSync('src/x.js','const x = 2;\\n');` +
      `fs.mkdirSync('.opencode/index',{recursive:true});` +
      `fs.writeFileSync('.opencode/index/artifact.json','{}\\n')"`;

    const results = runBenchmark({
      root: repoDir,
      taskId: "artifact-task",
      arm: "artifact-arm",
      cmd: armCmd,
      yes: true,
      runs: 1,
    });

    assert.equal(results.length, 1);
    const r = results[0];

    // Работа агента: только src/x.js
    assert.equal(r.metrics.filesChanged, 1);
    assert.deepEqual(r.metrics.files.map((f) => f.file), ["src/x.js"]);
    assert.equal(r.metrics.linesAdded, 1);
    assert.equal(r.metrics.linesDeleted, 1);

    // Служебный артефакт посчитан отдельно и не попал в метрики задачи
    assert.equal(r.toolArtifacts.filesChanged, 1);
    assert.equal(r.toolArtifacts.files[0].file, ".opencode/index/artifact.json");

    // Расхождений нет — предупреждения отсутствуют
    assert.equal(r.metricsWarning, null);
    assert.ok(r.worktreeChanges >= 1, `worktreeChanges=${r.worktreeChanges}`);
    assert.equal(r.commits, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("метрики: залоченный .git/index.lock не приводит к молчаливому нулю", () => {
  const repoDir = createMetricsRepo("locked-index-task");
  try {
    const armCmd =
      `node -e "const fs=require('fs');` +
      `fs.writeFileSync('src/x.js','const x = 3;\\n');` +
      `fs.writeFileSync('.git/index.lock','')"`;

    const results = runBenchmark({
      root: repoDir,
      taskId: "locked-index-task",
      arm: "locked-arm",
      cmd: armCmd,
      yes: true,
      runs: 1,
    });

    const r = results[0];
    // Правка агента обязана попасть в метрики, несмотря на сломанный git add
    assert.equal(r.metrics.filesChanged, 1);
    assert.equal(r.metrics.files[0].file, "src/x.js");
    assert.equal(r.metrics.linesAdded, 1);
    assert.equal(r.metrics.linesDeleted, 1);
    // Молчания нет: причина зафиксирована
    assert.match(r.metricsWarning, /git add -A/);
    assert.ok(r.worktreeChanges > 0, `worktreeChanges=${r.worktreeChanges}`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("метрики: коммит агента не теряется (сравнение с baseSha)", () => {
  const repoDir = createMetricsRepo("commit-task");
  try {
    const armCmd =
      `node -e "const fs=require('fs');` +
      `fs.appendFileSync('src/x.js','const y = 4;\\n');` +
      `require('child_process').execSync('git add -A && git -c user.name=BenchTester -c user.email=bench@test.local -c commit.gpgsign=false commit -m agent-work', { env: { ...process.env, GIT_AUTHOR_NAME: 'BenchTester', GIT_AUTHOR_EMAIL: 'bench@test.local', GIT_COMMITTER_NAME: 'BenchTester', GIT_COMMITTER_EMAIL: 'bench@test.local' } })"`;

    const results = runBenchmark({
      root: repoDir,
      taskId: "commit-task",
      arm: "commit-arm",
      cmd: armCmd,
      yes: true,
      runs: 1,
    });

    const r = results[0];
    assert.equal(r.commits, 1);
    assert.notEqual(r.baseSha, r.headSha);
    assert.equal(r.metrics.filesChanged, 1);
    assert.equal(r.metrics.files[0].file, "src/x.js");
    assert.equal(r.metrics.linesAdded, 1);
    assert.equal(r.metricsWarning, null);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("compareArms: на синтетических прогонах дает верные дельты и агрегат", () => {
  const syntheticSummary = {
    total: 4,
    byTaskArm: {
      "t1::base": {
        task: "t1",
        arm: "base",
        runs: 2,
        medianDurationMs: 1000,
        medianLinesAdded: 100,
        medianLinesDeleted: 10,
        medianFilesChanged: 2,
        checksPassed: 2,
        checksTotal: 2,
        medianCostUsd: 0.05,
      },
      "t1::cand": {
        task: "t1",
        arm: "cand",
        runs: 2,
        medianDurationMs: 800,
        medianLinesAdded: 70,
        medianLinesDeleted: 5,
        medianFilesChanged: 1,
        checksPassed: 2,
        checksTotal: 2,
        medianCostUsd: 0.03,
      },
      "t2::base": {
        task: "t2",
        arm: "base",
        runs: 1,
        medianDurationMs: 2000,
        medianLinesAdded: 200,
        medianLinesDeleted: 20,
        medianFilesChanged: 3,
        checksPassed: 1,
        checksTotal: 2,
        medianCostUsd: 0.1,
      },
      "t2::cand": {
        task: "t2",
        arm: "cand",
        runs: 1,
        medianDurationMs: 1500,
        medianLinesAdded: 150,
        medianLinesDeleted: 10,
        medianFilesChanged: 2,
        checksPassed: 2,
        checksTotal: 2,
        medianCostUsd: 0.07,
      },
    },
  };

  const comp = compareArms(syntheticSummary, "base", "cand");
  assert.equal(comp.byTask.length, 2);

  const t1 = comp.byTask.find((t) => t.task === "t1");
  assert.equal(t1.deltas.linesDiff, -30);
  assert.equal(t1.deltas.linesPct, -30.0); // 70 vs 100 => -30%
  assert.equal(t1.deltas.durationMsDiff, -200);
  assert.equal(t1.deltas.durationPct, -20.0); // 800 vs 1000 => -20%
  assert.equal(t1.deltas.checksRateBase, 100.0);
  assert.equal(t1.deltas.checksRateCandidate, 100.0);

  const t2 = comp.byTask.find((t) => t.task === "t2");
  assert.equal(t2.deltas.linesDiff, -50);
  assert.equal(t2.deltas.linesPct, -25.0); // 150 vs 200 => -25%
  assert.equal(t2.deltas.durationMsDiff, -500);
  assert.equal(t2.deltas.durationPct, -25.0); // 1500 vs 2000 => -25%
  assert.equal(t2.deltas.checksRateBase, 50.0);
  assert.equal(t2.deltas.checksRateCandidate, 100.0);

  // Агрегат
  // baseTotalLines: 100 + 200 = 300, candTotalLines: 70 + 150 = 220 => diff = -80 => -26.7%
  assert.equal(comp.aggregate.linesDiff, -80);
  assert.equal(comp.aggregate.linesPct, -26.7);
  // baseTotalDuration: 1000 + 2000 = 3000, candTotalDuration: 800 + 1500 = 2300 => diff = -700 => -23.3%
  assert.equal(comp.aggregate.durationMsDiff, -700);
  assert.equal(comp.aggregate.durationPct, -23.3);
  assert.deepEqual(comp.aggregate.baseChecks, { passed: 3, total: 4 });
  assert.deepEqual(comp.aggregate.candidateChecks, { passed: 4, total: 4 });
});

/* ------------------------------------------------- adversarial (hardening-2) */

test("tasks.json: дублирующийся id — явная ошибка, а не молчаливый выбор первой задачи", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);
    writeFileSync(
      join(repoDir, TASKS_FILE),
      JSON.stringify({
        version: 1,
        tasks: [
          { id: "dup", title: "first", prompt: "one" },
          { id: "dup", title: "second", prompt: "two" },
        ],
      }),
      "utf8"
    );

    assert.throws(() => loadTasks(repoDir), /Дублирующийся id/);

    const cli = spawnSync(process.execPath, [CLI_PATH, "list", "--root", repoDir], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Дублирующийся id задачи 'dup'/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("tasks.json: неверные типы setup/checks/timeoutSec ловятся, а не превращаются в NaN-таймаут", () => {
  for (const badTask of [
    { id: "t", prompt: "p", timeoutSec: "abc" },
    { id: "t", prompt: "p", setup: "npm install" },
    { id: "t", prompt: "p", checks: "node -e 1" },
  ]) {
    const repoDir = createGitRepo();
    try {
      initBenchmark(repoDir);
      writeFileSync(join(repoDir, TASKS_FILE), JSON.stringify({ version: 1, tasks: [badTask] }), "utf8");

      assert.throws(() => loadTasks(repoDir), /Задача 't'/, JSON.stringify(badTask));

      const cli = spawnSync(process.execPath, [CLI_PATH, "list", "--root", repoDir], { encoding: "utf8" });
      assert.equal(cli.status, 1, JSON.stringify(badTask));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }
});

test("CLI: --runs 0/-1 отклоняется с exit 2, а --runs 1 остаётся валидным", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);
    writeFileSync(
      join(repoDir, TASKS_FILE),
      JSON.stringify({ version: 1, tasks: [{ id: "t", title: "t", prompt: "p" }] }),
      "utf8"
    );

    for (const bad of ["0", "-1", "abc"]) {
      const cli = spawnSync(
        process.execPath,
        [CLI_PATH, "run", "--root", repoDir, "--task", "t", "--arm", "a", "--cmd", "x", "--runs", bad, "--dry-run"],
        { encoding: "utf8" }
      );
      assert.equal(cli.status, 2, `--runs ${bad}: ${cli.stderr}`);
      assert.match(cli.stderr, /--runs/);
    }

    const ok = spawnSync(
      process.execPath,
      [CLI_PATH, "run", "--root", repoDir, "--task", "t", "--arm", "a", "--cmd", "x", "--runs", "1", "--dry-run"],
      { encoding: "utf8" }
    );
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /Повторов: 1/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("report: повреждённый result.json не исчезает молча", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);
    mkdirSync(join(repoDir, RUNS_DIR, "broken-run"), { recursive: true });
    writeFileSync(join(repoDir, RUNS_DIR, "broken-run", "result.json"), "{corrupt", "utf8");

    const summary = summarizeRuns(repoDir);
    assert.equal(summary.total, 0);
    assert.equal(summary.skipped.length, 1);
    assert.match(summary.skipped[0].reason, /JSON/);

    const cli = spawnSync(process.execPath, [CLI_PATH, "report", "--root", repoDir], { encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /пропущен bench\/runs\/broken-run\/result\.json/);

    const cliJson = spawnSync(process.execPath, [CLI_PATH, "report", "--root", repoDir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(cliJson.status, 1);
    assert.equal(JSON.parse(cliJson.stdout).skipped.length, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("tasks.json: валидация поля tier в loadTasks", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    // Валидные тиры
    for (const validTier of ["standard", "safety", "perf"]) {
      writeFileSync(
        join(repoDir, TASKS_FILE),
        JSON.stringify({
          version: 1,
          tasks: [{ id: `task-${validTier}`, tier: validTier, title: "t", prompt: "p" }],
        }),
        "utf8"
      );
      const loaded = loadTasks(repoDir);
      assert.equal(loaded.tasks[0].tier, validTier);
    }

    // Без указания tier — по умолчанию standard
    writeFileSync(
      join(repoDir, TASKS_FILE),
      JSON.stringify({
        version: 1,
        tasks: [{ id: "task-default", title: "t", prompt: "p" }],
      }),
      "utf8"
    );
    const loadedDef = loadTasks(repoDir);
    assert.equal(loadedDef.tasks[0].tier, "standard");

    // Невалидные тиры: неверные строки, типы, null, пустая строка
    const invalidTiers = ["invalid", "unknown", "", 123, true, null, []];
    for (const badTier of invalidTiers) {
      writeFileSync(
        join(repoDir, TASKS_FILE),
        JSON.stringify({
          version: 1,
          tasks: [{ id: "bad-task", tier: badTier, title: "t", prompt: "p" }],
        }),
        "utf8"
      );
      assert.throws(
        () => loadTasks(repoDir),
        /'tier' должен быть строкой из standard, safety, perf/,
        `Ожидалась ошибка для tier=${JSON.stringify(badTier)}`
      );
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("parseArgs: поддержка -n как алиаса --runs и флага --tier", () => {
  // -n с пробелом
  const a1 = parseArgs(["run", "-n", "7", "--tier", "safety"]);
  assert.equal(a1.runs, 7);
  assert.equal(a1.tier, "safety");

  // -n= и --tier=
  const a2 = parseArgs(["run", "-n=5", "--tier=perf"]);
  assert.equal(a2.runs, 5);
  assert.equal(a2.tier, "perf");

  // Значения по умолчанию
  const a3 = parseArgs(["run"]);
  assert.equal(a3.runs, 1);
  assert.equal(a3.tier, null);

  // --runs и --tier
  const a4 = parseArgs(["report", "--runs", "3", "--tier", "standard"]);
  assert.equal(a4.runs, 3);
  assert.equal(a4.tier, "standard");
});

test("summarizeRuns и compareArms: подсчет safetyPassRate, учет стоимости и фильтрация по тиру", () => {
  const repoDir = createGitRepo();
  try {
    initBenchmark(repoDir);

    // Создаем 3 синтетических прогона в bench/runs:
    // 1) safety задача, arm-a: 2 проверки (обе прошли), cost: 0.05
    mkdirSync(join(repoDir, RUNS_DIR, "run-1"), { recursive: true });
    writeFileSync(
      join(repoDir, RUNS_DIR, "run-1", "result.json"),
      JSON.stringify({
        version: 1,
        task: "safe-task",
        arm: "arm-a",
        tier: "safety",
        durationMs: 500,
        metrics: { linesAdded: 10, linesDeleted: 2, filesChanged: 1 },
        checks: [{ passed: true }, { passed: true }],
        cost: { total_usd: 0.05 },
        status: "ok",
      }),
      "utf8"
    );

    // 2) safety задача, arm-b: 2 проверки (1 прошла, 1 упала), cost: 0.03
    mkdirSync(join(repoDir, RUNS_DIR, "run-2"), { recursive: true });
    writeFileSync(
      join(repoDir, RUNS_DIR, "run-2", "result.json"),
      JSON.stringify({
        version: 1,
        task: "safe-task",
        arm: "arm-b",
        tier: "safety",
        durationMs: 400,
        metrics: { linesAdded: 8, linesDeleted: 1, filesChanged: 1 },
        checks: [{ passed: true }, { passed: false }],
        cost: { total_usd: 0.03 },
        status: "ok",
      }),
      "utf8"
    );

    // 3) standard задача, arm-a: 1 проверка (прошла), cost: 0.02
    mkdirSync(join(repoDir, RUNS_DIR, "run-3"), { recursive: true });
    writeFileSync(
      join(repoDir, RUNS_DIR, "run-3", "result.json"),
      JSON.stringify({
        version: 1,
        task: "std-task",
        arm: "arm-a",
        tier: "standard",
        durationMs: 300,
        metrics: { linesAdded: 5, linesDeleted: 0, filesChanged: 1 },
        checks: [{ passed: true }],
        cost: { total_usd: 0.02 },
        status: "ok",
      }),
      "utf8"
    );

    // Полный summary (все тиры)
    const fullSummary = summarizeRuns(repoDir);
    assert.equal(fullSummary.total, 3);
    // Всего safety проверок: 2 (run-1) + 2 (run-2) = 4; из них прошли 2 + 1 = 3
    assert.equal(fullSummary.safetyChecksTotal, 4);
    assert.equal(fullSummary.safetyChecksPassed, 3);
    assert.equal(fullSummary.safetyPassRate, 75.0); // 3/4 = 75%
    // Стоимость: 0.05 + 0.03 + 0.02 = 0.10
    assert.equal(fullSummary.costTotal, 0.1);
    assert.equal(fullSummary.costMedian, 0.03);

    // Фильтрация по options.tier: safety
    const safetySummary = summarizeRuns(repoDir, { tier: "safety" });
    assert.equal(safetySummary.total, 2);
    assert.equal(safetySummary.safetyChecksTotal, 4);
    assert.equal(safetySummary.safetyChecksPassed, 3);
    assert.equal(safetySummary.safetyPassRate, 75.0);
    assert.equal(safetySummary.costTotal, 0.08); // 0.05 + 0.03

    // Фильтрация по options.tier: perf (нет таких прогонов)
    const perfSummary = summarizeRuns(repoDir, { tier: "perf" });
    assert.equal(perfSummary.total, 0);
    assert.equal(perfSummary.safetyChecksTotal, 0);
    assert.equal(perfSummary.safetyPassRate, null);
    assert.equal(perfSummary.costTotal, null);

    // formatReport: форматирует консольный вывод с Safety pass rate и стоимостью
    const reportText = formatReport(fullSummary);
    assert.match(reportText, /Safety pass rate: 75% \(3\/4 checks\)/);
    assert.match(reportText, /Стоимость: всего \$0\.1/);

    // compareArms: baseline arm-b vs candidate arm-a
    const comp = compareArms(fullSummary, "arm-b", "arm-a");
    assert.equal(comp.byTask.length, 2);

    const safeItem = comp.byTask.find((t) => t.task === "safe-task");
    assert.ok(safeItem);
    assert.equal(safeItem.baseline.safetyPassRate, 50.0); // 1/2
    assert.equal(safeItem.candidate.safetyPassRate, 100.0); // 2/2
    assert.equal(safeItem.deltas.safetyPassRateDiff, 50.0); // +50%
    assert.equal(safeItem.deltas.costBase, 0.03);
    assert.equal(safeItem.deltas.costCandidate, 0.05);
    assert.equal(safeItem.deltas.costDiff, 0.02);

    // Агрегат compareArms
    assert.equal(comp.aggregate.baseSafetyPassRate, 50.0);
    assert.equal(comp.aggregate.candidateSafetyPassRate, 100.0);
    assert.equal(comp.aggregate.safetyPassRateDiff, 50.0);
    assert.equal(comp.aggregate.baseCostTotal, 0.03);
    assert.equal(comp.aggregate.candidateCostTotal, 0.07); // safe-task (0.05) + std-task (0.02)
    assert.equal(comp.aggregate.costDiff, 0.04);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("findRecentSessionTranscript: не падает и возвращает null при отсутствии каталога/файлов", () => {
  const res = findRecentSessionTranscript(Date.now() + 1000000);
  assert.equal(res, null);
});

test("computePassK: фиктивные раны A:5/5, B:4/5, C:1/5, D:0/5 дают pass@5=75% и pass^5=25%", () => {
  const dummyRuns = [
    ...Array.from({ length: 5 }, () => ({ task: "A", arm: "base", checks: [{ passed: true }] })),
    ...Array.from({ length: 4 }, () => ({ task: "B", arm: "base", checks: [{ passed: true }] })),
    { task: "B", arm: "base", checks: [{ passed: false }] },
    { task: "C", arm: "base", checks: [{ passed: true }] },
    ...Array.from({ length: 4 }, () => ({ task: "C", arm: "base", checks: [{ passed: false }] })),
    ...Array.from({ length: 5 }, () => ({ task: "D", arm: "base", checks: [{ passed: false }] })),
  ];

  const res = computePassK(dummyRuns);
  assert.equal(res.k, 5);
  assert.equal(res.passAtK, 75);
  assert.equal(res.passPowK, 25);
  assert.equal(res["pass@5"], 75);
  assert.equal(res["pass^5"], 25);

  assert.equal(res.byTaskArm["A::base"].passAtK, 1);
  assert.equal(res.byTaskArm["A::base"].passPowK, 1);
  assert.equal(res.byTaskArm["B::base"].passAtK, 1);
  assert.equal(res.byTaskArm["B::base"].passPowK, 0);
  assert.equal(res.byTaskArm["C::base"].passAtK, 1);
  assert.equal(res.byTaskArm["C::base"].passPowK, 0);
  assert.equal(res.byTaskArm["D::base"].passAtK, 0);
  assert.equal(res.byTaskArm["D::base"].passPowK, 0);
});

test("computePassK: кейс K=1 вырождается в pass rate задачи", () => {
  const runsK1 = [
    { task: "T1", arm: "base", checks: [{ passed: true }] },
    { task: "T2", arm: "base", checks: [{ passed: true }] },
    { task: "T3", arm: "base", checks: [{ passed: false }] },
    { task: "T4", arm: "base", checks: [{ passed: false }] },
  ];

  const resK1 = computePassK(runsK1);
  assert.equal(resK1.k, 1);
  assert.equal(resK1.passAtK, 50.0);
  assert.equal(resK1.passPowK, 50.0);
  assert.equal(resK1["pass@1"], 50.0);
  assert.equal(resK1["pass^1"], 50.0);
  assert.equal(resK1.passAtK, resK1.passPowK);
  assert.equal(resK1.byTaskArm["T1::base"].passAtK, 1);
  assert.equal(resK1.byTaskArm["T1::base"].passPowK, 1);
  assert.equal(resK1.byTaskArm["T3::base"].passAtK, 0);
  assert.equal(resK1.byTaskArm["T3::base"].passPowK, 0);
});

test("computePassK: кейс пустого набора возвращает 0 (не NaN)", () => {
  for (const emptyInput of [[], null, undefined, {}]) {
    const res = computePassK(emptyInput);
    assert.equal(res.k, 0);
    assert.equal(res.passAtK, 0);
    assert.equal(res.passPowK, 0);
    assert.equal(Number.isNaN(res.passAtK), false);
    assert.equal(Number.isNaN(res.passPowK), false);
  }
});

test("summarizeRuns и compareArms: интеграция pass@k и pass^k, дельты и форматирование", () => {
  const repoDir = createGitRepo();
  try {
    const runsDir = join(repoDir, RUNS_DIR);
    mkdirSync(runsDir, { recursive: true });

    const makeRun = (id, task, arm, passed) => {
      const dir = join(runsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          task,
          arm,
          tier: "standard",
          durationMs: 100,
          metrics: { linesAdded: 5, linesDeleted: 1, filesChanged: 1 },
          checks: [{ passed }],
          status: "ok",
        }),
        "utf8"
      );
    };

    makeRun("run1", "task1", "base", true);
    makeRun("run2", "task1", "base", true);
    makeRun("run3", "task2", "base", false);
    makeRun("run4", "task2", "base", false);

    makeRun("run5", "task1", "cand", true);
    makeRun("run6", "task1", "cand", true);
    makeRun("run7", "task2", "cand", true);
    makeRun("run8", "task2", "cand", false);

    const summary = summarizeRuns(repoDir);
    assert.equal(summary.k, 2);
    assert.equal(typeof summary.passAtK, "number");
    assert.equal(typeof summary.passPowK, "number");

    const t1Base = summary.byTaskArm["task1::base"];
    assert.equal(t1Base.k, 2);
    assert.equal(t1Base.passAtK, 1);
    assert.equal(t1Base.passPowK, 1);

    const t2Cand = summary.byTaskArm["task2::cand"];
    assert.equal(t2Cand.k, 2);
    assert.equal(t2Cand.passAtK, 1);
    assert.equal(t2Cand.passPowK, 0);

    const comp = compareArms(summary, "base", "cand");
    assert.equal(comp.aggregate.baseK, 2);
    assert.equal(comp.aggregate.candidateK, 2);
    assert.equal(comp.aggregate.basePassAtK, 50.0);
    assert.equal(comp.aggregate.candidatePassAtK, 100.0);
    assert.equal(comp.aggregate.passAtKDiff, 50.0);
    assert.equal(comp.aggregate.basePassPowK, 50.0);
    assert.equal(comp.aggregate.candidatePassPowK, 50.0);
    assert.equal(comp.aggregate.passPowKDiff, 0.0);

    const reportText = formatReport(summary);
    assert.match(reportText, /pass@k/);
    assert.match(reportText, /pass\^k/);
    assert.match(reportText, /pass@2: \d+(\.\d+)?%, pass\^2: \d+(\.\d+)?%/);

    const compareText = formatCompare(comp);
    assert.match(compareText, /pass@2:/);
    assert.match(compareText, /pass\^2:/);
    assert.match(compareText, /pass@2 50% -> 100% \(\+50%\)/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("computePassK: мульти-арм byTask сохраняет оба арма без затирания", () => {
  const multiArmRuns = [
    { task: "task-X", arm: "arm-base", checks: [{ passed: true }] },
    { task: "task-X", arm: "arm-cand", checks: [{ passed: false }] },
  ];

  const res = computePassK(multiArmRuns);
  assert.ok(res.byTask["task-X"]);
  assert.ok(res.byTask["task-X"]["arm-base"]);
  assert.ok(res.byTask["task-X"]["arm-cand"]);
  assert.equal(res.byTask["task-X"]["arm-base"].passAtK, 1);
  assert.equal(res.byTask["task-X"]["arm-base"].passPowK, 1);
  assert.equal(res.byTask["task-X"]["arm-cand"].passAtK, 0);
  assert.equal(res.byTask["task-X"]["arm-cand"].passPowK, 0);
});

test("summarizeRuns: tier-фильтр считает pass@k и pass^k только по запрошенному тиру", () => {
  const repoDir = createGitRepo();
  try {
    const runsDir = join(repoDir, RUNS_DIR);
    mkdirSync(runsDir, { recursive: true });

    const writeRun = (id, task, arm, tier, passed) => {
      const dir = join(runsDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({
          task,
          arm,
          tier,
          durationMs: 50,
          metrics: { linesAdded: 1, linesDeleted: 0, filesChanged: 1 },
          checks: [{ passed }],
          status: "ok",
        }),
        "utf8"
      );
    };

    // standard: 2 runs, all failed (pass@2 = 0)
    writeRun("s1", "std-task", "arm1", "standard", false);
    writeRun("s2", "std-task", "arm1", "standard", false);

    // safety: 2 runs, all passed (pass@2 = 100)
    writeRun("sf1", "safe-task", "arm1", "safety", true);
    writeRun("sf2", "safe-task", "arm1", "safety", true);

    const safetySummary = summarizeRuns(repoDir, { tier: "safety" });
    assert.equal(safetySummary.total, 2);
    assert.equal(safetySummary.k, 2);
    assert.equal(safetySummary.passAtK, 100.0);
    assert.equal(safetySummary.passPowK, 100.0);
    assert.equal(Object.keys(safetySummary.byTaskArm).length, 1);
    assert.ok(safetySummary.byTaskArm["safe-task::arm1"]);
    assert.equal(safetySummary.byTaskArm["std-task::arm1"], undefined);

    const stdSummary = summarizeRuns(repoDir, { tier: "standard" });
    assert.equal(stdSummary.total, 2);
    assert.equal(stdSummary.k, 2);
    assert.equal(stdSummary.passAtK, 0.0);
    assert.equal(stdSummary.passPowK, 0.0);
    assert.equal(Object.keys(stdSummary.byTaskArm).length, 1);
    assert.ok(stdSummary.byTaskArm["std-task::arm1"]);
    assert.equal(stdSummary.byTaskArm["safe-task::arm1"], undefined);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("R02: bench/tasks.json содержит 10 валидных задач и проходит validate-tasks", () => {
  const res = validateTasks(REPO_ROOT);
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.count, 10);

  const cli = spawnSync(process.execPath, [CLI_PATH, "validate-tasks", "--root", REPO_ROOT, "--json"], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.count, 10);
});

test("R02: validate-tasks отклоняет невалидную схему с exit 2 и списком причин", () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, "bench"), { recursive: true });
    writeFileSync(
      join(tmp, TASKS_FILE),
      JSON.stringify({
        version: 1,
        tasks: [
          { id: "dup", tier: "safety", title: "ok", prompt: "p", checks: ["node -e 0"], timeoutSec: 10 },
          { id: "dup", tier: "bad-tier", title: "bad", prompt: "p", checks: [], timeoutSec: 0 },
        ],
      }),
      "utf8"
    );
    const res = validateTasks(tmp);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /дублирующийся id/.test(e)));
    assert.ok(res.errors.some((e) => /tier/.test(e)));
    assert.ok(res.errors.some((e) => /checks/.test(e)));
    assert.ok(res.errors.some((e) => /timeoutSec/.test(e)));

    const cli = spawnSync(process.execPath, [CLI_PATH, "validate-tasks", "--root", tmp], { encoding: "utf8" });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /дублирующийся id/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R02: smoke на фикстурах (red exit 1 и green exit 0)", () => {
  const baseDir = join(REPO_ROOT, "bench/fixtures/smoke/baseline");
  const candDir = join(REPO_ROOT, "bench/fixtures/smoke/candidate");

  const redCli = spawnSync(
    process.execPath,
    [CLI_PATH, "smoke", "--baseline", baseDir, "--candidate", candDir, "--json"],
    { encoding: "utf8" }
  );
  assert.equal(redCli.status, 1);
  const redData = JSON.parse(redCli.stdout);
  assert.equal(redData.passed, false);
  assert.deepEqual(redData.redTasks, ["eval-verdict-parsing"]);

  const greenFiltered = spawnSync(
    process.execPath,
    [CLI_PATH, "smoke", "--baseline", baseDir, "--candidate", candDir, "--tasks", "eval-frozen-test-invariance"],
    { encoding: "utf8" }
  );
  assert.equal(greenFiltered.status, 0);
  assert.match(greenFiltered.stdout, /SMOKE GREEN/);

  const greenSame = spawnSync(
    process.execPath,
    [CLI_PATH, "smoke", "--baseline", baseDir, "--candidate", baseDir],
    { encoding: "utf8" }
  );
  assert.equal(greenSame.status, 0);
});

test("R02: smoke граничные случаи — неидеальный baseline (4/5 vs 0/5) и отсутствующая задача (skip)", () => {
  const res = runSmoke({
    baseline: [
      { task: "flaky", checks: [{ passed: true }] },
      { task: "flaky", checks: [{ passed: true }] },
      { task: "flaky", checks: [{ passed: true }] },
      { task: "flaky", checks: [{ passed: true }] },
      { task: "flaky", checks: [{ passed: false }] },
      { task: "only-base", checks: [{ passed: true }] },
    ],
    candidate: [
      { task: "flaky", checks: [{ passed: false }] },
      { task: "flaky", checks: [{ passed: false }] },
      { task: "flaky", checks: [{ passed: false }] },
      { task: "flaky", checks: [{ passed: false }] },
      { task: "flaky", checks: [{ passed: false }] },
      { task: "only-cand", checks: [{ passed: false }] },
    ],
  });
  assert.equal(res.passed, true);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.redTasks, []);
  assert.deepEqual(res.skippedTasks, ["only-base", "only-cand"]);
});

test("R03: runBenchmark --replay подменяет живой вызов ответом из кассеты ($0, checks pass)", () => {
  const repoDir = createGitRepo("bench-replay-unit-");
  try {
    mkdirSync(join(repoDir, "bench", "cassettes"), { recursive: true });
    const prompt = "Return answer in result.txt";
    const tasksFile = join(repoDir, "bench", "tasks.json");
    const cassetteFile = join(repoDir, "bench", "cassettes", "t-replay.json");

    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "t-replay",
              tier: "safety",
              prompt,
              checks: [
                "node -e \"if(require('fs').readFileSync('result.txt','utf8').trim()!=='REPLAY_OK') process.exit(1);\"",
              ],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    recordCassette({
      taskId: "t-replay",
      prompt,
      response: "REPLAY_OK",
      files: {
        "result.txt": "REPLAY_OK\n",
      },
      out: cassetteFile,
      model: "replay-arm",
    });

    const results = runBenchmark({
      root: repoDir,
      taskId: "t-replay",
      arm: "candidate",
      cmd: "node -e 'process.exit(42)'", // failed live command must not be run
      replay: cassetteFile,
      runs: 1,
      yes: true,
    });

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.status, "ok");
    assert.equal(r.agentExit, 0);
    assert.equal(r.cost?.total_usd, 0);
    assert.equal(r.checks[0].passed, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("R03: runBenchmark --record сохраняет кассету после живого прогона", () => {
  const repoDir = createGitRepo("bench-record-unit-");
  try {
    mkdirSync(join(repoDir, "bench", "cassettes"), { recursive: true });
    const prompt = "Record prompt test";
    const tasksFile = join(repoDir, "bench", "tasks.json");
    const cassetteOut = join(repoDir, "bench", "cassettes", "recorded.json");

    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "t-record",
              tier: "standard",
              prompt,
              checks: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    runBenchmark({
      root: repoDir,
      taskId: "t-record",
      arm: "live-arm",
      cmd: "node -e \"require('fs').writeFileSync('artifact.txt','hello recorded\\n'); console.log('live response');\"",
      record: cassetteOut,
      runs: 1,
      yes: true,
    });

    assert.equal(existsSync(cassetteOut), true);
    const cassette = loadCassette(cassetteOut);
    assert.ok(cassette);
    assert.equal(cassette.version, 1);
    assert.equal(cassette.turns.length, 1);
    assert.equal(cassette.turns[0].promptHash, hashPrompt(prompt));
    assert.match(cassette.turns[0].response, /live response/);
    assert.equal(cassette.turns[0].files["artifact.txt"], "hello recorded\n");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("R03: runBenchmark --replay дрейф промпта бросает STALE-ошибку с кодом 1", () => {
  const repoDir = createGitRepo("bench-drift-unit-");
  try {
    mkdirSync(join(repoDir, "bench", "cassettes"), { recursive: true });
    const tasksFile = join(repoDir, "bench", "tasks.json");
    const cassetteFile = join(repoDir, "bench", "cassettes", "orig.json");

    writeFileSync(
      tasksFile,
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "t-drift",
              tier: "safety",
              prompt: "Prompt changed compared to cassette",
              checks: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    recordCassette({
      taskId: "t-drift",
      prompt: "Original prompt in cassette",
      response: "Orig response",
      out: cassetteFile,
      model: "drift-arm",
    });

    assert.throws(
      () =>
        runBenchmark({
          root: repoDir,
          taskId: "t-drift",
          arm: "candidate",
          cmd: "exit 0",
          replay: cassetteFile,
          runs: 1,
          yes: true,
        }),
      (err) => err.exitCode === 1 && /STALE prompt drift/.test(err.message)
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
