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
  formatReport,
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
      tasks: [{ id: taskId, title: "t", prompt: "p", setup: [], checks: [], timeoutSec: 60 }],
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
      `require('child_process').execSync('git add -A && git commit -m agent-work')"`;

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
