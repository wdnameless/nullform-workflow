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
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  parseArgs,
  main,
} from "../benchmark.mjs";

const CLI_PATH = fileURLToPath(new URL("../benchmark.mjs", import.meta.url));

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "bench-test-"));
}

/**
 * Инициализирует временный git-репозиторий с одним коммитом.
 */
function createGitRepo() {
  const dir = createTempDir();
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "BenchTester"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "bench@test.local"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  writeFileSync(join(dir, "initial.txt"), "hello\n", "utf8");
  spawnSync("git", ["add", "initial.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: dir });
  return dir;
}

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
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].id, "sample-task");

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
