#!/usr/bin/env node
/**
 * benchmark.mjs — инструмент замера ценности воркфлоу (Benchmark Harness).
 *
 * Изолированные прогоны задач по «армам» в свежих git-клонах,
 * измерение метрик (LOC, время, проверки, стоимость), отчёты и сравнение.
 *
 * Требования: Node 18+, LF, без внешних зависимостей.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TASKS_FILE = "bench/tasks.json";
export const RUNS_DIR = "bench/runs";

export const DEFAULT_TASKS_TEMPLATE = {
  version: 1,
  tasks: [
    {
      id: "sample-task",
      title: "Пример задачи бенчмарка",
      prompt: "Создайте файл answer.txt со словом hello",
      setup: [],
      checks: [
        "node -e \"const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);\"",
      ],
      timeoutSec: 300,
    },
  ],
};

export const DEFAULT_README_CONTENT = `# Бенчмарки воркфлоу (bench/)

Директория для замера ценности подходов, конфигураций и промптов («армов») на фиксированных задачах.

## Структура
- \`tasks.json\` — список задач, промпты, шаги setup и верификационные проверки.
- \`runs/\` — изолированные результаты запусков (добавлено в \`.gitignore\`).

## Быстрый старт
\`\`\`bash
# 1. Посмотреть задачи
node tools/benchmark.mjs list

# 2. План запуска без выполнения
node tools/benchmark.mjs run --task sample-task --arm my-agent --cmd "my-runner {prompt_file}" --dry-run

# 3. Боевой запуск
node tools/benchmark.mjs run --task sample-task --arm my-agent --cmd "my-runner {prompt_file}" --yes

# 4. Отчет и сравнение
node tools/benchmark.mjs report
node tools/benchmark.mjs compare --baseline base-arm --candidate my-agent
\`\`\`
`;

export const DEFAULT_GITIGNORE_CONTENT = `runs/\n`;

/**
 * Проверяет, является ли каталог валидным git-репозиторием.
 * @param {string} dir
 * @returns {boolean}
 */
export function isGitRepo(dir) {
  try {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      shell: false,
    });
    return res.status === 0 && res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Инициализирует bench-инфраструктуру в корне проекта.
 * @param {string} root
 * @returns {{created: string[], skipped: string[]}}
 */
export function initBenchmark(root) {
  const absRoot = resolve(root || ".");
  const benchDir = join(absRoot, "bench");
  if (!existsSync(benchDir)) {
    mkdirSync(benchDir, { recursive: true });
  }

  const created = [];
  const skipped = [];

  const files = [
    {
      rel: TASKS_FILE,
      content: JSON.stringify(DEFAULT_TASKS_TEMPLATE, null, 2) + "\n",
    },
    {
      rel: "bench/README.md",
      content: DEFAULT_README_CONTENT,
    },
    {
      rel: "bench/.gitignore",
      content: DEFAULT_GITIGNORE_CONTENT,
    },
  ];

  for (const f of files) {
    const fullPath = join(absRoot, f.rel);
    if (existsSync(fullPath)) {
      skipped.push(f.rel);
    } else {
      const parent = join(fullPath, "..");
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      writeFileSync(fullPath, f.content, "utf8");
      created.push(f.rel);
    }
  }

  return { created, skipped };
}

/**
 * Загружает tasks.json из корня.
 * @param {string} root
 * @returns {{version: number, tasks: Array<any>}}
 */
export function loadTasks(root) {
  const absRoot = resolve(root || ".");
  const tasksPath = join(absRoot, TASKS_FILE);
  if (!existsSync(tasksPath)) {
    throw new Error(`Файл задач не найден: ${tasksPath}. Запустите 'init'.`);
  }

  let raw;
  try {
    raw = readFileSync(tasksPath, "utf8");
  } catch (err) {
    throw new Error(`Ошибка чтения ${tasksPath}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Некорректный JSON в ${tasksPath}: ${err.message}`);
  }

  if (!data || typeof data !== "object" || !Array.isArray(data.tasks)) {
    throw new Error(`Некорректный формат ${tasksPath}: ожидается объект со списком tasks.`);
  }

  for (const t of data.tasks) {
    if (!t || typeof t !== "object" || !t.id || typeof t.id !== "string") {
      throw new Error(`Задача в ${tasksPath} должна содержать непустой строковый 'id'.`);
    }
    if (!t.prompt || typeof t.prompt !== "string") {
      throw new Error(`Задача '${t.id}' должна содержать строковый 'prompt'.`);
    }
  }

  return data;
}

/**
 * Вспомогательная функция вычисления медианы чисел.
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Опциональный расчет стоимости через python tools/session_cost.py
 * @param {string} root
 * @param {string} transcriptPath
 * @returns {object|undefined}
 */
function evaluateCost(root, transcriptPath) {
  if (!transcriptPath) return undefined;
  const absRoot = resolve(root || ".");
  const absTranscript = isAbsolute(transcriptPath) ? transcriptPath : resolve(absRoot, transcriptPath);
  if (!existsSync(absTranscript)) {
    return { note: `Файл транскрипта не найден: ${transcriptPath}` };
  }

  const scriptPath = join(absRoot, "tools", "session_cost.py");
  if (!existsSync(scriptPath)) {
    return { note: `Скрипт расчета стоимости tools/session_cost.py не найден` };
  }

  // Сначала пробуем python3, затем python
  const commands = ["python3", "python"];
  let lastErr = "";
  for (const py of commands) {
    try {
      const res = spawnSync(py, [scriptPath, absTranscript, "--json"], {
        cwd: absRoot,
        encoding: "utf8",
        shell: false,
      });
      if (res.status === 0 && res.stdout) {
        try {
          return JSON.parse(res.stdout);
        } catch (e) {
          lastErr = `Некорректный JSON от session_cost.py: ${e.message}`;
        }
      } else {
        lastErr = res.stderr || `Код возврата ${res.status}`;
      }
    } catch (e) {
      lastErr = e.message;
    }
  }

  return { note: `Не удалось вычислить стоимость: ${lastErr.trim()}` };
}

/**
 * Запуск бенчмарка.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.taskId
 * @param {string} options.arm
 * @param {string} options.cmd
 * @param {number} [options.runs=1]
 * @param {number} [options.timeoutSec]
 * @param {string} [options.transcript]
 * @param {boolean} [options.yes=false]
 * @param {boolean} [options.dryRun=false]
 * @returns {object|Array<object>} план (при dryRun) или массив результатов
 */
export function runBenchmark(options) {
  const {
    root,
    taskId,
    arm,
    cmd,
    runs = 1,
    timeoutSec,
    transcript,
    yes = false,
    dryRun = false,
  } = options;

  const absRoot = resolve(root || ".");
  if (!isGitRepo(absRoot)) {
    const err = new Error(`Указанный корень не является git-репозиторием: ${absRoot}`);
    err.exitCode = 2;
    throw err;
  }

  const tasksData = loadTasks(absRoot);
  const task = tasksData.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Задача '${taskId}' не найдена в ${TASKS_FILE}`);
  }

  if (!arm) {
    throw new Error("Не указано имя арма (--arm)");
  }
  if (!cmd) {
    throw new Error("Не указан шаблон команды арма (--cmd)");
  }

  const runCount = Number(runs) > 0 ? Number(runs) : 1;
  const taskTimeoutSec = timeoutSec !== undefined && timeoutSec !== null
    ? Number(timeoutSec)
    : (task.timeoutSec || 300);

  // План запусков
  const plan = {
    taskId,
    arm,
    runsCount: runCount,
    timeoutSec: taskTimeoutSec,
    cmdTemplate: cmd,
    transcript: transcript || null,
    setup: task.setup || [],
    checks: task.checks || [],
    plannedRuns: [],
  };

  const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 1; n <= runCount; n++) {
    const runId = `${nowIso}-${taskId}-${arm}-${n}`;
    const runDir = join(absRoot, RUNS_DIR, runId);
    plan.plannedRuns.push({
      runNumber: n,
      runId,
      runDir,
      repoDir: join(runDir, "repo"),
      logPath: join(runDir, "agent.log"),
    });
  }

  if (dryRun) {
    return plan;
  }

  if (!yes) {
    const err = new Error("Запуск бенчмарка требует подтверждения флагом --yes");
    err.exitCode = 1;
    throw err;
  }

  const results = [];

  for (const item of plan.plannedRuns) {
    const { runId, runDir, repoDir, logPath } = item;
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }

    const promptFilePath = join(runDir, "prompt.txt");
    writeFileSync(promptFilePath, task.prompt, "utf8");

    // 1. Клон репозитория: git clone --quiet --local <root> <repoDir>
    const cloneRes = spawnSync("git", ["clone", "--quiet", "--local", absRoot, repoDir], {
      cwd: runDir,
      encoding: "utf8",
      shell: false,
    });
    if (cloneRes.status !== 0) {
      throw new Error(`Ошибка git clone: ${cloneRes.stderr || cloneRes.stdout}`);
    }

    // 2. Setup команды внутри клона repoDir
    if (Array.isArray(task.setup)) {
      for (const step of task.setup) {
        if (!step) continue;
        const sRes = spawnSync(step, {
          cwd: repoDir,
          encoding: "utf8",
          shell: true,
        });
        if (sRes.status !== 0) {
          // Записываем ошибку setup в лог
          const setupErr = `\n[BENCHMARK SETUP ERROR] '${step}' exited with code ${sRes.status}\n${sRes.stderr || ""}\n`;
          writeFileSync(logPath, setupErr, { flag: "a", encoding: "utf8" });
        }
      }
    }

    // 3. Подготовка команды арма
    // Плейсхолдеры: {prompt_file}, {run_dir}, {task_id}, {arm}
    let renderedCmd = cmd
      .replace(/\{prompt_file\}/g, promptFilePath)
      .replace(/\{run_dir\}/g, runDir)
      .replace(/\{task_id\}/g, taskId)
      .replace(/\{arm\}/g, arm);

    const env = {
      ...process.env,
      BENCH_TASK_PROMPT: task.prompt,
      BENCH_RUN_DIR: runDir,
      BENCH_ARM: arm,
      BENCH_RUN_ID: runId,
    };

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let status = "ok";
    let agentExit = 0;
    let agentStdout = "";
    let agentStderr = "";

    try {
      const agentRes = spawnSync(renderedCmd, {
        cwd: repoDir,
        encoding: "utf8",
        shell: true,
        timeout: taskTimeoutSec > 0 ? taskTimeoutSec * 1000 : undefined,
        env,
      });

      agentStdout = agentRes.stdout || "";
      agentStderr = agentRes.stderr || "";

      if (agentRes.error && agentRes.error.code === "ETIMEDOUT") {
        status = "timeout";
        agentExit = -1;
      } else if (agentRes.signal === "SIGTERM" && (Date.now() - startTime >= taskTimeoutSec * 1000 - 500)) {
        status = "timeout";
        agentExit = -1;
      } else if (agentRes.status !== 0) {
        status = "error";
        agentExit = agentRes.status ?? -1;
      } else {
        agentExit = 0;
      }
    } catch (e) {
      status = "error";
      agentExit = -1;
      agentStderr += `\n${e.message}\n`;
    }

    const durationMs = Date.now() - startTime;

    // Лог в agent.log
    const fullLog = `=== STDOUT ===\n${agentStdout}\n=== STDERR ===\n${agentStderr}\n`;
    writeFileSync(logPath, fullLog, "utf8");

    // 4. Метрики изменений: git -C repo add -A then git -C repo diff --cached --numstat HEAD
    spawnSync("git", ["-C", repoDir, "add", "-A"], { encoding: "utf8", shell: false });
    const diffRes = spawnSync("git", ["-C", repoDir, "diff", "--cached", "--numstat", "HEAD"], {
      encoding: "utf8",
      shell: false,
    });

    const metrics = {
      linesAdded: 0,
      linesDeleted: 0,
      filesChanged: 0,
      files: [],
    };

    if (diffRes.status === 0 && diffRes.stdout) {
      const lines = diffRes.stdout.trim().split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
          const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
          const file = parts.slice(2).join("\t").trim();
          metrics.linesAdded += added;
          metrics.linesDeleted += deleted;
          metrics.filesChanged += 1;
          metrics.files.push({ added, deleted, file });
        }
      }
    }

    // 5. Проверки checks inside repoDir
    const checksResults = [];
    if (Array.isArray(task.checks)) {
      for (const cCmd of task.checks) {
        if (!cCmd) continue;
        const cRes = spawnSync(cCmd, {
          cwd: repoDir,
          encoding: "utf8",
          shell: true,
        });

        const code = cRes.status ?? (cRes.signal ? -1 : 0);
        const passed = code === 0;
        const outText = (cRes.stdout || "") + (cRes.stderr || "");
        const lines = outText.trim().split("\n");
        const tail = lines.slice(-5).join("\n");

        checksResults.push({
          cmd: cCmd,
          code,
          passed,
          tail,
        });
      }
    }

    // 6. Стоимость (cost)
    const cost = evaluateCost(absRoot, transcript);

    // 7. Сборка result.json
    const resultJson = {
      version: 1,
      task: taskId,
      arm,
      run: item.runNumber,
      startedAt,
      durationMs,
      status,
      agentExit,
      metrics,
      checks: checksResults,
      ...(cost !== undefined ? { cost } : {}),
      logPath,
    };

    const resultPath = join(runDir, "result.json");
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2) + "\n", "utf8");
    results.push(resultJson);
  }

  return results;
}

/**
 * Агрегирует прогоны из bench/runs
 * @param {string} root
 * @returns {{byTaskArm: Record<string, object>, total: number}}
 */
export function summarizeRuns(root) {
  const absRoot = resolve(root || ".");
  const runsDir = join(absRoot, RUNS_DIR);

  if (!existsSync(runsDir)) {
    return { byTaskArm: {}, total: 0 };
  }

  let entries = [];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return { byTaskArm: {}, total: 0 };
  }

  const byTaskArm = {};
  let totalRuns = 0;

  for (const entry of entries) {
    const resFile = join(runsDir, entry, "result.json");
    if (!existsSync(resFile)) continue;

    let res;
    try {
      res = JSON.parse(readFileSync(resFile, "utf8"));
    } catch {
      continue;
    }

    if (!res || !res.task || !res.arm) continue;

    const key = `${res.task}::${res.arm}`;
    if (!byTaskArm[key]) {
      byTaskArm[key] = {
        task: res.task,
        arm: res.arm,
        runs: 0,
        durations: [],
        linesAddedList: [],
        linesDeletedList: [],
        filesChangedList: [],
        checksPassed: 0,
        checksTotal: 0,
        costs: [],
        statuses: { ok: 0, timeout: 0, error: 0 },
      };
    }

    const group = byTaskArm[key];
    group.runs += 1;
    totalRuns += 1;

    if (typeof res.durationMs === "number") {
      group.durations.push(res.durationMs);
    }
    if (res.metrics) {
      if (typeof res.metrics.linesAdded === "number") group.linesAddedList.push(res.metrics.linesAdded);
      if (typeof res.metrics.linesDeleted === "number") group.linesDeletedList.push(res.metrics.linesDeleted);
      if (typeof res.metrics.filesChanged === "number") group.filesChangedList.push(res.metrics.filesChanged);
    }
    if (Array.isArray(res.checks)) {
      for (const ch of res.checks) {
        group.checksTotal += 1;
        if (ch && ch.passed) group.checksPassed += 1;
      }
    }
    if (res.cost && typeof res.cost.total_usd === "number") {
      group.costs.push(res.cost.total_usd);
    }
    if (res.status && group.statuses[res.status] !== undefined) {
      group.statuses[res.status] += 1;
    }
  }

  // Преобразуем списки в медианы и удобные сводные поля
  for (const key of Object.keys(byTaskArm)) {
    const g = byTaskArm[key];
    g.medianDurationMs = Math.round(median(g.durations));
    g.medianLinesAdded = Math.round(median(g.linesAddedList));
    g.medianLinesDeleted = Math.round(median(g.linesDeletedList));
    g.medianFilesChanged = Math.round(median(g.filesChangedList));
    g.medianCostUsd = g.costs.length > 0 ? Number(median(g.costs).toFixed(4)) : null;
  }

  return { byTaskArm, total: totalRuns };
}

/**
 * Сравнивает два арма по задачам и суммарно.
 * @param {object} summary
 * @param {string} baselineArm
 * @param {string} candidateArm
 * @returns {{byTask: Array<object>, aggregate: object}}
 */
export function compareArms(summary, baselineArm, candidateArm) {
  const { byTaskArm = {} } = summary || {};

  // Находим все задачи, для которых есть данные хотя бы по одному из армов
  const tasksSet = new Set();
  for (const item of Object.values(byTaskArm)) {
    if (item.arm === baselineArm || item.arm === candidateArm) {
      tasksSet.add(item.task);
    }
  }

  const byTask = [];
  let baseTotalLines = 0;
  let candTotalLines = 0;
  let hasLines = false;

  let baseTotalDuration = 0;
  let candTotalDuration = 0;
  let hasDuration = false;

  let baseChecksPassed = 0;
  let baseChecksTotal = 0;
  let candChecksPassed = 0;
  let candChecksTotal = 0;

  for (const taskId of Array.from(tasksSet).sort()) {
    const baseKey = `${taskId}::${baselineArm}`;
    const candKey = `${taskId}::${candidateArm}`;
    const base = byTaskArm[baseKey];
    const cand = byTaskArm[candKey];

    const item = {
      task: taskId,
      baseline: base
        ? {
            runs: base.runs,
            medianDurationMs: base.medianDurationMs,
            medianLinesAdded: base.medianLinesAdded,
            checksPassed: base.checksPassed,
            checksTotal: base.checksTotal,
            medianCostUsd: base.medianCostUsd,
          }
        : null,
      candidate: cand
        ? {
            runs: cand.runs,
            medianDurationMs: cand.medianDurationMs,
            medianLinesAdded: cand.medianLinesAdded,
            checksPassed: cand.checksPassed,
            checksTotal: cand.checksTotal,
            medianCostUsd: cand.medianCostUsd,
          }
        : null,
      deltas: {},
    };

    if (base && cand) {
      hasLines = true;
      baseTotalLines += base.medianLinesAdded;
      candTotalLines += cand.medianLinesAdded;

      hasDuration = true;
      baseTotalDuration += base.medianDurationMs;
      candTotalDuration += cand.medianDurationMs;

      baseChecksPassed += base.checksPassed;
      baseChecksTotal += base.checksTotal;
      candChecksPassed += cand.checksPassed;
      candChecksTotal += cand.checksTotal;

      const linesDiff = cand.medianLinesAdded - base.medianLinesAdded;
      const linesPct = base.medianLinesAdded > 0
        ? ((linesDiff / base.medianLinesAdded) * 100).toFixed(1)
        : null;

      const durDiff = cand.medianDurationMs - base.medianDurationMs;
      const durPct = base.medianDurationMs > 0
        ? ((durDiff / base.medianDurationMs) * 100).toFixed(1)
        : null;

      const baseCheckRate = base.checksTotal > 0 ? (base.checksPassed / base.checksTotal) : 0;
      const candCheckRate = cand.checksTotal > 0 ? (cand.checksPassed / cand.checksTotal) : 0;

      item.deltas = {
        linesDiff,
        linesPct: linesPct !== null ? Number(linesPct) : null,
        durationMsDiff: durDiff,
        durationPct: durPct !== null ? Number(durPct) : null,
        checksRateBase: Number((baseCheckRate * 100).toFixed(1)),
        checksRateCandidate: Number((candCheckRate * 100).toFixed(1)),
      };
    }

    byTask.push(item);
  }

  const aggregate = {
    baselineArm,
    candidateArm,
    linesDiff: hasLines ? candTotalLines - baseTotalLines : null,
    linesPct: hasLines && baseTotalLines > 0
      ? Number((((candTotalLines - baseTotalLines) / baseTotalLines) * 100).toFixed(1))
      : null,
    durationMsDiff: hasDuration ? candTotalDuration - baseTotalDuration : null,
    durationPct: hasDuration && baseTotalDuration > 0
      ? Number((((candTotalDuration - baseTotalDuration) / baseTotalDuration) * 100).toFixed(1))
      : null,
    baseChecks: { passed: baseChecksPassed, total: baseChecksTotal },
    candidateChecks: { passed: candChecksPassed, total: candChecksTotal },
  };

  return { byTask, aggregate };
}

/**
 * Парсер аргументов командной строки.
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const args = {
    command: null,
    root: ".",
    task: null,
    arm: null,
    cmd: null,
    runs: 1,
    timeout: null,
    transcript: null,
    dryRun: false,
    yes: false,
    json: false,
    baseline: null,
    candidate: null,
    help: false,
    _: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--root") {
      args.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      args.root = arg.slice(7);
    } else if (arg === "--task") {
      args.task = argv[++i];
    } else if (arg.startsWith("--task=")) {
      args.task = arg.slice(7);
    } else if (arg === "--arm") {
      args.arm = argv[++i];
    } else if (arg.startsWith("--arm=")) {
      args.arm = arg.slice(6);
    } else if (arg === "--cmd") {
      args.cmd = argv[++i];
    } else if (arg.startsWith("--cmd=")) {
      args.cmd = arg.slice(6);
    } else if (arg === "--runs") {
      args.runs = parseInt(argv[++i], 10) || 1;
    } else if (arg.startsWith("--runs=")) {
      args.runs = parseInt(arg.slice(7), 10) || 1;
    } else if (arg === "--timeout") {
      args.timeout = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--timeout=")) {
      args.timeout = parseInt(arg.slice(10), 10);
    } else if (arg === "--transcript") {
      args.transcript = argv[++i];
    } else if (arg.startsWith("--transcript=")) {
      args.transcript = arg.slice(13);
    } else if (arg === "--baseline") {
      args.baseline = argv[++i];
    } else if (arg.startsWith("--baseline=")) {
      args.baseline = arg.slice(11);
    } else if (arg === "--candidate") {
      args.candidate = argv[++i];
    } else if (arg.startsWith("--candidate=")) {
      args.candidate = arg.slice(12);
    } else if (!arg.startsWith("-")) {
      if (!args.command) {
        args.command = arg;
      } else {
        args._.push(arg);
      }
    }
  }

  return args;
}

function printUsage() {
  console.log(`benchmark.mjs — инструмент замера ценности воркфлоу (Benchmark Harness)

Использование:
  node tools/benchmark.mjs <команда> [опции]

Команды:
  init      Инициализировать директорию bench/ (tasks.json, README.md, .gitignore)
  list      Вывести список задач из bench/tasks.json
  run       Выполнить бенчмарк задачи по арму в изолированном git-клоне
  report    Показать агрегированный отчет по всем выполненным прогонам
  compare   Сравнить два арма (--baseline <arm> --candidate <arm>)

Опции:
  --root <dir>           Корень репозитория (по умолчанию: .)
  --task <id>            Идентификатор задачи для run
  --arm <name>           Имя арма (конфигурации/агента)
  --cmd "<template>"     Команда запуска агента с плейсхолдерами
  --runs <N>             Количество повторных запусков (по умолчанию: 1)
  --timeout <sec>        Таймаут выполнения команды в секундах
  --transcript <path>    Путь к транскрипту для подсчета стоимости (session_cost.py)
  --dry-run              Показать план запуска без создания файлов и выполнения команд
  --yes, -y              Подтверждение запуска бенчмарка (обязательно для run)
  --json                 Вывод результата в формате JSON
  --baseline <arm>       Базовый арм для команды compare
  --candidate <arm>      Сравниваемый кандидатный арм для команды compare
  --help, -h             Показать эту справку
`);
}

/**
 * Точка входа CLI.
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help || !args.command) {
    printUsage();
    return 0;
  }

  const absRoot = resolve(args.root || ".");

  // Проверка git-репозитория требуется для run, init и остальных команд для предсказуемости
  if (args.command === "run") {
    if (!isGitRepo(absRoot)) {
      console.error(`Ошибка: директория '${absRoot}' не является git-репозиторием.`);
      return 2;
    }
  }

  switch (args.command) {
    case "init": {
      try {
        const res = initBenchmark(absRoot);
        if (args.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res.created.length > 0) {
            console.log(`Созданы файлы: ${res.created.join(", ")}`);
          }
          if (res.skipped.length > 0) {
            console.log(`Пропущены существующие: ${res.skipped.join(", ")}`);
          }
          if (res.created.length === 0 && res.skipped.length === 0) {
            console.log("Инфраструктура bench/ уже инициализирована.");
          }
        }
        return 0;
      } catch (err) {
        console.error(`Ошибка инициализации: ${err.message}`);
        return 1;
      }
    }

    case "list": {
      try {
        const data = loadTasks(absRoot);
        if (args.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Задачи бенчмарка (версия ${data.version}):`);
          for (const t of data.tasks) {
            console.log(`  - [${t.id}] ${t.title || "(без названия)"}`);
            console.log(`    Промпт: ${t.prompt.replace(/\n/g, " ").slice(0, 70)}...`);
            if (t.checks && t.checks.length > 0) {
              console.log(`    Проверок: ${t.checks.length}`);
            }
          }
        }
        return 0;
      } catch (err) {
        console.error(`Ошибка: ${err.message}`);
        return 1;
      }
    }

    case "run": {
      try {
        if (!args.dryRun && !args.yes) {
          console.error("Отказ: запуск бенчмарка требует подтверждения флагом --yes (или используйте --dry-run).");
          return 1;
        }

        const result = runBenchmark({
          root: absRoot,
          taskId: args.task,
          arm: args.arm,
          cmd: args.cmd,
          runs: args.runs,
          timeoutSec: args.timeout,
          transcript: args.transcript,
          yes: args.yes,
          dryRun: args.dryRun,
        });

        if (args.dryRun) {
          if (args.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log("=== План запуска бенчмарка (dry-run) ===");
            console.log(`Задача: ${result.taskId}`);
            console.log(`Арм: ${result.arm}`);
            console.log(`Повторов: ${result.runsCount}`);
            console.log(`Таймаут: ${result.timeoutSec} сек`);
            console.log(`Шаблон команды: ${result.cmdTemplate}`);
            console.log("Запланированные прогоны:");
            for (const r of result.plannedRuns) {
              console.log(`  #${r.runNumber}: ${r.runId} -> ${r.runDir}`);
            }
            if (result.setup && result.setup.length > 0) {
              console.log(`Команды setup: ${result.setup.join(" && ")}`);
            }
            if (result.checks && result.checks.length > 0) {
              console.log(`Проверки: ${result.checks.join("; ")}`);
            }
          }
          return 0;
        }

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Выполнено прогонов: ${result.length}`);
          for (const res of result) {
            const checksPass = res.checks.filter((c) => c.passed).length;
            const checksTotal = res.checks.length;
            console.log(
              `  [${res.run}] Статус: ${res.status}, Время: ${res.durationMs}ms, LOC: +${res.metrics.linesAdded}/-${res.metrics.linesDeleted}, Проверки: ${checksPass}/${checksTotal}`
            );
          }
        }
        return 0;
      } catch (err) {
        if (err.exitCode) {
          console.error(`Ошибка: ${err.message}`);
          return err.exitCode;
        }
        console.error(`Ошибка выполнения бенчмарка: ${err.message}`);
        return 1;
      }
    }

    case "report": {
      try {
        const summary = summarizeRuns(absRoot);
        if (summary.total === 0) {
          if (args.json) {
            console.log(JSON.stringify({ total: 0, byTaskArm: {} }, null, 2));
          } else {
            console.log("Запусков нет: сначала выполните benchmark run.");
          }
          return 0;
        }

        if (args.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`=== Отчет о бенчмарках (всего прогонов: ${summary.total}) ===`);
          console.log("Задача | Арм | Прогонов | Время (медиана) | LOC (+/-) | Файлов | Проверки | Стоимость");
          console.log("---|---|---|---|---|---|---|---");
          for (const item of Object.values(summary.byTaskArm)) {
            const costStr = item.medianCostUsd !== null ? `$${item.medianCostUsd}` : "-";
            console.log(
              `${item.task} | ${item.arm} | ${item.runs} | ${item.medianDurationMs}ms | +${item.medianLinesAdded}/-${item.medianLinesDeleted} | ${item.medianFilesChanged} | ${item.checksPassed}/${item.checksTotal} | ${costStr}`
            );
          }
        }
        return 0;
      } catch (err) {
        console.error(`Ошибка формирования отчета: ${err.message}`);
        return 1;
      }
    }

    case "compare": {
      try {
        if (!args.baseline || !args.candidate) {
          console.error("Ошибка: для compare необходимо указать --baseline <arm> и --candidate <arm>");
          return 1;
        }

        const summary = summarizeRuns(absRoot);
        const comparison = compareArms(summary, args.baseline, args.candidate);

        if (args.json) {
          console.log(JSON.stringify(comparison, null, 2));
        } else {
          console.log(`=== Сравнение: ${args.baseline} (базовый) vs ${args.candidate} (кандидат) ===`);
          if (comparison.byTask.length === 0) {
            console.log("Нет общих данных для сравнения указанных армов.");
            return 0;
          }

          for (const item of comparison.byTask) {
            console.log(`\nЗадача: ${item.task}`);
            if (!item.baseline) {
              console.log(`  Базовый арм '${args.baseline}': нет данных`);
            }
            if (!item.candidate) {
              console.log(`  Кандидат '${args.candidate}': нет данных`);
            }
            if (item.baseline && item.candidate) {
              const b = item.baseline;
              const c = item.candidate;
              const d = item.deltas;
              const linesPctStr = d.linesPct !== null ? ` (${d.linesPct > 0 ? "+" : ""}${d.linesPct}%)` : "";
              const durPctStr = d.durationPct !== null ? ` (${d.durationPct > 0 ? "+" : ""}${d.durationPct}%)` : "";

              console.log(`  LOC добавлено: ${b.medianLinesAdded} -> ${c.medianLinesAdded}${linesPctStr}`);
              console.log(`  Время: ${b.medianDurationMs}ms -> ${c.medianDurationMs}ms${durPctStr}`);
              console.log(
                `  Проверки: ${b.checksPassed}/${b.checksTotal} (${d.checksRateBase}%) -> ${c.checksPassed}/${c.checksTotal} (${d.checksRateCandidate}%)`
              );
            }
          }

          const agg = comparison.aggregate;
          const parts = [];
          if (agg.linesPct !== null) {
            const sign = agg.linesPct > 0 ? "+" : "";
            parts.push(`${sign}${agg.linesPct}% строк`);
          }
          if (agg.durationPct !== null) {
            const sign = agg.durationPct > 0 ? "+" : "";
            parts.push(`${sign}${agg.durationPct}% времени`);
          }
          if (agg.baseChecks.total > 0 || agg.candidateChecks.total > 0) {
            parts.push(`checks ${agg.baseChecks.passed}/${agg.baseChecks.total} -> ${agg.candidateChecks.passed}/${agg.candidateChecks.total}`);
          }

          console.log(`\nИтог: ${parts.length > 0 ? parts.join(", ") : "нет сравнимых метрик"}`);
        }
        return 0;
      } catch (err) {
        console.error(`Ошибка сравнения: ${err.message}`);
        return 1;
      }
    }

    default:
      console.error(`Неизвестная команда: '${args.command}'`);
      printUsage();
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
