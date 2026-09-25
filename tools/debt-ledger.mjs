#!/usr/bin/env node
/**
 * tools/debt-ledger.mjs — инвентаризация и контроль отложенных упрощений (defer-маркеров).
 *
 * Формат маркера в коде (внутри комментария):
 *   defer`:` <что упрощено> | ceiling`:` <потолок> | upgrade`:` <триггер пересмотра>
 *
 * Ключевые поля ceiling и upgrade — опциональные именованные секции на той же строке.
 * Отсутствие upgrade помечается как noTrigger (риск загнивания упрощения).
 *
 * Экспорты:
 *   DEFAULT_MARKER
 *   parseMarkerLine(line, marker)
 *   scanText(text, file, marker)
 *   scanRepo(root, { marker })
 *   formatLedger(result)
 *   parseArgs(argv)
 *
 * CLI:
 *   node tools/debt-ledger.mjs scan [--root <dir>] [--json] [--check] [--write <file>] [--marker <key>]
 */

import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MARKER = "defer";

// Игнорируемые директории при рекурсивном сканировании репозитория
export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  ".archmap",
  "target",
]);

// Текстовые расширения исходного кода (markdown .md исключен намеренно!)
export const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs",
  ".ts", ".mts", ".cts", ".tsx", ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java", ".kt", ".kts",
  ".cs",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  ".rb",
  ".php",
  ".swift",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".ps1", ".psm1", ".psd1",
  ".vue", ".svelte",
  ".lua",
  ".scala",
  ".r",
  ".dart",
  ".zig",
  ".nim",
  ".pl", ".pm",
  ".ex", ".exs",
  ".erl", ".hrl",
  ".clj", ".cljs",
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1 MiB
const BINARY_CHECK_BYTES = 8192;   // 8 KiB

// Допустимые префиксы комментариев: // # -- ; /* * <!--
// Маркер должен начинать содержимое комментария: префикс + пробелы + маркер:
const COMMENT_PREFIX_PATTERN = "(?:\\/\\/|#|--|;|(?:\\/\\*+)|\\*|<!--)";
const COMMENT_PREFIX_REGEX = new RegExp(`^${COMMENT_PREFIX_PATTERN}`);

/**
 * Разбирает строку на наличие маркера отложенного упрощения.
 * Строка должна находиться внутри комментария (начинаться с одного из префиксов комментариев,
 * с учетом ведущих пробелов).
 *
 * @param {string} line - строка кода
 * @param {string} marker - ключевое слово маркера (по умолчанию DEFAULT_MARKER = "defer")
 * @returns {{ what: string, ceiling: string, upgrade: string, noTrigger: boolean, raw: string } | null}
 */
export function parseMarkerLine(line, marker = DEFAULT_MARKER) {
  if (typeof line !== "string") return null;

  const trimmed = line.trim();
  if (!trimmed) return null;

  // Маркер считается маркером, только если он начинает содержимое комментария:
  // сразу после префикса комментария и опциональных пробелов идёт <marker>:
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerLineRegex = new RegExp(`^${COMMENT_PREFIX_PATTERN}\\s*${escapedMarker}:\\s*`, "i");
  const match = markerLineRegex.exec(trimmed);
  if (!match) {
    return null;
  }

  const markerStartIndex = match[0].length;
  let payload = trimmed.slice(markerStartIndex).trim();
  // Удаляем закрывающие комментарии на конце строки, если они есть (например */ или -->)
  payload = payload.replace(/(?:\*\/|-->)\s*$/, "").trim();

  // Ищем позиции ключевых полей "ceiling:" и "upgrade:" внутри payload.
  // Разделитель "|" перед ними опционален:
  // `defer: <what> | ceiling: <limit> | upgrade: <trigger>`
  // `defer: <what> ceiling: <limit> upgrade: <trigger>`
  const ceilingRegex = /(?:\|\s*)?ceiling:\s*/i;
  const upgradeRegex = /(?:\|\s*)?upgrade:\s*/i;

  const ceilingMatch = ceilingRegex.exec(payload);
  const upgradeMatch = upgradeRegex.exec(payload);

  let what = "";
  let ceiling = "";
  let upgrade = "";

  // Определяем относительный порядок и границы секций
  const sections = [];
  if (ceilingMatch) {
    sections.push({
      key: "ceiling",
      index: ceilingMatch.index,
      matchLen: ceilingMatch[0].length,
    });
  }
  if (upgradeMatch) {
    sections.push({
      key: "upgrade",
      index: upgradeMatch.index,
      matchLen: upgradeMatch[0].length,
    });
  }

  sections.sort((a, b) => a.index - b.index);

  if (sections.length === 0) {
    // Только what, без ceiling и upgrade
    what = payload.trim();
  } else {
    what = payload.slice(0, sections[0].index).trim();
    for (let i = 0; i < sections.length; i++) {
      const current = sections[i];
      const start = current.index + current.matchLen;
      const end = i + 1 < sections.length ? sections[i + 1].index : payload.length;
      const val = payload.slice(start, end).trim();
      if (current.key === "ceiling") {
        ceiling = val;
      } else if (current.key === "upgrade") {
        upgrade = val;
      }
    }
  }

  // Очистка возможных хвостовых разделителей (',', '|') и пробелов у what, ceiling, upgrade
  what = what.replace(/[,|\s]+$/, "").trim();
  ceiling = ceiling.replace(/[,|\s]+$/, "").trim();
  upgrade = upgrade.replace(/[,|\s]+$/, "").trim();
  const noTrigger = !upgrade;

  return {
    what,
    ceiling,
    upgrade,
    noTrigger,
    raw: trimmed,
  };
}

/**
 * Сканирует текст файла построчно и возвращает найденные маркеры.
 * Если передан файл с расширением .md, он пропускается (возвращает пустой массив).
 *
 * @param {string} text - содержимое файла
 * @param {string} file - относительный или абсолютный путь к файлу
 * @param {string} marker - имя маркера
 * @returns {Array<{ file: string, line: number, what: string, ceiling: string, upgrade: string, noTrigger: boolean, raw: string }>}
 */
export function scanText(text, file, marker = DEFAULT_MARKER) {
  if (typeof text !== "string") return [];

  // Markdown никогда не сканируется, чтобы проза документации не самосрабатывала
  if (typeof file === "string" && extname(file).toLowerCase() === ".md") {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const parsed = parseMarkerLine(lines[i], marker);
    if (parsed) {
      results.push({
        file: file || "",
        line: lineNum,
        what: parsed.what,
        ceiling: parsed.ceiling,
        upgrade: parsed.upgrade,
        noTrigger: parsed.noTrigger,
        raw: parsed.raw,
      });
    }
  }

  return results;
}

/**
 * Проверяет, является ли файл бинарным по наличию NUL-байтов в первых 8 KiB.
 * @param {string} fullPath
 * @returns {boolean}
 */
function isBinaryFile(fullPath) {
  let fd = null;
  try {
    fd = openSync(fullPath, "r");
    const buf = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return true; // При ошибке чтения считаем файл непригодным для текстового сканирования
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Рекурсивно собирает пути ко всем подходящим текстовым файлам кода в репозитории.
 *
 * @param {string} dir - текущая директория
 * @param {string} root - корень сканирования
 * @param {string[]} acc - аккумулятор путей
 */
function collectCodeFiles(dir, root, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Сортируем директории и файлы для детерминированного порядка
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      collectCodeFiles(fullPath, root, acc);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) {
        continue;
      }

      try {
        const st = statSync(fullPath);
        if (st.size > MAX_FILE_SIZE) {
          continue; // пропускаем файлы > 1 MiB
        }
      } catch {
        continue;
      }

      if (isBinaryFile(fullPath)) {
        continue;
      }

      acc.push(fullPath);
    }
  }
}

/**
 * Сканирует репозиторий на наличие маркеров.
 *
 * @param {string} root - корневая директория репозитория
 * @param {{ marker?: string }} [options]
 * @returns {{ root: string, markers: Array<object>, byFile: Record<string, Array<object>>, total: number, noTrigger: number }}
 */
export function scanRepo(root, { marker = DEFAULT_MARKER } = {}) {
  const absRoot = resolve(root || ".");
  try {
    const st = statSync(absRoot);
    if (!st.isDirectory()) {
      const err = new Error(`Каталог не найден: ${root || "."}`);
      err.code = "ENOTDIR";
      throw err;
    }
  } catch (err) {
    if (err.code === "ENOTDIR") throw err;
    const notFoundErr = new Error(`Каталог не найден: ${root || "."}`);
    notFoundErr.code = "ENOENT";
    throw notFoundErr;
  }

  const filePaths = [];
  collectCodeFiles(absRoot, absRoot, filePaths);

  // Сортируем пути детерминированно
  filePaths.sort();

  const allMarkers = [];
  const byFile = {};

  for (const fullPath of filePaths) {
    const relPath = relative(absRoot, fullPath).replace(/\\/g, "/");
    let content;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    const fileMarkers = scanText(content, relPath, marker);
    if (fileMarkers.length > 0) {
      byFile[relPath] = fileMarkers;
      for (const m of fileMarkers) {
        allMarkers.push(m);
      }
    }
  }

  // Общий счетчик noTrigger
  let noTriggerCount = 0;
  for (const m of allMarkers) {
    if (m.noTrigger) {
      noTriggerCount++;
    }
  }

  return {
    root: absRoot,
    markers: allMarkers,
    byFile,
    total: allMarkers.length,
    noTrigger: noTriggerCount,
  };
}

/**
 * Форматирует результат сканирования в человекочитаемый отчет на русском языке.
 *
 * Построчный формат:
 *   <file>:<line> — <what> | ceiling: … | upgrade: …
 * При отсутствии upgrade: выводится метка [no-trigger].
 * Итог:
 *   <N> маркеров, <M> без триггера.
 * Если маркеров нет:
 *   Чисто: отложенных упрощений нет.
 *
 * @param {{ root: string, markers: Array<object>, byFile: Record<string, Array<object>>, total: number, noTrigger: number }} result
 * @returns {string}
 */
export function formatLedger(result) {
  if (!result || result.total === 0) {
    return "Чисто: отложенных упрощений нет.\n";
  }

  const lines = [];
  const sortedFiles = Object.keys(result.byFile || {}).sort();

  for (const file of sortedFiles) {
    lines.push(`## ${file}`);
    const fileMarkers = result.byFile[file] || [];
    for (const m of fileMarkers) {
      const parts = [`${m.file}:${m.line} — ${m.what}`];
      if (m.ceiling) {
        parts.push(`ceiling: ${m.ceiling}`);
      }
      if (m.upgrade) {
        parts.push(`upgrade: ${m.upgrade}`);
      } else {
        parts.push("[no-trigger]");
      }
      lines.push(`  ${parts.join(" | ")}`);
    }
    lines.push("");
  }

  lines.push(`${result.total} маркеров, ${result.noTrigger} без триггера.`);
  return lines.join("\n") + "\n";
}

/**
 * Форматирует результат в виде детерминированного Markdown-реестра для записи через --write.
 *
 * @param {{ root: string, markers: Array<object>, byFile: Record<string, Array<object>>, total: number, noTrigger: number }} result
 * @returns {string}
 */
export function formatMarkdownLedger(result) {
  const lines = [
    "# Debt Ledger",
    "",
    `Сводка: ${result.total} маркеров, ${result.noTrigger} без триггера.`,
    "",
  ];

  if (result.total === 0) {
    lines.push("Чисто: отложенных упрощений нет.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| Файл | Строка | Что упрощено | Потолок | Триггер пересмотра | Статус |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  const sortedFiles = Object.keys(result.byFile || {}).sort();
  for (const file of sortedFiles) {
    const fileMarkers = result.byFile[file] || [];
    for (const m of fileMarkers) {
      const status = m.noTrigger ? "⚠️ no-trigger" : "✅ ok";
      const ceiling = m.ceiling ? m.ceiling.replace(/\|/g, "\\|") : "—";
      const upgrade = m.upgrade ? m.upgrade.replace(/\|/g, "\\|") : "—";
      const what = m.what.replace(/\|/g, "\\|");
      lines.push(`| \`${file}\` | ${m.line} | ${what} | ${ceiling} | ${upgrade} | ${status} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

const FLAG_SPEC = {
  "--help": { bool: true, key: "help" },
  "-h": { bool: true, key: "help" },
  "--json": { bool: true, key: "json" },
  "--check": { bool: true, key: "check" },
  "--root": { key: "root" },
  "--write": { key: "write" },
  "--marker": { key: "marker" },
};

/**
 * Разбор аргументов командной строки в стиле context-inbox.mjs.
 * Опечатка в флаге (`--markr TODO`) раньше становилась позиционным аргументом
 * и молча выключала проверку — гейт отдавал ложный зелёный. Флаг, требующий
 * значения, теперь тоже обязателен: `--root` без значения ошибкой, а не cwd.
 *
 * @param {string[]} argv
 * @returns {{ _: string[], errors: string[], root?: string, json?: boolean, check?: boolean, write?: string, marker?: string, help?: boolean }}
 */
export function parseArgs(argv) {
  const args = { _: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const spec = FLAG_SPEC[name];

    if (!spec) {
      if (arg.startsWith("-")) {
        args.errors.push(`неизвестный флаг ${arg}`);
      } else {
        args._.push(arg);
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

function printUsage() {
  console.log(`debt-ledger.mjs — инвентаризация и контроль отложенных упрощений (defer-маркеров)

Использование:
  node tools/debt-ledger.mjs scan [--root <dir>] [--json] [--check] [--write <file>] [--marker <key>]

Команды:
  scan                   Сканировать репозиторий и вывести реестр маркеров (по умолчанию)

Флаги:
  --root <dir>           Директория репозитория (по умолчанию: текущий рабочий каталог)
  --json                 Вывод в формате JSON: {root, total, noTrigger, byFile}
  --check                CI-гейт: завершиться с кодом 1, если есть no-trigger маркеры, иначе 0
  --write <file>         Записать детерминированный Markdown-реестр в указанный файл
  --marker <key>         Ключевое слово маркера (по умолчанию: "defer")
  --help, -h             Показать справку
`);
}

/**
 * Точка входа CLI.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {number} код завершения
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    for (const err of args.errors) {
      console.error(`Ошибка: ${err}.`);
    }
    printUsage();
    return 2;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  const cmd = args._[0] || "scan";
  if (cmd !== "scan") {
    console.error(`Неизвестная команда: "${cmd}". Доступно: scan`);
    printUsage();
    return 1;
  }

  const root = args.root ? resolve(args.root) : process.cwd();
  const marker = args.marker || DEFAULT_MARKER;

  let result;
  try {
    result = scanRepo(root, { marker });
  } catch {
    console.error(`Каталог не найден: ${args.root || "."}`);
    return 2;
  }
  if (args.write !== undefined) {
    if (!args.write) {
      console.error("Ошибка: --write требует путь к файлу реестра.");
      return 2;
    }
    const writePath = resolve(root, args.write);
    try {
      writeFileSync(writePath, formatMarkdownLedger(result), "utf8");
    } catch (err) {
      console.error(`Ошибка: не удалось записать реестр в ${writePath} (${err.code || err.message}).`);
      return 2;
    }
  }

  if (args.json) {
    const output = {
      root: result.root,
      total: result.total,
      noTrigger: result.noTrigger,
      byFile: result.byFile,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stdout.write(formatLedger(result));
  }

  if (args.check) {
    return result.noTrigger > 0 ? 1 : 0;
  }

  return 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exit(main());
}
