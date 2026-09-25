#!/usr/bin/env node
/**
 * context-inbox.mjs — инструмент управления очередью контекста (Context Intake Pipeline).
 *
 * Команды:
 *   init     [--root <dir>]
 *            Инициализирует папку context/ с 6 категориями, README.md и REQUESTS.md. Идемпотентен.
 *
 *   request  --category <cat> --need "<описание>" [--why "<причина>"] [--hint "<подсказка>"] [--root <dir>] [--json]
 *            Добавляет запрос контекста в REQUESTS.md, выводит ID и путь для размещения.
 *
 *   list     [--root <dir>] [--json]
 *            Выводит открытые запросы контекста и инвентарь файлов по категориям.
 *
 *   resolve  --id <id> [--file <файл>] [--root <dir>] [--json]
 *            Отмечает запрос как выполненный (status: done) с опциональной привязкой файла.
 *
 *   check    [--root <dir>] [--strict]
 *            Проверяет валидность REQUESTS.md (структура, уникальность ID).
 *            Выход 1 при нарушении структуры или при --strict при наличии открытых запросов.
 *            По умолчанию выход 0 с информационным сообщением.
 *
 * Требования: Node 18+, без внешних зависимостей.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["design", "architecture", "domain", "product", "ops", "other"];

export const TABLE_HEADER = "| ID | Category | Needed | Why | Status | Added |";
export const TABLE_SEPARATOR = "|---|---|---|---|---|---|";

export const README_CONTENT = `# Контекст проекта

Эта директория предназначена для передачи контекста моделям и субагентам.

## Категории
- \`design/\` — дизайн-макеты, ассеты, бренд-киты, UI/UX гайды.
- \`architecture/\` — архитектурные схемы, ADR, описания компонентов, контракты API.
- \`domain/\` — предметная область, термины, бизнес-правила, логика предметной области.
- \`product/\` — продуктовые требования, PRD, пользовательские сценарии, спеки.
- \`ops/\` — конфигурации деплоя, инфраструктура, CI/CD, переменные окружения.
- \`other/\` — прочие контекстные материалы.

## Как работает цикл запроса контекста
1. Если модели не хватает контекста, она регистрирует запрос в \`context/REQUESTS.md\` через команду \`node tools/context-inbox.mjs request\`.
2. Модель сообщает пользователю ID запроса и целевую папку категории.
3. Модель продолжает работу с зафиксированными предположениями, не блокируя задачу.
4. Пользователь помещает запрошенные материалы в соответствующую папку \`context/<category>/\`.
5. Запрос помечается выполненным через команду \`node tools/context-inbox.mjs resolve --id <id>\`.
`;

export const INITIAL_REQUESTS_CONTENT = `# Context Requests

${TABLE_HEADER}
${TABLE_SEPARATOR}
`;

/**
 * Разбивает строку таблицы Markdown на ячейки с учетом экранированных пайпов (\\|).
 */
export function splitCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  const parts = [];
  let cur = "";
  let escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (escaped) {
      cur += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
      cur += ch;
    } else if (ch === "|") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * Форматирует строку таблицы Markdown с экранированием пайпов.
 */
export function formatRow(id, category, need, why, status, added) {
  const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
  return `| ${esc(id)} | ${esc(category)} | ${esc(need)} | ${esc(why)} | ${esc(status)} | ${esc(added)} |`;
}

/** Доминирующий перевод строки файла (CRLF на Windows, LF иначе). */
function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Разбирает содержимое REQUESTS.md.
 * Возвращает { headerFound, headerLineIndex, rows, malformed }.
 */
export function parseRequestsTable(content) {
  const lines = content.split(/\r?\n/);
  const rows = [];
  const malformed = [];
  let headerFound = false;
  let headerLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      continue;
    }

    const cells = splitCells(line);
    if (!cells) {
      continue;
    }

    if (!headerFound) {
      if (
        cells.length === 6 &&
        cells[0].toLowerCase() === "id" &&
        cells[1].toLowerCase() === "category" &&
        cells[2].toLowerCase() === "needed" &&
        cells[3].toLowerCase() === "why" &&
        cells[4].toLowerCase() === "status" &&
        cells[5].toLowerCase() === "added"
      ) {
        headerFound = true;
        headerLineIndex = i;
      }
      continue;
    }

    // Пропуск строки-разделителя |---|---|...
    if (cells.every((c) => /^:?-+:?$/.test(c))) {
      continue;
    }

    if (cells.length !== 6) {
      malformed.push({
        line,
        lineNum: i + 1,
        reason: `Неверное количество колонок: ${cells.length} (ожидается 6)`,
      });
      continue;
    }

    const [id, category, need, why, status, added] = cells;
    if (!id) {
      malformed.push({
        line,
        lineNum: i + 1,
        reason: "Пустой ID запроса",
      });
      continue;
    }

    const statusNorm = status.toLowerCase();
    if (statusNorm !== "open" && statusNorm !== "done") {
      malformed.push({
        line,
        lineNum: i + 1,
        reason: `Недопустимый статус "${status}" (допустимы: open, done)`,
      });
      continue;
    }

    rows.push({
      id,
      category,
      need,
      why,
      status: statusNorm,
      added,
      lineNum: i + 1,
      rawLine: line,
    });
  }

  return { headerFound, headerLineIndex, rows, malformed };
}

/**
 * Вычисляет следующий ID вида c<N>.
 */
export function getNextId(rows) {
  let maxId = 0;
  for (const r of rows) {
    const m = r.id.match(/^c(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxId) maxId = num;
    }
  }
  return `c${maxId + 1}`;
}

/**
 * Инициализирует папку context/ со структурой категорий и шаблонами.
 */
export function initContext(root = process.cwd()) {
  const contextDir = join(root, "context");
  mkdirSync(contextDir, { recursive: true });

  for (const cat of CATEGORIES) {
    mkdirSync(join(contextDir, cat), { recursive: true });
  }

  const readmePath = join(contextDir, "README.md");
  let readmeCreated = false;
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, README_CONTENT, "utf8");
    readmeCreated = true;
  }

  const requestsPath = join(contextDir, "REQUESTS.md");
  let requestsCreated = false;
  if (!existsSync(requestsPath)) {
    writeFileSync(requestsPath, INITIAL_REQUESTS_CONTENT, "utf8");
    requestsCreated = true;
  }

  return { contextDir, readmeCreated, requestsCreated };
}

/**
 * Добавляет запрос контекста в REQUESTS.md.
 */
export function requestContext({
  root = process.cwd(),
  category,
  need,
  why = "",
  hint = "",
}) {
  if (!category) {
    throw new Error(`Параметр --category обязателен. Допустимые: ${CATEGORIES.join(", ")}`);
  }
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Недопустимая категория "${category}". Допустимые: ${CATEGORIES.join(", ")}`);
  }
  if (!need || !need.trim()) {
    throw new Error("Параметр --need обязателен.");
  }

  const contextDir = join(root, "context");
  const requestsPath = join(contextDir, "REQUESTS.md");

  if (!existsSync(requestsPath)) {
    initContext(root);
  }

  const content = readFileSync(requestsPath, "utf8");
  const parsed = parseRequestsTable(content);

  if (parsed.malformed.length > 0) {
    for (const m of parsed.malformed) {
      console.warn(`[context-inbox] Пропущена некорректная строка ${m.lineNum}: "${m.line}" (${m.reason})`);
    }
  }

  const id = getNextId(parsed.rows);
  const added = new Date().toISOString().slice(0, 10);
  const dropPath = `context/${category}/`;

  let finalWhy = why ? why.trim() : "";
  if (hint && hint.trim()) {
    finalWhy = finalWhy ? `${finalWhy} (подсказка: ${hint.trim()})` : `Подсказка: ${hint.trim()}`;
  }
  if (!finalWhy) {
    finalWhy = "-";
  }

  const newRow = formatRow(id, category, need.trim(), finalWhy, "open", added);
  // Перевод строки берём из самого файла: молчаливое превращение CRLF-файла в LF
  // переписывает все строки пользовательского файла и ломает diff.
  const eol = detectEol(content);
  const updatedContent = content.replace(/(\r?\n)+$/, "") + eol + newRow + eol;
  writeFileSync(requestsPath, updatedContent, "utf8");

  return {
    id,
    category,
    dropPath,
    need: need.trim(),
    why: finalWhy,
    hint: hint ? hint.trim() : "",
    status: "open",
    added,
  };
}

/**
 * Возвращает открытые запросы и инвентарь файлов по категориям.
 */
export function listContext(root = process.cwd()) {
  const contextDir = join(root, "context");
  const requestsPath = join(contextDir, "REQUESTS.md");

  let requests = [];
  if (existsSync(requestsPath)) {
    const content = readFileSync(requestsPath, "utf8");
    const parsed = parseRequestsTable(content);

    if (parsed.malformed.length > 0) {
      for (const m of parsed.malformed) {
        console.warn(`[context-inbox] Пропущена некорректная строка ${m.lineNum}: "${m.line}" (${m.reason})`);
      }
    }

    requests = parsed.rows
      .filter((r) => r.status === "open")
      .map((r) => ({
        id: r.id,
        category: r.category,
        need: r.need,
        why: r.why,
        status: r.status,
        added: r.added,
      }));
  }

  const inventory = {};
  for (const cat of CATEGORIES) {
    const catDir = join(contextDir, cat);
    if (existsSync(catDir)) {
      try {
        const files = readdirSync(catDir, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => d.name)
          .sort();
        inventory[cat] = files;
      } catch {
        inventory[cat] = [];
      }
    } else {
      inventory[cat] = [];
    }
  }

  return { requests, inventory };
}

/**
 * Отмечает запрос как выполненный (status: done) с опциональной привязкой файла.
 */
export function resolveContext({ root = process.cwd(), id, file = "" }) {
  if (!id) {
    throw new Error("Параметр --id обязателен.");
  }

  const contextDir = join(root, "context");
  const requestsPath = join(contextDir, "REQUESTS.md");

  if (!existsSync(requestsPath)) {
    throw new Error(`Файл REQUESTS.md не найден по пути: ${requestsPath}`);
  }

  const content = readFileSync(requestsPath, "utf8");
  const lines = content.split(/\r?\n/);
  const parsed = parseRequestsTable(content);

  const target = parsed.rows.find((r) => r.id.toLowerCase() === id.toLowerCase());
  if (!target) {
    throw new Error(`Запрос с ID "${id}" не найден в REQUESTS.md`);
  }

  let finalWhy = target.why;
  if (file && file.trim()) {
    const fileRef = `[файл: ${file.trim()}]`;
    finalWhy = finalWhy && finalWhy !== "-" ? `${finalWhy} ${fileRef}` : fileRef;
  }

  const updatedRow = formatRow(
    target.id,
    target.category,
    target.need,
    finalWhy,
    "done",
    target.added
  );

  lines[target.lineNum - 1] = updatedRow;
  writeFileSync(requestsPath, lines.join(detectEol(content)), "utf8");

  return {
    id: target.id,
    category: target.category,
    status: "done",
    file: file ? file.trim() : "",
    why: finalWhy,
  };
}

/**
 * Проверяет структуру REQUESTS.md и открытые запросы.
 */
export function checkContext({ root = process.cwd(), strict = false }) {
  const contextDir = join(root, "context");
  const requestsPath = join(contextDir, "REQUESTS.md");

  if (!existsSync(requestsPath)) {
    return {
      valid: false,
      code: 1,
      errors: [`Файл REQUESTS.md не найден по пути: ${requestsPath}`],
      openCount: 0,
      totalCount: 0,
    };
  }

  const content = readFileSync(requestsPath, "utf8");
  const parsed = parseRequestsTable(content);
  const errors = [];

  if (!parsed.headerFound) {
    errors.push("Таблица REQUESTS.md не содержит корректного заголовка (| ID | Category | Needed | Why | Status | Added |)");
  }

  if (parsed.malformed.length > 0) {
    for (const m of parsed.malformed) {
      errors.push(`Некорректная строка ${m.lineNum}: ${m.reason} ("${m.line}")`);
    }
  }

  const seenIds = new Set();
  const duplicateIds = [];
  for (const r of parsed.rows) {
    const idLower = r.id.toLowerCase();
    if (seenIds.has(idLower)) {
      duplicateIds.push(r.id);
    }
    seenIds.add(idLower);
  }

  if (duplicateIds.length > 0) {
    errors.push(`Обнаружены повторяющиеся ID: ${duplicateIds.join(", ")}`);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: 1,
      errors,
      openCount: parsed.rows.filter((r) => r.status === "open").length,
      totalCount: parsed.rows.length,
    };
  }

  const openCount = parsed.rows.filter((r) => r.status === "open").length;

  if (strict && openCount > 0) {
    return {
      valid: false,
      code: 1,
      errors: [`Режим --strict: обнаружено открытых запросов контекста: ${openCount}`],
      openCount,
      totalCount: parsed.rows.length,
    };
  }

  return {
    valid: true,
    code: 0,
    errors: [],
    openCount,
    totalCount: parsed.rows.length,
  };
}

const FLAG_SPEC = {
  "--json": { bool: true, key: "json" },
  "--strict": { bool: true, key: "strict" },
  "--root": { key: "root" },
  "--category": { key: "category" },
  "--need": { key: "need" },
  "--why": { key: "why" },
  "--hint": { key: "hint" },
  "--id": { key: "id" },
  "--file": { key: "file" },
};

/**
 * Парсер аргументов командной строки.
 * Опечатанный или неполный флаг — ошибка, а не молчаливый пропуск:
 * `--need` без значения раньше уходил в неизвестность, а `--bogus` игнорировался.
 */
function printUsage() {
  console.log(`Использование: node tools/context-inbox.mjs <init|request|list|resolve|check> [опции]\n\n  init    [--root <dir>]\n  request --category <c> --need "<описание>" [--why "<причина>"] [--hint "<подсказка>"] [--root <dir>] [--json]\n  list    [--root <dir>] [--json]\n  resolve --id <N> [--file "<где лежит ответ>"] [--root <dir>]\n  check   [--root <dir>] [--json]   exit 1, если есть открытые запросы\n\nФлаги: --root, --category, --need, --why, --hint, --id, --file, --json, --help`);
}

export function parseArgs(argv) {
  const args = { _: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const spec = FLAG_SPEC[name];

    // --help/-h — это запрос справки, а не неизвестный флаг.
    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (!spec) {
      if (a.startsWith("-")) {
        args.errors.push(`неизвестный флаг ${a}`);
      } else {
        args._.push(a);
      }
      continue;
    }

    if (spec.bool) {
      if (inline !== null) {
        args.errors.push(`флаг ${name} не принимает значение`);
        continue;
      }
      args[spec.key] = true;
      continue;
    }

    const value = inline !== null ? inline : argv[i + 1];
    if (value === undefined || (inline === null && value.startsWith("-"))) {
      args.errors.push(`флаг ${name} требует значение`);
      continue;
    }
    if (inline === null) i++;
    args[spec.key] = value;
  }
  return args;
}

// Запуск из командной строки
const isDirectExecution =
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (isDirectExecution) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  const command = args._[0];
  const root = args.root || process.cwd();

  const USAGE =
    "Использование: node tools/context-inbox.mjs <init|request|list|resolve|check> [опции]\n" +
    "  init    [--root <dir>]\n" +
    '  request --category <c> --need "<описание>" [--why "<причина>"] [--hint "<подсказка>"] [--root <dir>] [--json]\n' +
    "  list    [--root <dir>] [--json]\n" +
    "  resolve --id <id> [--file <файл>] [--root <dir>] [--json]\n" +
    "  check   [--root <dir>] [--strict]";

  if (args.errors.length > 0) {
    for (const err of args.errors) {
      console.error(`Ошибка: ${err}.`);
    }
    console.error(USAGE);
    process.exit(2);
  }

  try {
    switch (command) {
      case "init": {
        const res = initContext(root);
        console.log(`Инициализирована папка контекста: context/`);
        console.log(`Категории: ${CATEGORIES.join(", ")}`);
        if (res.readmeCreated) console.log(`Создан файл: context/README.md`);
        if (res.requestsCreated) console.log(`Создан файл: context/REQUESTS.md`);
        process.exit(0);
        break;
      }

      case "request": {
        const res = requestContext({
          root,
          category: args.category,
          need: args.need,
          why: args.why,
          hint: args.hint,
        });
        if (args.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Запрос контекста зарегистрирован:`);
          console.log(`ID: ${res.id}`);
          console.log(`Категория: ${res.category}`);
          console.log(`Путь для размещения: ${res.dropPath}`);
          console.log(`Необходимо: ${res.need}`);
          if (res.why && res.why !== "-") console.log(`Причина/подсказка: ${res.why}`);
        }
        process.exit(0);
        break;
      }

      case "list": {
        const res = listContext(root);
        if (args.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("=== ОТКРЫТЫЕ ЗАПРОСЫ КОНТЕКСТА ===");
          if (res.requests.length === 0) {
            console.log("Открытых запросов нет.");
          } else {
            for (const r of res.requests) {
              console.log(`[${r.id}] ${r.category}: ${r.need} (причина: ${r.why}, добавлено: ${r.added})`);
            }
          }

          console.log("\n=== ИНВЕНТАРЬ КОНТЕКСТА ===");
          for (const cat of CATEGORIES) {
            const files = res.inventory[cat] || [];
            if (files.length === 0) {
              console.log(`${cat} (0 файлов): (пусто)`);
            } else {
              console.log(`${cat} (${files.length} файлов): ${files.join(", ")}`);
            }
          }
        }
        process.exit(0);
        break;
      }

      case "resolve": {
        const res = resolveContext({ root, id: args.id, file: args.file });
        if (args.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Запрос ${res.id} отмечен как выполнен (status: done).`);
          if (res.file) {
            console.log(`Привязан файл: ${res.file}`);
          }
        }
        process.exit(0);
        break;
      }

      case "check": {
        const res = checkContext({ root, strict: Boolean(args.strict) });
        if (res.valid) {
          console.log(`REQUESTS.md корректен. Открытых запросов: ${res.openCount} (всего: ${res.totalCount}).`);
          process.exit(0);
        } else {
          console.error("Ошибки проверки REQUESTS.md:");
          for (const err of res.errors) {
            console.error(`- ${err}`);
          }
          process.exit(res.code);
        }
        break;
      }

      default: {
        console.error(USAGE);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  }
}
