/**
 * tools/tests/benchmark-integration.test.mjs — Интеграционные тесты benchmark (R02 tasks/smoke + R03 replay/record).
 *
 * defer: benchmark integration test suite | ceiling: 700 lines | upgrade: split replay into benchmark-replay.test.mjs
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
  validateTasks,
  runSmoke,
  parseArgs,
} from "../benchmark.mjs";

const CLI_PATH = fileURLToPath(new URL("../benchmark.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
import { recordCassette, loadCassette, hashPrompt } from "../lm-replay.mjs";
import { createTempDir, createGitRepo } from "./test-helpers.mjs";

test("R02: bench/tasks.json содержит 11 валидных задач и проходит validate-tasks", () => {
  const res = validateTasks(REPO_ROOT);
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.ok(res.count >= 11, `ожидалось >= 11 задач (получено: ${res.count})`);

  const cli = spawnSync(process.execPath, [CLI_PATH, "validate-tasks", "--root", REPO_ROOT, "--json"], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.valid, true);
  assert.ok(parsed.count >= 11);
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
