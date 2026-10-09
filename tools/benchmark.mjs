#!/usr/bin/env node
/**
 * benchmark.mjs — инструмент замера ценности воркфлоу (Benchmark Harness).
 *
 * Изолированные прогоны задач по «армам» в свежих git-клонах,
 * измерение метрик (LOC, время, проверки, стоимость), отчёты и сравнение.
 *
 * Требования: Node 18+, LF, без внешних зависимостей.
 *
 * defer: benchmark harness expansion with eval-metrics pass@k | ceiling: 2000 lines | upgrade: split reporter and comparison modules
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { executeReplayTurn, recordBenchmarkRun } from "./lm-replay.mjs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
export const TASKS_FILE = "bench/tasks.json";
export const RUNS_DIR = "bench/runs";

/**
 * Тиры задач: `safety` — проверка инвариантов и скрытых граничных условий,
 * `perf` — производительность, `standard` — обычная задача (по умолчанию).
 */
export const TASK_TIERS = ["standard", "safety", "perf"];

export const DEFAULT_TASKS_TEMPLATE = {
  version: 1,
  tasks: [
    {
      id: "sample-task",
      tier: "standard",
      title: "Пример задачи бенчмарка",
      prompt: "Создайте файл answer.txt со словом hello",
      setup: [],
      checks: [
        "node -e \"const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);\"",
      ],
      timeoutSec: 300,
    },
    {
      id: "safety-edge-case",
      tier: "safety",
      title: "Safety: Boundary Validation",
      prompt: "Реализуйте безопасную обработку граничных условий без утечек",
      checks: ["node -e \"process.exit(0)\""],
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
 * Служебные каталоги инструментов (индексатор OMP, карты, воркфлоу-состояние).
 * Их изменения — не работа агента, в метрики задачи они не попадают.
 */
export const TOOL_ARTIFACT_PATHS = [
  ".opencode",
  ".archmap",
  ".workflow",
  ".prompt-lint",
  "node_modules",
  "bench/runs",
];

/** Служебные каталоги как include-pathspec (для отдельного подсчёта артефактов). */
const TOOL_ARTIFACT_INCLUDES = TOOL_ARTIFACT_PATHS.map((p) => p);

/** Пустые метрики. */
function emptyMetrics() {
  return { linesAdded: 0, linesDeleted: 0, filesChanged: 0, files: [] };
}

/** Метрики = все изменения минус пути служебных артефактов инструментов. */
function subtractMetrics(all, tool) {
  const toolPaths = new Set(tool.files.map((f) => f.file));
  const files = all.files.filter((f) => !toolPaths.has(f.file));
  return {
    linesAdded: files.reduce((s, f) => s + f.added, 0),
    linesDeleted: files.reduce((s, f) => s + f.deleted, 0),
    filesChanged: files.length,
    files,
  };
}

/** Синхронный sleep без внешних зависимостей. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** git в контексте репозитория клона; read-only операции — без записи индекса. */
function git(repoDir, args, { optionalLocks = false } = {}) {
  const base = optionalLocks ? ["--no-optional-locks", "-C", repoDir] : ["-C", repoDir];
  return spawnSync("git", [...base, ...args], { encoding: "utf8", shell: false, windowsHide: true });
}

/** stdout успешной git-команды или "" при ошибке. */
function gitStdout(repoDir, args) {
  const res = git(repoDir, args);
  return res.status === 0 ? (res.stdout || "").trim() : "";
}

/** Разбор `git diff --numstat` в метрики. */
function parseNumstat(stdout) {
  const files = [];
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const line of (stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    files.push({ added, deleted, file: parts.slice(2).join("\t").trim() });
    linesAdded += added;
    linesDeleted += deleted;
  }
  return { linesAdded, linesDeleted, filesChanged: files.length, files };
}

/** Число строк в файле (для untracked-файлов в fallback-режиме). */
function countFileLines(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length === 0 ? 0 : text.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Собирает метрики изменений клона относительно базовой ревизии `baseSha`.
 *
 * Гарантии:
 *  - правки агента не теряются, даже если `git add` не сработал (залоченный индекс
 *    фоновым индексатором) — используется fallback на diff рабочего дерева;
 *  - коммиты агента учитываются (сравнение идёт с `baseSha`, а не с новым HEAD);
 *  - служебные каталоги инструментов считаются отдельно в `toolArtifacts`;
 *  - расхождение `git status` и метрик никогда не проглатывается — попадает в `warnings`.
 *
 * @param {string} repoDir
 * @param {string} baseSha базовая ревизия (до запуска агента), может быть ""
 * @returns {{metrics: object, toolArtifacts: object, worktreeChanges: number, warnings: string[]}}
 */
export function collectRunMetrics(repoDir, baseSha) {
  const warnings = [];
  const ref = baseSha || "HEAD";

  const staged = gitStaged(repoDir, warnings);
  const diffArgs = staged ? ["diff", "--cached"] : ["diff"];

  /** numstat относительно baseSha + untracked-файлы (только в fallback-режиме). */
  const collect = (pathspec) => {
    const res = git(repoDir, [...diffArgs, "--numstat", ref, "--", ...pathspec]);
    let acc = emptyMetrics();
    if (res.status === 0) {
      acc = parseNumstat(res.stdout);
    } else {
      warnings.push(`git diff --numstat не выполнен: ${(res.stderr || "").trim() || `exit ${res.status}`}`);
    }
    // Fallback: индекс не заполнен (залочен), поэтому untracked-файлы numstat не видит.
    if (!staged) {
      const untracked = git(repoDir, ["ls-files", "--others", "--exclude-standard", "--", ...pathspec], {
        optionalLocks: true,
      });
      if (untracked.status === 0) {
        for (const rel of (untracked.stdout || "").split("\n")) {
          const file = rel.trim();
          if (!file) continue;
          const added = countFileLines(join(repoDir, file));
          acc.files.push({ added, deleted: 0, file });
          acc.linesAdded += added;
          acc.filesChanged += 1;
        }
      } else {
        warnings.push(`git ls-files не выполнен: ${(untracked.stderr || "").trim() || `exit ${untracked.status}`}`);
      }
    }
    return acc;
  };

  // Все изменения минус служебные артефакты инструментов (они — не работа агента).
  const all = collect(["."]);
  const toolArtifacts = collect(TOOL_ARTIFACT_INCLUDES);
  const metrics = subtractMetrics(all, toolArtifacts);

  // Перекрёстная проверка: рабочее дерево не пусто, а метрики пусты — никогда не молчим.
  const statusRes = git(repoDir, ["status", "--porcelain"], { optionalLocks: true });
  let worktreeChanges;
  if (statusRes.status === 0) {
    worktreeChanges = (statusRes.stdout || "").split("\n").filter((l) => l.trim()).length;
    if (worktreeChanges > 0 && metrics.filesChanged === 0) {
      warnings.push(
        `git status сообщает о ${worktreeChanges} изменённых путях, но метрики пусты — правки агента не учтены`
      );
    }
  } else {
    worktreeChanges = metrics.filesChanged;
    warnings.push(`git status не выполнен: ${(statusRes.stderr || "").trim() || `exit ${statusRes.status}`}`);
  }

  return { metrics, toolArtifacts, worktreeChanges, warnings };
}

/**
 * Индексирует все изменения клона, переживая залоченный индекс (фоновый индексатор,
 * упавший процесс). При неудаче возвращает false и добавляет причину в `warnings`.
 *
 * @param {string} repoDir
 * @param {string[]} warnings
 * @returns {boolean} удалось ли проиндексировать изменения
 */
function gitStaged(repoDir, warnings) {
  const first = git(repoDir, ["add", "-A", "--", "."]);
  if (first.status === 0) return true;

  const firstError = (first.stderr || first.stdout || "").trim();
  sleepSync(300);
  const retry = git(repoDir, ["add", "-A", "--", "."]);
  if (retry.status === 0) return true;

  warnings.push(
    `git add -A не выполнен (${firstError || `exit ${retry.status}`}); метрики собраны из рабочего дерева`
  );
  return false;
}

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
      windowsHide: true,
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

  const seenIds = new Set();
  for (const t of data.tasks) {
    if (!t || typeof t !== "object" || !t.id || typeof t.id !== "string") {
      throw new Error(`Задача в ${tasksPath} должна содержать непустой строковый 'id'.`);
    }
    if (seenIds.has(t.id)) {
      throw new Error(`Дублирующийся id задачи '${t.id}' в ${tasksPath}: выбор задачи неоднозначен.`);
    }
    seenIds.add(t.id);
    if (!t.prompt || typeof t.prompt !== "string") {
      throw new Error(`Задача '${t.id}' должна содержать строковый 'prompt'.`);
    }
    if (t.setup !== undefined && !Array.isArray(t.setup)) {
      throw new Error(`Задача '${t.id}': 'setup' должен быть массивом команд.`);
    }
    if (t.tier !== undefined && (typeof t.tier !== "string" || !TASK_TIERS.includes(t.tier))) {
      throw new Error(
        `Задача '${t.id}': 'tier' должен быть строкой из ${TASK_TIERS.join(", ")} (получено: ${JSON.stringify(t.tier)}).`
      );
    }
    // Тир по умолчанию — standard: дальше по коду он всегда определён.
    t.tier = t.tier || "standard";
    if (t.checks !== undefined && !Array.isArray(t.checks)) {
      throw new Error(`Задача '${t.id}': 'checks' должен быть массивом команд.`);
    }
    if (
      t.timeoutSec !== undefined &&
      (typeof t.timeoutSec !== "number" || !Number.isFinite(t.timeoutSec) || t.timeoutSec < 0)
    ) {
      throw new Error(`Задача '${t.id}': 'timeoutSec' должен быть неотрицательным числом.`);
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

  // Сначала пробуем заданный извне интерпретатор, затем типовые имена/пути.
  // Только переносимые имена: конкретные пути машины в дистрибутиве недопустимы,
  // при необходимости путь задаётся снаружи через PYTHON_PATH.
  const commands = [process.env.PYTHON_PATH, "python3", "python", "py"].filter(Boolean);
  let lastErr = "";
  for (const py of commands) {
    try {
      const res = spawnSync(py, [scriptPath, absTranscript, "--json"], {
        cwd: absRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
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
 * Автоматический поиск самого свежего JSONL-транскрипта OMP, созданного/измененного
 * не ранее sinceMs. Позволяет замерять стоимость бенчмарка без явного флага --transcript.
 * @param {number} [sinceMs=0]
 * @returns {string|null}
 */
export function findRecentSessionTranscript(sinceMs = 0) {
  const sessionsDir = join(homedir(), ".omp", "agent", "sessions");
  if (!existsSync(sessionsDir)) return null;
  let newestFile = null;
  let newestMtime = sinceMs;

  function scan(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        scan(full);
      } else if (entry.endsWith(".jsonl") && st.mtimeMs >= newestMtime) {
        newestMtime = st.mtimeMs;
        newestFile = full;
      }
    }
  }

  scan(sessionsDir);
  return newestFile;
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
export function runBenchmark(options) { // code-size:allow
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
    replay = null,
    record = null,
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

  const effectiveArm = arm || (replay ? "replay" : null);
  const effectiveCmd = cmd || (replay ? "replay" : null);
  if (!effectiveArm) {
    throw new Error("Не указано имя арма (--arm)");
  }
  if (!effectiveCmd) {
    throw new Error("Не указан шаблон команды арма (--cmd)");
  }

  const runCount = runs == null ? 1 : Number(runs);
  if (!Number.isInteger(runCount) || runCount < 1) {
    const err = new Error(`Параметр runs должен быть целым числом >= 1 (получено: ${runs})`);
    err.exitCode = 2;
    throw err;
  }
  const taskTimeoutSec = timeoutSec !== undefined && timeoutSec !== null
    ? Number(timeoutSec)
    : (task.timeoutSec || 300);

  const plan = {
    taskId,
    arm: effectiveArm,
    runsCount: runCount,
    timeoutSec: taskTimeoutSec,
    cmdTemplate: effectiveCmd,
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
      windowsHide: true,
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
          windowsHide: true,
        });
        if (sRes.status !== 0) {
          // Записываем ошибку setup в лог
          const setupErr = `\n[BENCHMARK SETUP ERROR] '${step}' exited with code ${sRes.status}\n${sRes.stderr || ""}\n`;
          writeFileSync(logPath, setupErr, { flag: "a", encoding: "utf8" });
        }
      }
    }

    // 2a. Базовая ревизия: всё, что появилось после неё, — работа агента.
    // Берётся после setup, чтобы артефакты подготовки не приписывались агенту.
    const baseSha = gitStdout(repoDir, ["rev-parse", "HEAD"]);

    // 3. Подготовка команды арма
    // Плейсхолдеры: {prompt_file}, {run_dir}, {task_id}, {arm}
    let renderedCmd = effectiveCmd
      .replace(/\{prompt_file\}/g, promptFilePath)
      .replace(/\{run_dir\}/g, runDir)
      .replace(/\{task_id\}/g, taskId)
      .replace(/\{arm\}/g, effectiveArm);

    const env = {
      ...process.env,
      BENCH_TASK_PROMPT: task.prompt,
      BENCH_RUN_DIR: runDir,
      BENCH_ARM: effectiveArm,
      BENCH_RUN_ID: runId,
    };

    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let status = "ok";
    let agentExit = 0;
    let agentStdout = "";
    let agentStderr = "";

    if (replay) {
      const res = executeReplayTurn({ replay, absRoot, prompt: task.prompt, repoDir });
      agentStdout = res.stdout;
      agentStderr = res.stderr;
      agentExit = res.exitCode;
      status = res.status;
    } else {
      try {
        const agentRes = spawnSync(renderedCmd, {
          cwd: repoDir,
          encoding: "utf8",
          shell: true,
          timeout: taskTimeoutSec > 0 ? taskTimeoutSec * 1000 : undefined,
          env,
          windowsHide: true,
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
    }

    const durationMs = Date.now() - startTime;

    // Лог в agent.log
    const fullLog = `=== STDOUT ===\n${agentStdout}\n=== STDERR ===\n${agentStderr}\n`;
    writeFileSync(logPath, fullLog, "utf8");

    // 4. Метрики изменений относительно baseSha (правки + коммиты агента),
    // служебные каталоги инструментов — отдельно.
    const { metrics, toolArtifacts, worktreeChanges, warnings } = collectRunMetrics(repoDir, baseSha);
    const headSha = gitStdout(repoDir, ["rev-parse", "HEAD"]);
    if (!baseSha) {
      warnings.push("не удалось определить базовую ревизию (git rev-parse HEAD) — коммиты агента могут не попасть в метрики");
    }
    const commits =
      baseSha && headSha && baseSha !== headSha
        ? Number(gitStdout(repoDir, ["rev-list", "--count", `${baseSha}..${headSha}`])) || 0
        : 0;
    const metricsWarning = warnings.length > 0 ? warnings.join("; ") : null;

    // 5. Проверки checks inside repoDir
    const checksResults = [];
    if (Array.isArray(task.checks)) {
      for (const cCmd of task.checks) {
        if (!cCmd) continue;
        const cRes = spawnSync(cCmd, {
          cwd: repoDir,
          encoding: "utf8",
          shell: true,
          windowsHide: true,
          env,
        });

        const code = cRes.status ?? -1;
        const passed = code === 0;
        const tail = ((cRes.stdout || "") + (cRes.stderr || "")).trim().split("\n").slice(-5).join("\n");

        checksResults.push({
          cmd: cCmd,
          code,
          passed,
          tail,
        });
      }
    }

    const transcriptToUse = transcript ? transcript.replace(/\{run_dir\}/g, runDir) : findRecentSessionTranscript(startTime - 2000);
    const cost = replay ? { total_usd: 0 } : evaluateCost(absRoot, transcriptToUse);

    // 7. Сборка result.json
    const resultJson = {
      version: 1,
      task: taskId,
      arm: effectiveArm,
      runId,
      runDir,
      tier: task.tier || "standard",
      run: item.runNumber,
      startedAt,
      durationMs,
      status,
      agentExit,
      baseSha,
      headSha,
      commits,
      worktreeChanges,
      metrics,
      toolArtifacts,
      metricsWarning,
      checks: checksResults,
      ...(cost !== undefined ? { cost } : {}),
      logPath,
    };

    const resultPath = join(runDir, "result.json");
    writeFileSync(resultPath, JSON.stringify(resultJson, null, 2) + "\n", "utf8");
    results.push(resultJson);
    if (record) {
      recordBenchmarkRun({
        out: record,
        absRoot,
        prompt: task.prompt,
        response: agentStdout,
        repoDir,
        baseSha,
        cost,
        arm: effectiveArm,
      });
    }
  }

  return results;
}
/**
 * Считывает тиры задач из bench/tasks.json (тир по умолчанию: standard).
 * @param {string} root
 * @returns {Map<string, string>}
 */
export function readTaskTiers(root) {
  const map = new Map();
  try {
    const data = loadTasks(root);
    for (const t of data.tasks || []) {
      if (t && t.id) {
        map.set(t.id, t.tier || "standard");
      }
    }
  } catch {
    // tasks.json отсутствует или повреждён
  }
  return map;
}

/**
 * Проверяет, решена ли задача в рамках прогона (все checks задачи pass).
 * @param {object} res
 * @returns {boolean}
 */
export function isRunPassed(res) {
  if (!res || typeof res !== "object") return false;
  if (typeof res.passed === "boolean") return res.passed;
  if (Array.isArray(res.checks)) {
    if (res.checks.length === 0) return res.status === "ok";
    return res.checks.every((ch) => (typeof ch === "boolean" ? ch : Boolean(ch && ch.passed)));
  }
  return res.status === "ok";
}

/**
 * Вычисляет метрики pass@k и pass^k на task×arm и по всему набору.
 * K = фактическое число ранов в данных. При K=1 обе метрики равны pass rate.
 * Пустой набор возвращает 0 (не NaN).
 * @param {Array<object>|object} results
 * @returns {object}
 */
export function computePassK(results) {
  const emptyRes = {
    k: 0,
    passAtK: 0,
    passPowK: 0,
    totalTasks: 0,
    byTaskArm: {},
    byArm: {},
    byTask: {},
    "pass@k": 0,
    "pass^k": 0,
    "pass@0": 0,
    "pass^0": 0,
  };
  if (!results) return emptyRes;

  const rawGroups = new Map();
  const pushRun = (task, arm, item) => {
    const key = `${task}::${arm}`;
    if (!rawGroups.has(key)) rawGroups.set(key, { task, arm, runs: [] });
    rawGroups.get(key).runs.push(item);
  };

  if (Array.isArray(results)) {
    if (results.length === 0) return emptyRes;
    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      pushRun(item.task || "unknown", item.arm || "default", item);
    }
  } else if (typeof results === "object") {
    const source = results.byTaskArm && typeof results.byTaskArm === "object" ? results.byTaskArm : results;
    const entries = Object.entries(source);
    if (entries.length === 0) return emptyRes;
    for (const [k, item] of entries) {
      if (!item || typeof item !== "object") continue;
      const parts = k.includes("::") ? k.split("::") : [item.task || k, item.arm || "default"];
      const task = item.task || parts[0] || "unknown";
      const arm = item.arm || parts[1] || "default";
      pushRun(task, arm, item);
    }
  }

  if (rawGroups.size === 0) return emptyRes;

  const byTaskArm = {};
  const byTask = {};
  const armMap = new Map();

  for (const [key, group] of rawGroups.entries()) {
    const { task, arm, runs } = group;
    const k = runs.length;
    const passedRuns = runs.filter(isRunPassed).length;
    const passAtK = k > 0 && passedRuns >= 1 ? 1 : 0;
    const passPowK = k > 0 && passedRuns === k ? 1 : 0;
    const groupResult = { task, arm, k, runs: k, passedRuns, passAtK, passPowK };
    byTaskArm[key] = groupResult;
    if (!byTask[task]) byTask[task] = {};
    byTask[task][arm] = groupResult;
    if (!armMap.has(arm)) armMap.set(arm, []);
    armMap.get(arm).push(groupResult);
  }

  const allItems = Object.values(byTaskArm);
  const totalTasks = allItems.length;
  const actualK = totalTasks > 0 ? Math.max(0, ...allItems.map((it) => it.k)) : 0;
  const passedAtKCount = allItems.filter((it) => it.passAtK === 1).length;
  const passedPowKCount = allItems.filter((it) => it.passPowK === 1).length;
  const passAtK = totalTasks > 0 ? Number(((passedAtKCount / totalTasks) * 100).toFixed(1)) : 0;
  const passPowK = totalTasks > 0 ? Number(((passedPowKCount / totalTasks) * 100).toFixed(1)) : 0;

  const byArm = {};
  for (const [arm, items] of armMap.entries()) {
    const armK = items.length > 0 ? Math.max(0, ...items.map((it) => it.k)) : 0;
    const atK = items.filter((it) => it.passAtK === 1).length;
    const powK = items.filter((it) => it.passPowK === 1).length;
    byArm[arm] = {
      arm,
      k: armK,
      passAtK: items.length > 0 ? Number(((atK / items.length) * 100).toFixed(1)) : 0,
      passPowK: items.length > 0 ? Number(((powK / items.length) * 100).toFixed(1)) : 0,
      totalTasks: items.length,
      tasksPassedAtK: atK,
      tasksPassedPowK: powK,
    };
  }

  const out = {
    k: actualK,
    passAtK,
    passPowK,
    totalTasks,
    tasksPassedAtK: passedAtKCount,
    tasksPassedPowK: passedPowKCount,
    byTaskArm,
    byArm,
    byTask,
    "pass@k": passAtK,
    "pass^k": passPowK,
  };
  if (actualK !== undefined && actualK !== null) {
    out[`pass@${actualK}`] = passAtK;
    out[`pass^${actualK}`] = passPowK;
  }
  return out;
}

/**
 * Агрегирует прогоны из bench/runs
 * @param {string} root
 * @param {object} [options={}]
 * @returns {{byTaskArm: Record<string, object>, total: number, skipped: Array<object>, safetyChecksPassed: number, safetyChecksTotal: number, safetyPassRate: number|null, costTotal: number|null, costMedian: number|null}}
 */
export function summarizeRuns(root, options = {}) {
  const absRoot = resolve(root || ".");
  const runsDir = join(absRoot, RUNS_DIR);
  const tierFilter = options.tier || null;

  const skipped = [];
  let entries = [];
  if (existsSync(runsDir)) {
    try {
      entries = readdirSync(runsDir);
    } catch {
      entries = [];
    }
  }

  // Тир берётся из result.json, а для прогонов, записанных до появления поля, — из bench/tasks.json.
  const taskTiers = readTaskTiers(absRoot);

  const byTaskArm = {};
  let totalRuns = 0;
  let totalSafetyPassed = 0;
  let totalSafetyChecks = 0;
  const allCosts = [];
  const rawRuns = [];
  for (const entry of entries) {
    if (options.runIds && !options.runIds.includes(entry)) continue;
    const resFile = join(runsDir, entry, "result.json");
    if (!existsSync(resFile)) continue;

    let res;
    try {
      res = JSON.parse(readFileSync(resFile, "utf8"));
    } catch (err) {
      // Проглоченный result.json исчезал из отчёта и искажал выводы — фиксируем явно.
      skipped.push({ file: `${RUNS_DIR}/${entry}/result.json`, reason: `некорректный JSON: ${err.message}` });
      continue;
    }

    if (!res || typeof res !== "object" || !res.task || !res.arm) {
      skipped.push({ file: `${RUNS_DIR}/${entry}/result.json`, reason: "нет полей task/arm" });
      continue;
    }

    const runTier = res.tier || taskTiers.get(res.task) || "standard";
    if (tierFilter && runTier !== tierFilter) {
      continue;
    }
    rawRuns.push(res);

    const key = `${res.task}::${res.arm}`;
    if (!byTaskArm[key]) {
      byTaskArm[key] = {
        task: res.task,
        arm: res.arm,
        tier: runTier,
        runs: 0,
        durations: [],
        linesAddedList: [],
        linesDeletedList: [],
        filesChangedList: [],
        checksPassed: 0,
        checksTotal: 0,
        safetyChecksPassed: 0,
        safetyChecksTotal: 0,
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
      const isSafetyTask = runTier === "safety";
      for (const ch of res.checks) {
        group.checksTotal += 1;
        if (ch && ch.passed) group.checksPassed += 1;

        const isSafetyCheck = isSafetyTask || (ch && ch.tier === "safety");
        if (isSafetyCheck) {
          group.safetyChecksTotal += 1;
          totalSafetyChecks += 1;
          if (ch && ch.passed) {
            group.safetyChecksPassed += 1;
            totalSafetyPassed += 1;
          }
        }
      }
    }
    const costVal =
      typeof res.cost === "number"
        ? res.cost
        : res.cost && typeof res.cost.total_usd === "number"
          ? res.cost.total_usd
          : null;
    if (costVal !== null) {
      group.costs.push(costVal);
      allCosts.push(costVal);
    }
    if (res.status && group.statuses[res.status] !== undefined) {
      group.statuses[res.status] += 1;
    }
  }

  const passK = computePassK(rawRuns);

  // Преобразуем списки в медианы и удобные сводные поля
  for (const key of Object.keys(byTaskArm)) {
    const g = byTaskArm[key];
    const pk = passK.byTaskArm[key];
    g.k = pk ? pk.k : g.runs;
    g.passedRuns = pk ? pk.passedRuns : 0;
    g.passAtK = pk ? pk.passAtK : 0;
    g.passPowK = pk ? pk.passPowK : 0;
    g.medianDurationMs = Math.round(median(g.durations));
    g.medianLinesAdded = Math.round(median(g.linesAddedList));
    g.medianLinesDeleted = Math.round(median(g.linesDeletedList));
    g.medianFilesChanged = Math.round(median(g.filesChangedList));
    g.costTotal = g.costs.length > 0 ? Number(g.costs.reduce((s, c) => s + c, 0).toFixed(4)) : null;
    g.costMedian = g.costs.length > 0 ? Number(median(g.costs).toFixed(4)) : null;
    g.medianCostUsd = g.costMedian;
    g.safetyPassRate =
      g.safetyChecksTotal > 0 ? Number(((g.safetyChecksPassed / g.safetyChecksTotal) * 100).toFixed(1)) : null;
  }

  const safetyPassRate =
    totalSafetyChecks > 0 ? Number(((totalSafetyPassed / totalSafetyChecks) * 100).toFixed(1)) : null;
  const costTotal = allCosts.length > 0 ? Number(allCosts.reduce((s, c) => s + c, 0).toFixed(4)) : null;
  const costMedian = allCosts.length > 0 ? Number(median(allCosts).toFixed(4)) : null;

  return {
    byTaskArm,
    total: totalRuns,
    skipped,
    safetyChecksPassed: totalSafetyPassed,
    safetyChecksTotal: totalSafetyChecks,
    safetyPassRate,
    costTotal,
    costMedian,
    k: passK.k,
    passAtK: passK.passAtK,
    passPowK: passK.passPowK,
  };
}

/**
 * Сравнивает два арма по задачам и суммарно.
 * @param {object} summary
 * @param {string} baselineArm
 * @param {string} candidateArm
 * @param {object} [options={}]
 * @returns {{byTask: Array<object>, aggregate: object}}
 */
export function compareArms(summary, baselineArm, candidateArm, options = {}) {
  const { byTaskArm = {} } = summary || {};
  const tierFilter = options.tier || null;

  // Находим все задачи, для которых есть данные хотя бы по одному из армов
  const tasksSet = new Set();
  for (const item of Object.values(byTaskArm)) {
    if (tierFilter && item.tier && item.tier !== tierFilter) {
      continue;
    }
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

  let baseSafetyChecksPassed = 0;
  let baseSafetyChecksTotal = 0;
  let candSafetyChecksPassed = 0;
  let candSafetyChecksTotal = 0;

  let baseCostTotal = 0;
  let candCostTotal = 0;
  let hasCost = false;

  const getSafetyRate = (obj) => {
    if (!obj) return null;
    if (obj.safetyPassRate !== undefined && obj.safetyPassRate !== null) return obj.safetyPassRate;
    if (obj.safetyChecksTotal > 0) {
      return Number(((obj.safetyChecksPassed / obj.safetyChecksTotal) * 100).toFixed(1));
    }
    return null;
  };

  const getCost = (obj) => {
    if (!obj) return null;
    if (obj.costTotal !== undefined && obj.costTotal !== null) return obj.costTotal;
    if (obj.medianCostUsd !== undefined && obj.medianCostUsd !== null) return obj.medianCostUsd;
    if (obj.costMedian !== undefined && obj.costMedian !== null) return obj.costMedian;
    return null;
  };
  const getPassAtK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.passAtK === "number") return obj.passAtK;
    if (obj.checksTotal > 0) return obj.checksPassed > 0 ? 1 : 0;
    return 0;
  };

  const getPassPowK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.passPowK === "number") return obj.passPowK;
    if (obj.checksTotal > 0) return obj.checksPassed === obj.checksTotal ? 1 : 0;
    return 0;
  };

  const getK = (obj) => {
    if (!obj) return 0;
    if (typeof obj.k === "number") return obj.k;
    if (typeof obj.runs === "number") return obj.runs;
    return 1;
  };

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
            k: getK(base),
            passAtK: getPassAtK(base),
            passPowK: getPassPowK(base),
            medianDurationMs: base.medianDurationMs,
            medianLinesAdded: base.medianLinesAdded,
            checksPassed: base.checksPassed,
            checksTotal: base.checksTotal,
            medianCostUsd: base.medianCostUsd,
            tier: base.tier || "standard",
            safetyChecksPassed: base.safetyChecksPassed ?? 0,
            safetyChecksTotal: base.safetyChecksTotal ?? 0,
            safetyPassRate: getSafetyRate(base),
            costTotal: getCost(base),
            costMedian: base.costMedian ?? base.medianCostUsd ?? null,
          }
        : null,
      candidate: cand
        ? {
            runs: cand.runs,
            k: getK(cand),
            passAtK: getPassAtK(cand),
            passPowK: getPassPowK(cand),
            medianDurationMs: cand.medianDurationMs,
            medianLinesAdded: cand.medianLinesAdded,
            checksPassed: cand.checksPassed,
            checksTotal: cand.checksTotal,
            medianCostUsd: cand.medianCostUsd,
            tier: cand.tier || "standard",
            safetyChecksPassed: cand.safetyChecksPassed ?? 0,
            safetyChecksTotal: cand.safetyChecksTotal ?? 0,
            safetyPassRate: getSafetyRate(cand),
            costTotal: getCost(cand),
            costMedian: cand.costMedian ?? cand.medianCostUsd ?? null,
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

      const baseSafetyPass = base.safetyChecksPassed ?? 0;
      const baseSafetyTot = base.safetyChecksTotal ?? 0;
      const candSafetyPass = cand.safetyChecksPassed ?? 0;
      const candSafetyTot = cand.safetyChecksTotal ?? 0;

      baseSafetyChecksPassed += baseSafetyPass;
      baseSafetyChecksTotal += baseSafetyTot;
      candSafetyChecksPassed += candSafetyPass;
      candSafetyChecksTotal += candSafetyTot;

      const baseCost = getCost(base);
      const candCost = getCost(cand);
      if (baseCost !== null || candCost !== null) {
        hasCost = true;
        if (baseCost !== null) baseCostTotal += baseCost;
        if (candCost !== null) candCostTotal += candCost;
      }

      const linesDiff = cand.medianLinesAdded - base.medianLinesAdded;
      const linesPct =
        base.medianLinesAdded > 0
          ? ((linesDiff / base.medianLinesAdded) * 100).toFixed(1)
          : null;

      const durDiff = cand.medianDurationMs - base.medianDurationMs;
      const durPct =
        base.medianDurationMs > 0
          ? ((durDiff / base.medianDurationMs) * 100).toFixed(1)
          : null;

      const baseCheckRate = base.checksTotal > 0 ? base.checksPassed / base.checksTotal : 0;
      const candCheckRate = cand.checksTotal > 0 ? cand.checksPassed / cand.checksTotal : 0;

      const baseSafetyRate = getSafetyRate(base);
      const candSafetyRate = getSafetyRate(cand);
      const safetyPassRateDiff =
        baseSafetyRate !== null && candSafetyRate !== null
          ? Number((candSafetyRate - baseSafetyRate).toFixed(1))
          : null;

      const costDiff =
        baseCost !== null && candCost !== null ? Number((candCost - baseCost).toFixed(4)) : null;

      const passAtKBase = getPassAtK(base);
      const passAtKCandidate = getPassAtK(cand);
      const passAtKDiff = passAtKCandidate - passAtKBase;
      const passPowKBase = getPassPowK(base);
      const passPowKCandidate = getPassPowK(cand);
      const passPowKDiff = passPowKCandidate - passPowKBase;
      item.deltas = {
        linesDiff,
        linesPct: linesPct !== null ? Number(linesPct) : null,
        durationMsDiff: durDiff,
        durationPct: durPct !== null ? Number(durPct) : null,
        checksRateBase: Number((baseCheckRate * 100).toFixed(1)),
        checksRateCandidate: Number((candCheckRate * 100).toFixed(1)),
        passAtKBase,
        passAtKCandidate,
        passAtKDiff,
        passPowKBase,
        passPowKCandidate,
        passPowKDiff,
        safetyPassRateBase: baseSafetyRate,
        safetyPassRateCandidate: candSafetyRate,
        safetyPassRateDiff,
        costBase: baseCost,
        costCandidate: candCost,
        costDiff,
      };
    } else {
      if (base) {
        const bCost = getCost(base);
        if (bCost !== null) {
          hasCost = true;
          baseCostTotal += bCost;
        }
        baseSafetyChecksPassed += base.safetyChecksPassed ?? 0;
        baseSafetyChecksTotal += base.safetyChecksTotal ?? 0;
      }
      if (cand) {
        const cCost = getCost(cand);
        if (cCost !== null) {
          hasCost = true;
          candCostTotal += cCost;
        }
        candSafetyChecksPassed += cand.safetyChecksPassed ?? 0;
        candSafetyChecksTotal += cand.safetyChecksTotal ?? 0;
      }
    }

    byTask.push(item);
  }

  const baseSafetyPassRate =
    baseSafetyChecksTotal > 0
      ? Number(((baseSafetyChecksPassed / baseSafetyChecksTotal) * 100).toFixed(1))
      : null;
  const candSafetyPassRate =
    candSafetyChecksTotal > 0
      ? Number(((candSafetyChecksPassed / candSafetyChecksTotal) * 100).toFixed(1))
      : null;
  const safetyPassRateDiff =
    baseSafetyPassRate !== null && candSafetyPassRate !== null
      ? Number((candSafetyPassRate - baseSafetyPassRate).toFixed(1))
      : null;

  const costDiff = hasCost ? Number((candCostTotal - baseCostTotal).toFixed(4)) : null;
  const costPct =
    hasCost && baseCostTotal > 0
      ? Number((((candCostTotal - baseCostTotal) / baseCostTotal) * 100).toFixed(1))
      : null;

  const baseTasks = byTask.filter((t) => t.baseline);
  const candTasks = byTask.filter((t) => t.candidate);
  const baseK = baseTasks.length > 0 ? Math.max(0, ...baseTasks.map((t) => t.baseline.k)) : 0;
  const candK = candTasks.length > 0 ? Math.max(0, ...candTasks.map((t) => t.candidate.k)) : 0;
  const basePassAtKCount = baseTasks.filter((t) => t.baseline.passAtK === 1).length;
  const basePassPowKCount = baseTasks.filter((t) => t.baseline.passPowK === 1).length;
  const basePassAtK = baseTasks.length > 0 ? Number(((basePassAtKCount / baseTasks.length) * 100).toFixed(1)) : 0;
  const basePassPowK = baseTasks.length > 0 ? Number(((basePassPowKCount / baseTasks.length) * 100).toFixed(1)) : 0;
  const candPassAtKCount = candTasks.filter((t) => t.candidate.passAtK === 1).length;
  const candPassPowKCount = candTasks.filter((t) => t.candidate.passPowK === 1).length;
  const candidatePassAtK = candTasks.length > 0 ? Number(((candPassAtKCount / candTasks.length) * 100).toFixed(1)) : 0;
  const candidatePassPowK = candTasks.length > 0 ? Number(((candPassPowKCount / candTasks.length) * 100).toFixed(1)) : 0;
  const passAtKDiff = Number((candidatePassAtK - basePassAtK).toFixed(1));
  const passPowKDiff = Number((candidatePassPowK - basePassPowK).toFixed(1));
  const aggregate = {
    baselineArm,
    candidateArm,
    linesDiff: hasLines ? candTotalLines - baseTotalLines : null,
    linesPct:
      hasLines && baseTotalLines > 0
        ? Number((((candTotalLines - baseTotalLines) / baseTotalLines) * 100).toFixed(1))
        : null,
    durationMsDiff: hasDuration ? candTotalDuration - baseTotalDuration : null,
    durationPct:
      hasDuration && baseTotalDuration > 0
        ? Number((((candTotalDuration - baseTotalDuration) / baseTotalDuration) * 100).toFixed(1))
        : null,
    baseChecks: { passed: baseChecksPassed, total: baseChecksTotal },
    candidateChecks: { passed: candChecksPassed, total: candChecksTotal },
    baseSafetyChecks: { passed: baseSafetyChecksPassed, total: baseSafetyChecksTotal },
    candidateSafetyChecks: { passed: candSafetyChecksPassed, total: candSafetyChecksTotal },
    baseSafetyPassRate,
    candidateSafetyPassRate: candSafetyPassRate,
    safetyPassRateDiff,
    baseCostTotal: hasCost ? Number(baseCostTotal.toFixed(4)) : null,
    candidateCostTotal: hasCost ? Number(candCostTotal.toFixed(4)) : null,
    costDiff,
    costPct,
    baseK,
    candidateK: candK,
    basePassAtK,
    candidatePassAtK,
    passAtKDiff,
    basePassPowK,
    candidatePassPowK,
    passPowKDiff,
  };

  return { byTask, aggregate };
}

/**
 * Форматирует сводку прогонов для консольного вывода.
 * @param {object} summary
 * @returns {string}
 */
export function formatReport(summary) {
  if (!summary || summary.total === 0) {
    return "Запусков нет: сначала выполните benchmark run.";
  }

  const lines = [
    `=== Отчет о бенчмарках (всего прогонов: ${summary.total}) ===`,
    "Задача | Арм | Прогонов | Время (медиана) | LOC (+/-) | Файлов | Проверки | pass@k | pass^k | Стоимость",
    "---|---|---|---|---|---|---|---|---|---",
  ];

  for (const item of Object.values(summary.byTaskArm)) {
    const costStr =
      item.medianCostUsd !== null && item.medianCostUsd !== undefined
        ? `$${item.medianCostUsd}`
        : item.costMedian !== null && item.costMedian !== undefined
          ? `$${item.costMedian}`
          : "-";
    lines.push(
      `${item.task} | ${item.arm} | ${item.runs} | ${item.medianDurationMs}ms | +${item.medianLinesAdded}/-${item.medianLinesDeleted} | ${item.medianFilesChanged} | ${item.checksPassed}/${item.checksTotal} | ${item.passAtK ?? 0} | ${item.passPowK ?? 0} | ${costStr}`
    );
  }

  if (summary.passAtK !== undefined && summary.passAtK !== null) {
    const kVal = summary.k || 1;
    lines.push(`pass@${kVal}: ${summary.passAtK}%, pass^${kVal}: ${summary.passPowK}%`);
  }

  if (summary.safetyChecksTotal > 0) {
    lines.push(
      `Safety pass rate: ${summary.safetyPassRate}% (${summary.safetyChecksPassed}/${summary.safetyChecksTotal} checks)`
    );
  }

  if (summary.costTotal !== null && summary.costTotal !== undefined) {
    const medPart =
      summary.costMedian !== null && summary.costMedian !== undefined ? `, медиана: $${summary.costMedian}` : "";
    lines.push(`Стоимость: всего $${summary.costTotal}${medPart}`);
  }

  return lines.join("\n");
}

/**
 * Форматирует отчет о сравнении двух армов для консольного вывода.
 * @param {object} comparison
 * @returns {string}
 */
export function formatCompare(comparison) {
  if (!comparison || !comparison.byTask) {
    return "Нет данных для сравнения.";
  }

  const baseArm = comparison.aggregate?.baselineArm || "base";
  const candArm = comparison.aggregate?.candidateArm || "candidate";

  const lines = [`=== Сравнение: ${baseArm} (базовый) vs ${candArm} (кандидат) ===`];
  if (comparison.byTask.length === 0) {
    lines.push("Нет общих данных для сравнения указанных армов.");
    return lines.join("\n");
  }

  for (const item of comparison.byTask) {
    lines.push(`\nЗадача: ${item.task}`);
    if (!item.baseline) {
      lines.push(`  Базовый арм '${baseArm}': нет данных`);
    }
    if (!item.candidate) {
      lines.push(`  Кандидат '${candArm}': нет данных`);
    }
    if (item.baseline && item.candidate) {
      const b = item.baseline;
      const c = item.candidate;
      const d = item.deltas;
      const linesPctStr = d.linesPct !== null ? ` (${d.linesPct > 0 ? "+" : ""}${d.linesPct}%)` : "";
      const durPctStr = d.durationPct !== null ? ` (${d.durationPct > 0 ? "+" : ""}${d.durationPct}%)` : "";

      lines.push(`  LOC добавлено: ${b.medianLinesAdded} -> ${c.medianLinesAdded}${linesPctStr}`);
      lines.push(`  Время: ${b.medianDurationMs}ms -> ${c.medianDurationMs}ms${durPctStr}`);
      lines.push(
        `  Проверки: ${b.checksPassed}/${b.checksTotal} (${d.checksRateBase}%) -> ${c.checksPassed}/${c.checksTotal} (${d.checksRateCandidate}%)`
      );
      const kVal = Math.max(b.k ?? 1, c.k ?? 1);
      const signAt = (d.passAtKDiff ?? 0) > 0 ? "+" : "";
      const signPow = (d.passPowKDiff ?? 0) > 0 ? "+" : "";
      lines.push(`  pass@${kVal}: ${b.passAtK ?? 0} -> ${c.passAtK ?? 0} (дельта: ${signAt}${d.passAtKDiff ?? 0})`);
      lines.push(`  pass^${kVal}: ${b.passPowK ?? 0} -> ${c.passPowK ?? 0} (дельта: ${signPow}${d.passPowKDiff ?? 0})`);
      if (d.safetyPassRateBase !== null || d.safetyPassRateCandidate !== null) {
        lines.push(
          `  Safety pass rate: ${d.safetyPassRateBase ?? "-"}% -> ${d.safetyPassRateCandidate ?? "-"}%`
        );
      }
      if (d.costDiff !== null && d.costDiff !== undefined) {
        const cSign = d.costDiff > 0 ? "+" : "";
        lines.push(
          `  Стоимость: $${d.costBase ?? 0} -> $${d.costCandidate ?? 0} (дельта: ${cSign}$${d.costDiff})`
        );
      }
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
  if (agg.baseChecks && (agg.baseChecks.total > 0 || agg.candidateChecks?.total > 0)) {
    parts.push(`checks ${agg.baseChecks.passed}/${agg.baseChecks.total} -> ${agg.candidateChecks.passed}/${agg.candidateChecks.total}`);
  }
  if (agg.basePassAtK !== undefined || agg.candidatePassAtK !== undefined) {
    const kVal = Math.max(agg.baseK ?? 1, agg.candidateK ?? 1);
    const signAt = agg.passAtKDiff > 0 ? "+" : "";
    const signPow = agg.passPowKDiff > 0 ? "+" : "";
    parts.push(`pass@${kVal} ${agg.basePassAtK ?? 0}% -> ${agg.candidatePassAtK ?? 0}% (${signAt}${agg.passAtKDiff}%)`);
    parts.push(`pass^${kVal} ${agg.basePassPowK ?? 0}% -> ${agg.candidatePassPowK ?? 0}% (${signPow}${agg.passPowKDiff}%)`);
  }
  if (agg.baseSafetyPassRate !== null || agg.candidateSafetyPassRate !== null) {
    parts.push(`safety ${agg.baseSafetyPassRate ?? 0}% -> ${agg.candidateSafetyPassRate ?? 0}%`);
  }
  if (agg.costDiff !== null && agg.costDiff !== undefined) {
    const costSign = agg.costDiff > 0 ? "+" : "";
    parts.push(`cost $${agg.baseCostTotal ?? 0} -> $${agg.candidateCostTotal ?? 0} (${costSign}$${agg.costDiff})`);
  }

  lines.push(`\nИтог: ${parts.length > 0 ? parts.join(", ") : "нет сравнимых метрик"}`);
  return lines.join("\n");
}

export function validateTasks(rootOrData = ".") {
  const errors = [];
  let data = rootOrData;
  if (typeof rootOrData === "string") {
    const abs = resolve(rootOrData);
    const filePath = abs.endsWith(".json") && existsSync(abs) ? abs : join(abs, TASKS_FILE);
    if (!existsSync(filePath)) return { valid: false, count: 0, errors: [`Файл не найден: ${filePath}`] };
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      return { valid: false, count: 0, errors: [`Некорректный JSON в ${filePath}: ${err.message}`] };
    }
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.tasks) || data.tasks.length === 0) {
    return { valid: false, count: 0, errors: ["Поле 'tasks' должно быть непустым массивом."] };
  }
  const seenIds = new Set();
  data.tasks.forEach((t, idx) => {
    const label = t && typeof t.id === "string" && t.id.trim() ? `'${t.id}'` : `#${idx}`;
    if (!t || typeof t !== "object") {
      errors.push(`Задача ${label}: ожидается объект.`);
      return;
    }
    if (typeof t.id !== "string" || !t.id.trim()) errors.push(`Задача ${label}: поле 'id' должно быть непустой строкой.`);
    else if (seenIds.has(t.id)) errors.push(`Задача ${label}: дублирующийся id '${t.id}'.`);
    else seenIds.add(t.id);
    if (typeof t.tier !== "string" || !TASK_TIERS.includes(t.tier)) {
      errors.push(`Задача ${label}: 'tier' должен быть одним из [${TASK_TIERS.join(", ")}] (получено: ${JSON.stringify(t.tier)}).`);
    }
    if (typeof t.prompt !== "string" || !t.prompt.trim()) errors.push(`Задача ${label}: 'prompt' должен быть непустой строкой.`);
    if (!Array.isArray(t.checks) || t.checks.length === 0 || !t.checks.every((c) => typeof c === "string" && c.trim().length > 0)) {
      errors.push(`Задача ${label}: 'checks' должен быть непустым массивом непустых строк.`);
    }
    const timeout = t.timeoutSec ?? t.timeout;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      errors.push(`Задача ${label}: 'timeoutSec' должен быть целым числом > 0 (получено: ${JSON.stringify(timeout)}).`);
    }
  });
  return { valid: errors.length === 0, count: data.tasks.length, errors };
}

export function loadSmokeRuns(dirPath) {
  const absDir = resolve(dirPath);
  if (!existsSync(absDir)) {
    const err = new Error(`Директория smoke не найдена: ${absDir}`);
    err.exitCode = 2;
    throw err;
  }
  const runs = [];
  const readJsonFile = (p) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      const err = new Error(`Некорректный JSON в ${p}: ${e.message}`);
      err.exitCode = 2;
      throw err;
    }
    let list = [];
    if (Array.isArray(parsed)) list = parsed;
    else if (Array.isArray(parsed?.runs)) list = parsed.runs;
    else if (parsed?.task) list = [parsed];
    for (const item of list) if (item && typeof item === "object") runs.push(item);
  };
  if (statSync(absDir).isFile()) {
    readJsonFile(absDir);
    return runs;
  }
  const rootResult = join(absDir, "result.json");
  if (existsSync(rootResult) && statSync(rootResult).isFile()) readJsonFile(rootResult);
  for (const entry of readdirSync(absDir).sort()) {
    if (entry === "result.json") continue;
    const full = join(absDir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const subRes = join(full, "result.json");
      if (existsSync(subRes) && statSync(subRes).isFile()) readJsonFile(subRes);
    } else if (entry.endsWith(".json")) {
      readJsonFile(full);
    }
  }
  return runs;
}

export function runSmoke({ baseline, candidate, tasks = null, root = "." } = {}) {
  const resolveSide = (side) => {
    if (Array.isArray(side)) return side;
    if (!side || typeof side !== "string") {
      const err = new Error("Необходимо указать пути --baseline и --candidate");
      err.exitCode = 2;
      throw err;
    }
    let p = side;
    if (!isAbsolute(side)) p = existsSync(resolve(root, side)) ? resolve(root, side) : resolve(side);
    return loadSmokeRuns(p);
  };
  const baseStats = computePassK(resolveSide(baseline).filter((r) => r && r.task).map((r) => ({ ...r, arm: "baseline" })));
  const candStats = computePassK(resolveSide(candidate).filter((r) => r && r.task).map((r) => ({ ...r, arm: "candidate" })));
  let filterList = null;
  if (Array.isArray(tasks)) filterList = tasks.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof tasks === "string" && tasks.trim()) filterList = tasks.split(",").map((t) => t.trim()).filter(Boolean);
  const filterSet = filterList && filterList.length > 0 ? new Set(filterList) : null;
  const allTasks = new Set([...Object.keys(baseStats.byTask), ...Object.keys(candStats.byTask), ...(filterSet || [])]);
  const red = [];
  const green = [];
  const skipped = [];
  const byTask = [];
  for (const taskId of Array.from(allTasks).sort()) {
    if (filterSet && !filterSet.has(taskId)) continue;
    const b = baseStats.byTask[taskId]?.baseline;
    const c = candStats.byTask[taskId]?.candidate;
    if (!b || !c || b.k === 0 || c.k === 0) {
      let reason = "missing in candidate";
      if (!b && !c) reason = "missing in both";
      else if (!b) reason = "missing in baseline";
      const item = {
        task: taskId, status: "skipped", red: false, skipped: true, reason,
        baseline: b ? `${b.passedRuns}/${b.k}` : null, candidate: c ? `${c.passedRuns}/${c.k}` : null,
      };
      skipped.push(item);
      byTask.push(item);
      continue;
    }
    const isRed = b.passPowK === 1 && c.passAtK === 0;
    const item = {
      task: taskId, status: isRed ? "red" : "green", red: isRed, skipped: false,
      baseline: `${b.passedRuns}/${b.k}`, candidate: `${c.passedRuns}/${c.k}`,
      baselinePassed: b.passedRuns, baselineK: b.k, candidatePassed: c.passedRuns, candidateK: c.k,
    };
    if (isRed) red.push(item);
    else green.push(item);
    byTask.push(item);
  }
  return {
    passed: red.length === 0, status: red.length === 0 ? "green" : "red", exitCode: red.length === 0 ? 0 : 1,
    red, redTasks: red.map((r) => r.task), green, skipped, skippedTasks: skipped.map((s) => s.task), byTask,
  };
}

export function parseArgs(argv) {
  const args = {
    command: null, root: ".", task: null, tasks: null, arm: null, cmd: null,
    runs: 1, timeout: null, transcript: null, dryRun: false, yes: false,
    json: false, tier: null, baseline: null, candidate: null, replay: null, record: null, help: false, _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--root") args.root = argv[++i];
    else if (arg.startsWith("--root=")) args.root = arg.slice(7);
    else if (arg === "--task") args.task = argv[++i];
    else if (arg.startsWith("--task=")) args.task = arg.slice(7);
    else if (arg === "--tasks") args.tasks = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--tasks=")) args.tasks = arg.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--arm") args.arm = argv[++i];
    else if (arg.startsWith("--arm=")) args.arm = arg.slice(6);
    else if (arg === "--cmd") args.cmd = argv[++i];
    else if (arg.startsWith("--cmd=")) args.cmd = arg.slice(6);
    else if (arg === "--replay") args.replay = argv[++i];
    else if (arg.startsWith("--replay=")) args.replay = arg.slice(9);
    else if (arg === "--record") args.record = argv[++i];
    else if (arg.startsWith("--record=")) args.record = arg.slice(9);
    else if (arg === "--runs" || arg === "-n") args.runs = parseInt(argv[++i], 10);
    else if (arg.startsWith("--runs=")) args.runs = parseInt(arg.slice(7), 10);
    else if (arg.startsWith("-n=")) args.runs = parseInt(arg.slice(3), 10);
    else if (arg === "--tier") args.tier = argv[++i];
    else if (arg.startsWith("--tier=")) args.tier = arg.slice(7);
    else if (arg === "--timeout") args.timeout = parseInt(argv[++i], 10);
    else if (arg.startsWith("--timeout=")) args.timeout = parseInt(arg.slice(10), 10);
    else if (arg === "--transcript") args.transcript = argv[++i];
    else if (arg.startsWith("--transcript=")) args.transcript = arg.slice(13);
    else if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg.startsWith("--baseline=")) args.baseline = arg.slice(11);
    else if (arg === "--candidate") args.candidate = argv[++i];
    else if (arg.startsWith("--candidate=")) args.candidate = arg.slice(12);
    else if (!arg.startsWith("-")) {
      if (!args.command) args.command = arg;
      else args._.push(arg);
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
  -n, --runs <N>         Количество повторных запусков (по умолчанию: 1)
  --tier <tier>          Фильтр по тиру задач (standard, safety, perf)
  --timeout <sec>        Таймаут выполнения команды в секундах
  --transcript <path>    Путь к транскрипту для подсчета стоимости (session_cost.py)
  --dry-run              Показать план запуска без создания файлов и выполнения команд
  --replay <cassette>    Воспроизвести LM-ответы из кассеты вместо живого вызова ($0)
  --record <cassette>    Сохранить ответы и изменения живого запуска в кассету
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
    // Молчаливое «0/-1 → 1» раньше превращало --runs 0 в настоящий прогон бенчмарка.
    if (!Number.isInteger(args.runs) || args.runs < 1) {
      console.error(`Ошибка: --runs требует целое число >= 1 (получено: ${args.runs}).`);
      return 2;
    }
    if (args.timeout !== null && (!Number.isInteger(args.timeout) || args.timeout < 0)) {
      console.error(`Ошибка: --timeout требует целое число >= 0 секунд (получено: ${args.timeout}).`);
      return 2;
    }
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
          replay: args.replay,
          record: args.record,
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
            if (res.metricsWarning) {
              console.log(`      ! метрики: ${res.metricsWarning}`);
            }
            if (res.toolArtifacts && res.toolArtifacts.filesChanged > 0) {
              console.log(
                `      служебные артефакты инструментов (вне метрик): ${res.toolArtifacts.filesChanged} файл(ов), +${res.toolArtifacts.linesAdded}/-${res.toolArtifacts.linesDeleted}`
              );
            }
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
        const summary = summarizeRuns(absRoot, { tier: args.tier });

        // Пропущенные result.json никогда не остаются незамеченными.
        for (const s of summary.skipped) {
          console.error(`Предупреждение: пропущен ${s.file} (${s.reason})`);
        }

        if (summary.total === 0) {
          if (args.json) {
            console.log(JSON.stringify(summary, null, 2));
          } else {
            console.log("Запусков нет: сначала выполните benchmark run.");
          }
          return summary.skipped.length > 0 ? 1 : 0;
        }

        if (args.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(formatReport(summary));
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

        const summary = summarizeRuns(absRoot, { tier: args.tier });
        const comparison = compareArms(summary, args.baseline, args.candidate, { tier: args.tier });

        if (args.json) {
          console.log(JSON.stringify(comparison, null, 2));
        } else {
          console.log(formatCompare(comparison));
        }
        return 0;
      } catch (err) {
        console.error(`Ошибка сравнения: ${err.message}`);
        return 1;
      }
    }

    case "validate-tasks": {
      const res = validateTasks(absRoot);
      if (args.json) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.valid) console.error(res.errors.join("\n"));
      } else if (res.valid) {
        console.log(`OK: схема ${TASKS_FILE} валидна (задач: ${res.count})`);
      } else {
        const msg = `Ошибка схемы ${TASKS_FILE}:\n` + res.errors.map((e) => `  - ${e}`).join("\n");
        console.error(msg);
      }
      return res.valid ? 0 : 2;
    }

    case "smoke": {
      try {
        if (!args.baseline || !args.candidate) {
          console.error("Ошибка: для smoke укажите --baseline <dir> и --candidate <dir>");
          return 2;
        }
        const res = runSmoke({
          root: absRoot,
          baseline: args.baseline,
          candidate: args.candidate,
          tasks: args.tasks || args.task,
        });
        if (args.json) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.red.length > 0) {
          const msg = `SMOKE RED (${res.red.length}): ${res.red.map((r) => `${r.task} (${r.baseline} -> ${r.candidate})`).join(", ")}`;
          console.error(msg);
        } else {
          console.log(`SMOKE GREEN (задач проверено: ${res.green.length}, пропущено: ${res.skipped.length})`);
        }
        return res.exitCode;
      } catch (err) {
        console.error(`Ошибка smoke: ${err.message}`);
        return err.exitCode || 1;
      }
    }

    default:
      console.error(`Неизвестная команда: '${args.command}'`);
      printUsage();
      return 1;
  }
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main();
}
