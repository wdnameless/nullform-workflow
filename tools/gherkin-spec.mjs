#!/usr/bin/env node
/**
 * tools/gherkin-spec.mjs — Парсер, валидатор и линтер исполняемых BDD/Gherkin спецификаций.
 *
 * Проверяет качество приёмочных критериев агентов на соответствие каноническому формату
 * Given / When / Then (Gherkin/Cucumber), извлекает BDD-сценарии из Markdown-файлов
 * (например, tasks.md, manifest.md, README.md) и валидирует полноту сценариев.
 *
 * CLI опции:
 *   lint <path...>        Проверить .feature или .md файлы на соответствие правилам Gherkin
 *   extract <path...>     Извлечь и разобрать Gherkin-блоки из Markdown файлов
 *   --strict              Ошибки при любых предупреждениях (например, отсутствие Given)
 *   --json                Машиночитаемый вывод JSON
 *   --help, -h            Справка
 */

import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const STEP_KEYWORDS = ["given", "when", "then", "and", "but"];

/**
 * Разбирает текст Gherkin на фичи, сценарии и шаги.
 * @param {string} text
 * @returns {object} { features: Array<object>, errors: string[] }
 */
export function parseGherkin(text) {
  const lines = text.split("\n");
  const features = [];
  const errors = [];

  let currentFeature = null;
  let currentScenario = null;
  let currentTags = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();
    const lineNum = idx + 1;

    // Пропуск пустых строк и комментариев
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Теги (@tag1 @tag2)
    if (trimmed.startsWith("@")) {
      const tags = trimmed.split(/\s+/).filter((t) => t.startsWith("@"));
      currentTags.push(...tags);
      continue;
    }

    // Feature:
    const featureMatch = trimmed.match(/^Feature:\s*(.+)$/i);
    if (featureMatch) {
      currentFeature = {
        title: featureMatch[1].trim(),
        line: lineNum,
        tags: [...currentTags],
        scenarios: [],
      };
      features.push(currentFeature);
      currentScenario = null;
      currentTags = [];
      continue;
    }

    // Scenario: или Scenario Outline:
    const scenarioMatch = trimmed.match(/^(?:Scenario|Scenario Outline):\s*(.+)$/i);
    if (scenarioMatch) {
      if (!currentFeature) {
        // Создаем неявную фичу, если сценарий объявлен без заголовка Feature
        currentFeature = {
          title: "Implicit Feature",
          line: lineNum,
          tags: [],
          scenarios: [],
        };
        features.push(currentFeature);
      }

      currentScenario = {
        title: scenarioMatch[1].trim(),
        line: lineNum,
        tags: [...currentTags],
        steps: [],
      };
      currentFeature.scenarios.push(currentScenario);
      currentTags = [];
      continue;
    }

    // Шаги (Given, When, Then, And, But)
    const stepMatch = trimmed.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (stepMatch) {
      if (!currentScenario) {
        errors.push(`Строка ${lineNum}: Шаг "${trimmed}" объявлен вне сценария (Scenario).`);
        continue;
      }

      const keyword = stepMatch[1].toLowerCase();
      const text = stepMatch[2].trim();

      currentScenario.steps.push({
        keyword,
        text,
        line: lineNum,
      });
      continue;
    }
  }

  return { features, errors };
}

/**
 * Извлекает Gherkin блоки из Markdown кода (```gherkin, ```bdd, ```feature).
 * @param {string} mdContent
 * @returns {Array<{ lang: string, line: number, content: string }>}
 */
export function extractGherkinFromMarkdown(mdContent) {
  const blocks = [];
  const regex = /```(gherkin|feature|bdd)\s*\n([\s\S]*?)```/gi;
  let match;

  while ((match = regex.exec(mdContent)) !== null) {
    const lang = match[1].toLowerCase();
    const content = match[2];
    const line = mdContent.slice(0, match.index).split("\n").length;
    blocks.push({ lang, line, content });
  }

  return blocks;
}

/**
 * Валидирует разобранный Gherkin на полноту (Given, When, Then).
 * @param {object} parsed
 * @param {object} [options]
 * @param {boolean} [options.strict=false]
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function lintGherkin(parsed, options = {}) {
  const errors = [...(parsed.errors || [])];
  const warnings = [];

  if (parsed.features.length === 0) {
    errors.push("Спецификация не содержит ни одной фичи (Feature) или сценария (Scenario).");
    return { valid: false, errors, warnings };
  }

  for (const feature of parsed.features) {
    if (feature.scenarios.length === 0) {
      warnings.push(`Фича "${feature.title}" (строка ${feature.line}) не содержит сценариев.`);
    }

    for (const sc of feature.scenarios) {
      if (sc.steps.length === 0) {
        errors.push(`Сценарий "${sc.title}" (строка ${sc.line}) пуст: отсутствуют шаги.`);
        continue;
      }

      const keywords = sc.steps.map((s) => s.keyword);
      const hasGiven = keywords.includes("given");
      const hasWhen = keywords.includes("when");
      const hasThen = keywords.includes("then");

      if (!hasThen) {
        errors.push(`Сценарий "${sc.title}" (строка ${sc.line}): отсутствует ожидаемый результат (Then).`);
      }

      if (!hasWhen && !hasGiven) {
        warnings.push(`Сценарий "${sc.title}" (строка ${sc.line}): отсутствует предусловие (Given) или действие (When).`);
      }

      // Проверка на висячий And/But в самом начале
      if (keywords[0] === "and" || keywords[0] === "but") {
        errors.push(`Сценарий "${sc.title}" (строка ${sc.line}): шаг не может начинаться с And/But без предшествующего Given/When/Then.`);
      }
    }
  }

  const valid = errors.length === 0 && (!options.strict || warnings.length === 0);
  return { valid, errors, warnings };
}

/**
 * Рекурсивный поиск файлов по путям.
 */
function collectFiles(paths) {
  const files = [];

  function scan(entryPath) {
    if (!existsSync(entryPath)) return;
    const st = statSync(entryPath);
    if (st.isDirectory()) {
      for (const child of readdirSync(entryPath)) {
        if (child === "node_modules" || child === ".git") continue;
        scan(join(entryPath, child));
      }
    } else if (st.isFile()) {
      const ext = extname(entryPath).toLowerCase();
      if (ext === ".feature" || ext === ".md") {
        files.push(entryPath);
      }
    }
  }

  for (const p of paths) scan(resolve(p));
  return files;
}

export function parseArgs(argv = []) {
  const options = {
    command: "lint",
    paths: [],
    strict: false,
    json: false,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("-")) {
      if (arg === "lint" || arg === "extract") {
        options.command = arg;
      } else {
        options.paths.push(arg);
      }
    } else {
      options.errors.push(`неизвестный параметр: ${arg}`);
    }
  }

  if (options.paths.length === 0 && !options.help) {
    options.paths.push(".");
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.help) {
    const help = `gherkin-spec.mjs — Валидатор и линтер BDD/Gherkin спецификаций

Использование:
  node tools/gherkin-spec.mjs [lint|extract] [пути...] [параметры]

Команды:
  lint [пути...]     Проверить .feature и .md файлы (по умолчанию: .)
  extract [файлы...] Извлечь Gherkin-блоки из Markdown

Параметры:
  --strict           Считать предупреждения ошибками (exit 1)
  --json             Вывод в формате JSON
  -h, --help         Показать эту справку
`;
    process.stdout.write(help);
    return 0;
  }

  if (opts.errors.length > 0) {
    for (const e of opts.errors) process.stderr.write(`Ошибка: ${e}\n`);
    return 2;
  }

  const files = collectFiles(opts.paths);
  if (files.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ files: 0, valid: true }) + "\n");
    } else {
      process.stdout.write("Gherkin файлы или Markdown со спецификациями не найдены.\n");
    }
    return 0;
  }

  const fileResults = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const isMd = extname(f).toLowerCase() === ".md";

    if (opts.command === "extract") {
      if (!isMd) continue;
      const blocks = extractGherkinFromMarkdown(content);
      if (blocks.length > 0) {
        fileResults.push({ file: f, blocks });
      }
    } else {
      // lint command
      let toLint = content;
      if (isMd) {
        const blocks = extractGherkinFromMarkdown(content);
        if (blocks.length === 0) continue; // md без gherkin не валидируем
        toLint = blocks.map((b) => b.content).join("\n\n");
      }

      const parsed = parseGherkin(toLint);
      const lint = lintGherkin(parsed, { strict: opts.strict });

      totalErrors += lint.errors.length;
      totalWarnings += lint.warnings.length;

      fileResults.push({
        file: f,
        featuresCount: parsed.features.length,
        valid: lint.valid,
        errors: lint.errors,
        warnings: lint.warnings,
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ command: opts.command, totalFiles: fileResults.length, results: fileResults }, null, 2) + "\n");
  } else if (opts.command === "extract") {
    process.stdout.write(`=== ИЗВЛЕЧЕНИЕ BDD-СЦЕНАРИЕВ ИЗ MARKDOWN (${fileResults.length} файлов) ===\n`);
    for (const res of fileResults) {
      process.stdout.write(`\nФайл: ${res.file} (блоков: ${res.blocks.length})\n`);
      for (const b of res.blocks) {
        process.stdout.write(`--- Строка ${b.line} (${b.lang}) ---\n${b.content}\n`);
      }
    }
  } else {
    process.stdout.write("============================================================\n");
    process.stdout.write("          ВАЛИДАЦИЯ BDD/GHERKIN СПЕЦИФИКАЦИЙ                \n");
    process.stdout.write("============================================================\n");
    process.stdout.write(`Проверено файлов:      ${fileResults.length}\n`);
    process.stdout.write(`Ошибок (Errors):       ${totalErrors}\n`);
    process.stdout.write(`Предупреждений (Warn): ${totalWarnings}\n`);
    process.stdout.write("------------------------------------------------------------\n");

    for (const r of fileResults) {
      const statusIcon = r.valid ? "✓ PASS" : "✖ FAIL";
      process.stdout.write(`[${statusIcon}] ${r.file} (фич: ${r.featuresCount})\n`);
      for (const err of r.errors) {
        process.stdout.write(`  ✖ ERROR: ${err}\n`);
      }
      for (const w of r.warnings) {
        process.stdout.write(`  ⚠ WARN : ${w}\n`);
      }
    }
    process.stdout.write("============================================================\n");
  }

  if (opts.command === "lint") {
    if (totalErrors > 0) return 1;
    if (opts.strict && totalWarnings > 0) return 1;
  }

  return 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main(process.argv.slice(2));
}
