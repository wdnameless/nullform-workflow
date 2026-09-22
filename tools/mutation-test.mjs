#!/usr/bin/env node
/**
 * tools/mutation-test.mjs — Инструмент мутационного тестирования (Mutation Testing Engine).
 *
 * Проверяет качество тестов путём внесения намеренных мутаций в код (инверсия условий,
 * замена операторов сравнения, логических и арифметических операций, возврат ложных значений)
 * и проверки, что тестовый набор «убивает» мутантов (тесты падают).
 *
 * Если мутант выжил (тесты прошли) — в тестах обнаружена «дыра» (недостаточное покрытие поведением).
 *
 * CLI опции:
 *   --target <file>       Целевой файл с кодом для внесения мутаций (обязателен)
 *   --cmd <command>       Команда запуска тестов (по умолчанию: node --test)
 *   --threshold <n>       Минимально допустимый процент убитых мутантов (0-100, по умолчанию: 80)
 *   --max-mutants <n>     Максимальное количество мутантов для проверки (по умолчанию: 50)
 *   --timeout-sec <n>     Таймаут одного прогона теста в секундах (по умолчанию: 30)
 *   --dry-run             Показать список генерируемых мутантов без выполнения тестов
 *   --check               Завершить с exit 1, если процент убитых мутантов ниже threshold
 *   --json                Машиночитаемый вывод JSON
 *   --help, -h            Справка
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MUTATION_OPERATORS = [
  // 1. Операторы сравнения
  {
    name: "equality-inversion",
    description: "=== <-> !==",
    find: /===/g,
    replace: "!==",
  },
  {
    name: "inequality-inversion",
    description: "!== <-> ===",
    find: /!==/g,
    replace: "===",
  },
  {
    name: "comparison-greater",
    description: "> to <=",
    find: /(?<=\s)>(?=\s)/g,
    replace: "<=",
  },
  {
    name: "comparison-less",
    description: "< to >=",
    find: /(?<=\s)<(?=\s)/g,
    replace: ">=",
  },
  {
    name: "comparison-greater-equal",
    description: ">= to <",
    find: />=/g,
    replace: "<",
  },
  {
    name: "comparison-less-equal",
    description: "<= to >",
    find: /<=/g,
    replace: ">",
  },

  // 2. Логические операторы
  {
    name: "logical-and",
    description: "&& to ||",
    find: /&&/g,
    replace: "||",
  },
  {
    name: "logical-or",
    description: "|| to &&",
    find: /\|\|/g,
    replace: "&&",
  },

  // 3. Булевы константы
  {
    name: "boolean-true",
    description: "true to false",
    find: /\btrue\b/g,
    replace: "false",
  },
  {
    name: "boolean-false",
    description: "false to true",
    find: /\bfalse\b/g,
    replace: "true",
  },

  // 4. Арифметические операторы
  {
    name: "arithmetic-add",
    description: "+ to -",
    find: /(?<=\w\s*)\+(?=\s*\w)/g,
    replace: "-",
  },
  {
    name: "arithmetic-sub",
    description: "- to +",
    find: /(?<=\w\s*)-(?=\s*\w)/g,
    replace: "+",
  },

  // 5. Граничные возвраты
  {
    name: "return-zero",
    description: "return 0 to return 1",
    find: /\breturn\s+0;/g,
    replace: "return 1;",
  },
  {
    name: "return-null",
    description: "return null to return undefined",
    find: /\breturn\s+null;/g,
    replace: "return undefined;",
  },
  {
    name: "return-empty-string",
    description: 'return "" to return "mutant"',
    find: /\breturn\s+["']["'];/g,
    replace: 'return "mutant";',
  },
];

/**
 * Генерирует список мутантов для заданного исходного кода.
 * @param {string} sourceCode
 * @param {object} [options]
 * @param {number} [options.maxMutants=50]
 * @returns {Array<object>}
 */
export function generateMutants(sourceCode, options = {}) {
  const maxMutants = options.maxMutants || 50;
  const mutants = [];
  const lines = sourceCode.split("\n");

  let mutantId = 1;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (mutants.length >= maxMutants) break;
    const line = lines[lineIdx];
    const trimmed = line.trim();

    // Пропускаем комментарии и пустые строки
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    for (const op of MUTATION_OPERATORS) {
      if (mutants.length >= maxMutants) break;

      const matches = [...line.matchAll(op.find)];
      for (const m of matches) {
        if (mutants.length >= maxMutants) break;

        const matchIdx = m.index;
        const before = line.slice(0, matchIdx);
        const after = line.slice(matchIdx + m[0].length);
        const mutatedLine = before + op.replace + after;

        if (mutatedLine === line) continue;

        const mutatedLines = [...lines];
        mutatedLines[lineIdx] = mutatedLine;
        const mutatedCode = mutatedLines.join("\n");

        mutants.push({
          id: mutantId++,
          operator: op.name,
          description: op.description,
          lineNumber: lineIdx + 1,
          originalLine: trimmed,
          mutatedLine: mutatedLine.trim(),
          mutatedCode,
        });
      }
    }
  }

  return mutants;
}

/**
 * Выполняет мутационное тестирование одного файла.
 * @param {object} options
 * @param {string} options.targetPath
 * @param {string} [options.testCmd="node --test"]
 * @param {number} [options.threshold=80]
 * @param {number} [options.maxMutants=50]
 * @param {number} [options.timeoutSec=30]
 * @param {boolean} [options.dryRun=false]
 * @returns {object}
 */
export function runMutationTesting(options) {
  const {
    targetPath,
    testCmd = "node --test",
    threshold = 80,
    maxMutants = 50,
    timeoutSec = 30,
    dryRun = false,
  } = options;

  const absTarget = resolve(targetPath);
  if (!existsSync(absTarget)) {
    throw new Error(`Целевой файл не найден: ${absTarget}`);
  }

  const originalSource = readFileSync(absTarget, "utf8");
  const mutants = generateMutants(originalSource, { maxMutants });

  if (dryRun) {
    return {
      target: absTarget,
      totalMutants: mutants.length,
      threshold,
      dryRun: true,
      mutants: mutants.map((m) => ({
        id: m.id,
        operator: m.operator,
        lineNumber: m.lineNumber,
        originalLine: m.originalLine,
        mutatedLine: m.mutatedLine,
      })),
    };
  }

  // 1. Предварительная проверка: тесты на исходном коде ДОЛЖНЫ проходить
  const initialRun = spawnSync(testCmd, {
    shell: true,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
  windowsHide: true});

  if (initialRun.status !== 0) {
    throw new Error(
      `Базовый набор тестов упал на исходном коде (exit code: ${initialRun.status}). ` +
        `Мутационное тестирование требует исходно зелёных тестов.`
    );
  }

  const results = [];
  let killed = 0;
  let survived = 0;
  let timeouts = 0;

  try {
    for (const mutant of mutants) {
      // Подменяем файл мутантом
      writeFileSync(absTarget, mutant.mutatedCode, "utf8");

      const run = spawnSync(testCmd, {
        shell: true,
        encoding: "utf8",
        timeout: timeoutSec * 1000,
      windowsHide: true});

      const isTimeout = run.error && run.error.code === "ETIMEDOUT";
      const isKilled = isTimeout || run.status !== 0;

      if (isTimeout) {
        timeouts++;
        killed++;
      } else if (isKilled) {
        killed++;
      } else {
        survived++;
      }

      results.push({
        id: mutant.id,
        operator: mutant.operator,
        lineNumber: mutant.lineNumber,
        originalLine: mutant.originalLine,
        mutatedLine: mutant.mutatedLine,
        status: isKilled ? (isTimeout ? "timeout (killed)" : "killed") : "survived",
        exitCode: run.status,
      });
    }
  } finally {
    // ВСЕГДА восстанавливаем исходный файл на диске
    writeFileSync(absTarget, originalSource, "utf8");
  }

  const total = mutants.length;
  const score = total > 0 ? Number(((killed / total) * 100).toFixed(1)) : 100;
  const passed = score >= threshold;

  return {
    target: absTarget,
    totalMutants: total,
    killed,
    survived,
    timeouts,
    mutationScore: score,
    threshold,
    passed,
    results,
  };
}

/**
 * Человекочитаемое RU форматирование отчёта.
 * @param {object} summary
 * @returns {string}
 */
export function formatMutationReport(summary) {
  const lines = [];
  lines.push("============================================================");
  lines.push("           ОТЧЁТ МУТАЦИОННОГО ТЕСТИРОВАНИЯ (MUTATION TEST)   ");
  lines.push("============================================================");
  lines.push(`Целевой файл:          ${summary.target}`);
  lines.push(`Всего мутантов:        ${summary.totalMutants}`);
  lines.push(`Убито (тесты упали):   ${summary.killed} (таймауты: ${summary.timeouts || 0})`);
  lines.push(`Выжило (тесты прошли): ${summary.survived}`);
  lines.push(`Мутационный скор:      ${summary.mutationScore}% (порог: ${summary.threshold}%)`);
  lines.push(`Статус качества:       ${summary.passed ? "В НОРМЕ (PASSED)" : "ТРЕБУЕТСЯ ДОРАБОТКА ТЕСТОВ (FAILED)"}`);
  lines.push("------------------------------------------------------------");

  if (summary.survived > 0) {
    lines.push("ВЫЖИВШИЕ МУТАНТЫ (дыры в тестовом покрытии):");
    const survivedList = summary.results.filter((r) => r.status === "survived");
    for (const s of survivedList) {
      lines.push(`  [Мутант #${s.id}] Строка ${s.lineNumber} (${s.operator}):`);
      lines.push(`    Было : ${s.originalLine}`);
      lines.push(`    Стало: ${s.mutatedLine}`);
    }
    lines.push("------------------------------------------------------------");
  }

  return lines.join("\n");
}

export function parseArgs(argv = []) {
  const options = {
    target: null,
    cmd: "node --test",
    threshold: 80,
    maxMutants: 50,
    timeoutSec: 30,
    dryRun: false,
    check: false,
    json: false,
    help: false,
    errors: [],
  };

  const KNOWN_FLAGS = new Set([
    "target",
    "cmd",
    "threshold",
    "max-mutants",
    "timeout-sec",
    "dry-run",
    "check",
    "json",
    "help",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      options.target = arg.startsWith("--target=") ? arg.slice("--target=".length) : argv[++i];
    } else if (arg === "--cmd" || arg.startsWith("--cmd=")) {
      options.cmd = arg.startsWith("--cmd=") ? arg.slice("--cmd=".length) : argv[++i];
    } else if (arg === "--threshold" || arg.startsWith("--threshold=")) {
      const raw = arg.startsWith("--threshold=") ? arg.slice("--threshold=".length) : argv[++i];
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        options.errors.push(`--threshold требует число от 0 до 100 (получено: ${JSON.stringify(raw)})`);
      } else {
        options.threshold = parsed;
      }
    } else if (arg === "--max-mutants" || arg.startsWith("--max-mutants=")) {
      const raw = arg.startsWith("--max-mutants=") ? arg.slice("--max-mutants=".length) : argv[++i];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        options.errors.push(`--max-mutants требует целое число >= 1 (получено: ${JSON.stringify(raw)})`);
      } else {
        options.maxMutants = parsed;
      }
    } else if (arg === "--timeout-sec" || arg.startsWith("--timeout-sec=")) {
      const raw = arg.startsWith("--timeout-sec=") ? arg.slice("--timeout-sec=".length) : argv[++i];
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        options.errors.push(`--timeout-sec требует положительное число (получено: ${JSON.stringify(raw)})`);
      } else {
        options.timeoutSec = parsed;
      }
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (!KNOWN_FLAGS.has(name)) {
        options.errors.push(`неизвестный параметр: ${arg}`);
      }
    }
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.help) {
    const help = `mutation-test.mjs — Инструмент мутационного тестирования (Stryker-style)

Использование:
  node tools/mutation-test.mjs --target <file> [параметры]

Параметры:
  --target <path>     Целевой файл с кодом (обязателен)
  --cmd <command>     Команда запуска тестов (по умолчанию: node --test)
  --threshold <n>     Минимальный % убитых мутантов (по умолчанию: 80)
  --max-mutants <n>   Максимум мутантов для проверки (по умолчанию: 50)
  --timeout-sec <n>   Таймаут одного прогона в сек (по умолчанию: 30)
  --dry-run           Показать мутантов без запуска тестов
  --check             Завершить с exit 1, если score < threshold
  --json              Вывод в формате JSON
  -h, --help          Показать эту справку
`;
    process.stdout.write(help);
    return 0;
  }

  if (opts.errors.length > 0) {
    for (const e of opts.errors) {
      process.stderr.write(`Ошибка: ${e}\n`);
    }
    return 2;
  }

  if (!opts.target) {
    process.stderr.write("Ошибка: параметр --target <file> обязателен.\n");
    return 2;
  }

  try {
    const result = runMutationTesting({
      targetPath: opts.target,
      testCmd: opts.cmd,
      threshold: opts.threshold,
      maxMutants: opts.maxMutants,
      timeoutSec: opts.timeoutSec,
      dryRun: opts.dryRun,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (opts.dryRun) {
      process.stdout.write(`Сгенерировано ${result.totalMutants} мутантов для ${result.target}:\n`);
      for (const m of result.mutants) {
        process.stdout.write(`  [#${m.id}] Строка ${m.lineNumber} (${m.operator}): ${m.originalLine} -> ${m.mutatedLine}\n`);
      }
    } else {
      process.stdout.write(formatMutationReport(result) + "\n");
    }

    if (opts.check && !result.passed) {
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Ошибка мутационного тестирования: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
