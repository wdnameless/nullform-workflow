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
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

  const runCount = runs == null ? 1 : Number(runs);
  if (!Number.isInteger(runCount) || runCount < 1) {
    const err = new Error(`Параметр runs должен быть целым числом >= 1 (получено: ${runs})`);
    err.exitCode = 2;
    throw err;
  }
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
    const transcriptToUse = transcript || findRecentSessionTranscript(startTime - 2000);
    const cost = evaluateCost(absRoot, transcriptToUse);

    // 7. Сборка result.json
    const resultJson = {
      version: 1,
      task: taskId,
      arm,
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

  for (const entry of entries) {
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

  // Преобразуем списки в медианы и удобные сводные поля
  for (const key of Object.keys(byTaskArm)) {
    const g = byTaskArm[key];
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

      item.deltas = {
        linesDiff,
        linesPct: linesPct !== null ? Number(linesPct) : null,
        durationMsDiff: durDiff,
        durationPct: durPct !== null ? Number(durPct) : null,
        checksRateBase: Number((baseCheckRate * 100).toFixed(1)),
        checksRateCandidate: Number((candCheckRate * 100).toFixed(1)),
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
    "Задача | Арм | Прогонов | Время (медиана) | LOC (+/-) | Файлов | Проверки | Стоимость",
    "---|---|---|---|---|---|---|---",
  ];

  for (const item of Object.values(summary.byTaskArm)) {
    const costStr =
      item.medianCostUsd !== null && item.medianCostUsd !== undefined
        ? `$${item.medianCostUsd}`
        : item.costMedian !== null && item.costMedian !== undefined
          ? `$${item.costMedian}`
          : "-";
    lines.push(
      `${item.task} | ${item.arm} | ${item.runs} | ${item.medianDurationMs}ms | +${item.medianLinesAdded}/-${item.medianLinesDeleted} | ${item.medianFilesChanged} | ${item.checksPassed}/${item.checksTotal} | ${costStr}`
    );
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
    tier: null,
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
    } else if (arg === "--runs" || arg === "-n") {
      args.runs = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--runs=")) {
      args.runs = parseInt(arg.slice(7), 10);
    } else if (arg.startsWith("-n=")) {
      args.runs = parseInt(arg.slice(3), 10);
    } else if (arg === "--tier") {
      args.tier = argv[++i];
    } else if (arg.startsWith("--tier=")) {
      args.tier = arg.slice(7);
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
  -n, --runs <N>         Количество повторных запусков (по умолчанию: 1)
  --tier <tier>          Фильтр по тиру задач (standard, safety, perf)
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
              if (d.safetyPassRateBase !== null || d.safetyPassRateCandidate !== null) {
                console.log(
                  `  Safety pass rate: ${d.safetyPassRateBase ?? "-"}% -> ${d.safetyPassRateCandidate ?? "-"}%`
                );
              }
              if (d.costDiff !== null && d.costDiff !== undefined) {
                const cSign = d.costDiff > 0 ? "+" : "";
                console.log(
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
          if (agg.baseChecks.total > 0 || agg.candidateChecks.total > 0) {
            parts.push(`checks ${agg.baseChecks.passed}/${agg.baseChecks.total} -> ${agg.candidateChecks.passed}/${agg.candidateChecks.total}`);
          }
          if (agg.baseSafetyPassRate !== null || agg.candidateSafetyPassRate !== null) {
            parts.push(`safety ${agg.baseSafetyPassRate ?? 0}% -> ${agg.candidateSafetyPassRate ?? 0}%`);
          }
          if (agg.costDiff !== null && agg.costDiff !== undefined) {
            const costSign = agg.costDiff > 0 ? "+" : "";
            parts.push(`cost $${agg.baseCostTotal ?? 0} -> $${agg.candidateCostTotal ?? 0} (${costSign}$${agg.costDiff})`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
