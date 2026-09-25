#!/usr/bin/env node
/**
 * tools/code-size.mjs — контроль размера исходного кода и функций (size gate).
 *
 * Пороговые значения (по умолчанию):
 *   maxLines: 700 строк на файл
 *   maxFunctionLines: 120 строк на функцию
 * Конфигурация переопределяется через .code-size.json в корне проекта.
 *
 * Escape-люки:
 *   - Маркер defer: в заголовке файла (первые 50 строк) освобождает файл от падения при росте.
 *   - Комментарий // code-size:allow (или # code-size:allow) на строке объявления функции освобождает функцию.
 *
 * Базовая линия:
 *   .code-size.baseline.json фиксирует текущие превышения, предотвращая блокировку существующего кода.
 *   `check` падает ТОЛЬКО при:
 *     (a) росте файла/функции сверх baselined размера, или
 *     (b) появлении НОВОГО нарушителя, отсутствующего в baseline.
 *
 * CLI:
 *   node tools/code-size.mjs check [--root <dir>] [--json] [--baseline <file>]
 *   node tools/code-size.mjs baseline [--root <dir>] [--json] [--baseline <file>]
 *   node tools/code-size.mjs scan [--root <dir>] [--json]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_THRESHOLDS = { maxLines: 700, maxFunctionLines: 120 };
export const DEFAULT_SCOPE = [
  "tools/**/*.mjs",
  "tools/tests/**/*.mjs",
  "skills/*/scripts/*.py",
  "*.ps1",
  "*.sh",
];
export const DEFAULT_BASELINE_FILE = ".code-size.baseline.json";
export const DEFAULT_CONFIG_FILE = ".code-size.json";

// Directories the repository does not distribute as live source. `_archive` and
// `skills-archive` hold parked material (both are gitignored); `bench` and `worktrees`
// are generated. Scanning them reports offenders nobody can act on.
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "data",
  "_archive",
  "skills-archive",
  "skills-tmp",
  "worktrees",
  "migration-backup",
  "bench",
]);
const COMMENT_PREFIX = "(?:\\/\\/|#|--|;|(?:\\/\\*+)|\\*|<!--)";
const DEFER_HEADER_REGEX = new RegExp(`^[ \\t]*${COMMENT_PREFIX}\\s*defer:\\s*`, "i");
const ALLOW_REGEX = /(?:\/\/|#)\s*code-size:allow\b/;

export function globToRegex(glob) {
  const norm = glob.replace(/\\/g, "/");
  const hasSlash = norm.includes("/");
  let reStr = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*" && norm[i + 1] === "*") {
      if (norm[i + 2] === "/") { reStr += "(?:.*/)?"; i += 2; }
      else { reStr += ".*"; i += 1; }
    } else if (c === "*") { reStr += "[^/]*"; }
    else if (c === "?") { reStr += "[^/]"; }
    else if ("[].+^${}()|\\".includes(c)) { reStr += "\\" + c; }
    else { reStr += c; }
  }
  return new RegExp(hasSlash ? `^${reStr}$` : `^(?:.*\\/)?${reStr}$`);
}

export function hasHeaderDeferMarker(text, maxHeaderLines = 50) {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/);
  const limit = Math.min(lines.length, maxHeaderLines);
  for (let i = 0; i < limit; i++) {
    if (DEFER_HEADER_REGEX.test(lines[i])) return true;
  }
  return false;
}

function findOpenBrace(lines, startLineIdx, maxLookahead = 20) {
  const limit = Math.min(lines.length, startLineIdx + maxLookahead);
  for (let l = startLineIdx; l < limit; l++) {
    const col = lines[l].indexOf("{");
    if (col !== -1) return { lineIdx: l, colIdx: col };
  }
  return null;
}

function isEscaped(str, idx) {
  let count = 0;
  for (let i = idx - 1; i >= 0 && str[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

function countToMatchingBrace(lines, startLineIdx, openColIdx, options = {}) {
  const { supportsTemplates = false, shellComment = false } = options;
  let depth = 0;
  let inSingle = false, inDouble = false, inBlockComment = false;
  const templateStack = [];

  for (let l = startLineIdx; l < lines.length; l++) {
    const curLine = lines[l];
    let inLineComment = false;
    const cStart = (l === startLineIdx) ? openColIdx : 0;

    for (let c = cStart; c < curLine.length; c++) {
      const ch = curLine[c];
      const prev = c > 0 ? curLine[c - 1] : "";
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === "/" && prev === "*") inBlockComment = false;
        continue;
      }
      if (inSingle) {
        if (ch === "'" && !isEscaped(curLine, c)) inSingle = false;
        continue;
      }
      if (inDouble) {
        if (ch === '"' && !isEscaped(curLine, c)) inDouble = false;
        continue;
      }

      // Template string literal: top is null
      if (supportsTemplates && templateStack.length > 0 && templateStack[templateStack.length - 1] === null) {
        if (ch === "`" && !isEscaped(curLine, c)) {
          templateStack.pop();
        } else if (ch === "$" && curLine[c + 1] === "{" && !isEscaped(curLine, c)) {
          c++;
          templateStack[templateStack.length - 1] = 0;
        }
        continue;
      }

      // Template expression: top is number (brace depth inside expression)
      if (supportsTemplates && templateStack.length > 0 && typeof templateStack[templateStack.length - 1] === "number") {
        if (ch === "/" && curLine[c + 1] === "/") { inLineComment = true; break; }
        if (ch === "/" && curLine[c + 1] === "*") { inBlockComment = true; c++; continue; }
        if (ch === "'") { inSingle = true; continue; }
        if (ch === '"') { inDouble = true; continue; }
        if (ch === "`") { templateStack.push(null); continue; }

        if (ch === "{") {
          templateStack[templateStack.length - 1]++;
        } else if (ch === "}") {
          if (templateStack[templateStack.length - 1] > 0) {
            templateStack[templateStack.length - 1]--;
          } else {
            templateStack[templateStack.length - 1] = null;
          }
        }
        continue;
      }

      // Normal code outside template literals
      if (shellComment) {
        if (ch === "#") { inLineComment = true; break; }
      } else {
        if (ch === "/" && curLine[c + 1] === "/") { inLineComment = true; break; }
        if (ch === "/" && curLine[c + 1] === "*") { inBlockComment = true; c++; continue; }
      }

      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (supportsTemplates && ch === "`") { templateStack.push(null); continue; }

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return l + 1;
      }
    }
  }
  return null;
}

function parseBracedFunction(lines, lineIdx, name, allowed, braceOpts) {
  const bracePos = findOpenBrace(lines, lineIdx, 20);
  if (!bracePos) return null;
  const endLine = countToMatchingBrace(lines, bracePos.lineIdx, bracePos.colIdx, braceOpts);
  if (endLine === null) return null;
  const startLine = lineIdx + 1;
  return { name, startLine, endLine, lines: endLine - startLine + 1, allowed };
}

function matchJsFunctionDecl(lines, i) {
  const line = lines[i];
  const fnMatch = line.match(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)?/);
  if (fnMatch) return { name: fnMatch[1] || "anonymous" };

  const fnExprMatch = line.match(/^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?function/);
  if (fnExprMatch) return { name: fnExprMatch[1] };

  const singleArrow = line.match(/^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>)/);
  if (singleArrow) return { name: singleArrow[1] };

  const multiArrow = line.match(/^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(/);
  if (multiArrow) {
    const limit = Math.min(lines.length, i + 10);
    for (let l = i; l < limit; l++) {
      if (lines[l].includes("=>")) return { name: multiArrow[1] };
      if (lines[l].includes(";")) break;
    }
  }
  return null;
}

export function scanJsFunctions(lines) {
  const results = [];
  let i = 0;
  while (i < lines.length) {
    const match = matchJsFunctionDecl(lines, i);
    if (match) {
      const fn = parseBracedFunction(lines, i, match.name, ALLOW_REGEX.test(lines[i]), { supportsTemplates: true });
      if (fn) { results.push(fn); i = fn.endLine - 1; }
    }
    i++;
  }
  return results;
}

export function scanPythonFunctions(lines) {
  const fns = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const defMatch = line.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
    if (defMatch) {
      const indent = defMatch[1].length;
      const name = defMatch[2];
      const startLine = i + 1;
      let lastBodyLine = startLine;
      let inTriple = null;

      let j = i + 1;
      for (; j < lines.length; j++) {
        const cur = lines[j];
        const trimmed = cur.trim();
        if (inTriple) {
          lastBodyLine = j + 1;
          if (cur.includes(inTriple)) inTriple = null;
          continue;
        }
        const matchTriple = cur.match(/(?:[fFrRbBuU]*)("""|''')/);
        if (matchTriple) {
          const quote = matchTriple[1];
          const parts = cur.split(quote);
          if ((parts.length - 1) % 2 === 1) inTriple = quote;
          lastBodyLine = j + 1;
          continue;
        }
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        if (cur.match(/^([ \t]*)/)[1].length <= indent) break;
        lastBodyLine = j + 1;
      }
      fns.push({ name, startLine, endLine: lastBodyLine, lines: lastBodyLine - startLine + 1, allowed: ALLOW_REGEX.test(line) });
      i = j - 1;
    }
    i++;
  }
  return fns;
}

export function scanShellFunctions(lines, ext) {
  const results = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match = null;
    if (ext === ".ps1") {
      const psMatch = line.match(/^[ \t]*(?:function|filter)\s+([a-zA-Z0-9_:-]+)/i);
      if (psMatch) match = psMatch[1];
    } else {
      const shMatch = line.match(/^[ \t]*(?:function\s+)?([a-zA-Z0-9_-]+)\s*\(\)\s*\{/) ||
                      line.match(/^[ \t]*function\s+([a-zA-Z0-9_-]+)\s*\{/);
      if (shMatch) match = shMatch[1];
    }
    if (match) {
      const fn = parseBracedFunction(lines, i, match, ALLOW_REGEX.test(line), { shellComment: true });
      if (fn) { results.push(fn); i = fn.endLine - 1; }
    }
    i++;
  }
  return results;
}

export function scanFunctions(code, ext) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const lowerExt = (ext || "").toLowerCase();
  if (lowerExt === ".py") return scanPythonFunctions(lines);
  if (lowerExt === ".ps1") return scanShellFunctions(lines, ".ps1");
  if (lowerExt === ".sh" || lowerExt === ".bash") return scanShellFunctions(lines, ".sh");
  return scanJsFunctions(lines);
}

export function collectFiles(root, scopePatterns = DEFAULT_SCOPE) {
  const regexes = scopePatterns.map(globToRegex);
  const results = [];

  function walk(currentDir) {
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".")) continue;
        walk(join(currentDir, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(root, join(currentDir, entry.name)).replace(/\\/g, "/");
        if (regexes.some((r) => r.test(rel))) results.push(rel);
      }
    }
  }
  walk(resolve(root));
  return results.sort();
}

export function loadConfig(root) {
  const cfgPath = join(root, DEFAULT_CONFIG_FILE);
  if (!existsSync(cfgPath)) return { ...DEFAULT_THRESHOLDS, scope: [...DEFAULT_SCOPE] };
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
    return {
      maxLines: typeof parsed.maxLines === "number" ? parsed.maxLines : DEFAULT_THRESHOLDS.maxLines,
      maxFunctionLines: typeof parsed.maxFunctionLines === "number" ? parsed.maxFunctionLines : DEFAULT_THRESHOLDS.maxFunctionLines,
      scope: Array.isArray(parsed.scope) && parsed.scope.length > 0 ? parsed.scope : [...DEFAULT_SCOPE],
    };
  } catch (err) {
    throw new Error(`Ошибка чтения конфигурации ${cfgPath}: ${err.message}`);
  }
}

export function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return { files: {}, functions: {} };
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8").replace(/^\uFEFF/, ""));
    return {
      files: (parsed && typeof parsed.files === "object") ? parsed.files : {},
      functions: (parsed && typeof parsed.functions === "object") ? parsed.functions : {},
    };
  } catch (err) {
    throw new Error(`Ошибка чтения baseline ${baselinePath}: ${err.message}`);
  }
}

export function scanFile(root, relPath) {
  const fullPath = join(root, relPath);
  const text = readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
  const norm = text.replace(/\r\n/g, "\n");
  const linesCount = norm.length === 0 ? 0 : norm.split("\n").length;
  const dotIdx = relPath.lastIndexOf(".");
  const fns = scanFunctions(norm, dotIdx !== -1 ? relPath.slice(dotIdx) : "");

  const nameCounts = new Map();
  const functionsWithKeys = fns.map((fn) => {
    const cur = (nameCounts.get(fn.name) || 0) + 1;
    nameCounts.set(fn.name, cur);
    return { ...fn, key: cur > 1 ? `${relPath}:${fn.name}#${cur}` : `${relPath}:${fn.name}` };
  });

  return {
    relPath,
    lines: linesCount,
    deferExempt: hasHeaderDeferMarker(norm),
    functions: functionsWithKeys,
  };
}

export function buildBaseline(root, options = {}) {
  const config = options.config || loadConfig(root);
  const baselinePath = options.baselinePath || join(root, DEFAULT_BASELINE_FILE);
  const existing = existsSync(baselinePath) ? loadBaseline(baselinePath) : { files: {}, functions: {} };

  const filesList = collectFiles(root, config.scope);
  const fileOffenders = {};
  const fnOffenders = {};

  for (const rel of filesList) {
    const scanned = scanFile(root, rel);
    if (scanned.lines > config.maxLines) {
      fileOffenders[rel] = { lines: scanned.lines, reason: existing.files[rel]?.reason || "" };
    }
    for (const fn of scanned.functions) {
      if (fn.lines > config.maxFunctionLines) {
        fnOffenders[fn.key] = {
          lines: fn.lines,
          file: rel,
          name: fn.name,
          line: fn.startLine,
          reason: existing.functions[fn.key]?.reason || "",
        };
      }
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    thresholds: { maxLines: config.maxLines, maxFunctionLines: config.maxFunctionLines },
    files: fileOffenders,
    functions: fnOffenders,
  };
}

function processOffender({ lines, baselined, limit, isExempt, reasonText }) {
  if (baselined) {
    if (lines > baselined.lines) {
      const diff = lines - baselined.lines;
      return isExempt
        ? { status: "grew_exempt", exempt: true, diff, failType: null, reason: reasonText }
        : { status: "grew", exempt: false, diff, failType: "growth", reason: null };
    }
    return { status: "baselined", exempt: false, diff: 0, failType: null, reason: null };
  }
  const diff = lines - limit;
  return isExempt
    ? { status: "new_exempt", exempt: true, diff, failType: null, reason: reasonText }
    : { status: "new", exempt: false, diff, failType: "new", reason: null };
}

export function checkCodeSize(root, options = {}) {
  const config = options.config || loadConfig(root);
  const baselinePath = options.baselinePath || join(root, DEFAULT_BASELINE_FILE);
  const baseline = loadBaseline(baselinePath);

  const filesList = collectFiles(root, config.scope);
  const failures = [];
  const reportedFiles = [];
  const reportedFunctions = [];

  let totalFunctions = 0;
  let fileOffenderCount = 0;
  let fnOffenderCount = 0;
  let exemptCount = 0;
  let baselinedCount = 0;

  for (const rel of filesList) {
    const scanned = scanFile(root, rel);
    totalFunctions += scanned.functions.length;

    if (scanned.lines > config.maxLines) {
      fileOffenderCount++;
      const baseEntry = baseline.files[rel];
      const res = processOffender({
        lines: scanned.lines,
        baselined: baseEntry,
        limit: config.maxLines,
        isExempt: scanned.deferExempt,
        reasonText: "defer marker in header",
      });
      if (res.exempt) exemptCount++;
      else if (res.status === "baselined") baselinedCount++;

      if (res.failType === "growth") {
        failures.push({
          type: "file_growth",
          file: rel,
          message: `Файл вырос сверх baseline: ${rel} (${scanned.lines} > baseline ${baseEntry.lines}, +${res.diff})`,
        });
      } else if (res.failType === "new") {
        failures.push({
          type: "file_new",
          file: rel,
          message: `Новый файл превышает порог: ${rel} (${scanned.lines} > max ${config.maxLines})`,
        });
      }
      reportedFiles.push({ file: rel, lines: scanned.lines, baseLines: baseEntry?.lines ?? null, ...res });
    }

    for (const fn of scanned.functions) {
      if (fn.lines > config.maxFunctionLines) {
        fnOffenderCount++;
        const baseEntry = baseline.functions[fn.key];
        const res = processOffender({
          lines: fn.lines,
          baselined: baseEntry,
          limit: config.maxFunctionLines,
          isExempt: fn.allowed,
          reasonText: "code-size:allow comment",
        });
        if (res.exempt) exemptCount++;
        else if (res.status === "baselined") baselinedCount++;

        if (res.failType === "growth") {
          failures.push({
            type: "function_growth",
            file: rel,
            message: `Функция выросла сверх baseline: ${rel}:${fn.startLine} ${fn.name}() (${fn.lines} > baseline ${baseEntry.lines}, +${res.diff})`,
          });
        } else if (res.failType === "new") {
          failures.push({
            type: "function_new",
            file: rel,
            message: `Новая функция превышает порог: ${rel}:${fn.startLine} ${fn.name}() (${fn.lines} > max ${config.maxFunctionLines})`,
          });
        }
        reportedFunctions.push({ file: rel, key: fn.key, name: fn.name, line: fn.startLine, lines: fn.lines, baseLines: baseEntry?.lines ?? null, ...res });
      }
    }
  }

  return {
    ok: failures.length === 0,
    thresholds: { maxLines: config.maxLines, maxFunctionLines: config.maxFunctionLines },
    stats: {
      scannedFiles: filesList.length,
      scannedFunctions: totalFunctions,
      fileOffenders: fileOffenderCount,
      functionOffenders: fnOffenderCount,
      failures: failures.length,
      exempt: exemptCount,
      baselined: baselinedCount,
    },
    failures,
    files: reportedFiles,
    functions: reportedFunctions,
  };
}

export function parseArgs(argv) {
  const args = { _: [], root: null, baseline: null, json: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "-r") {
      if (i + 1 < argv.length) args.root = argv[++i];
      else args.errors.push("Флаг --root требует указания пути");
    } else if (a === "--baseline" || a === "-b") {
      if (i + 1 < argv.length) args.baseline = argv[++i];
      else args.errors.push("Флаг --baseline требует указания пути");
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a.startsWith("-")) {
      args.errors.push(`Неизвестный флаг '${a}'`);
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printUsage() {
  console.log(`tools/code-size.mjs — контроль размера исходного кода и функций

Команды:
  check     Проверить дерево на превышения порогов и дрейф от baseline (exit 1 при нарушении)
  baseline  Создать/обновить .code-size.baseline.json с текущими нарушителями
  scan      Показать текущие нарушители без сверки с baseline

Опции:
  --root, -r <dir>       Корень репозитория (по умолчанию: текущий каталог)
  --baseline, -b <file>  Путь к baseline-файлу (по умолчанию: .code-size.baseline.json)
  --json                 Вывод в формате JSON
  --help, -h             Справка

Escape-люки:
  // defer: <что> | ceiling: <порог> | upgrade: <когда>   в первых 50 строках файла
  // code-size:allow                                      на строке объявления функции
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const err of args.errors) console.error(`code-size: ${err}`);
    printUsage();
    return 2;
  }
  if (args.help) { printUsage(); return 0; }

  const root = args.root ? resolve(args.root) : process.cwd();
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`code-size: каталог --root '${root}' не существует`);
    return 2;
  }

  const baselinePath = args.baseline ? resolve(args.baseline) : join(root, DEFAULT_BASELINE_FILE);
  const command = args._[0];
  if (!command) { printUsage(); return 0; }

  let config;
  try { config = loadConfig(root); }
  catch (err) { console.error(`code-size: ${err.message}`); return 2; }

  if (command === "baseline") {
    try {
      const data = buildBaseline(root, { baselinePath, config });
      writeFileSync(baselinePath, JSON.stringify(data, null, 2) + "\n", "utf8");
      const fileCount = Object.keys(data.files).length;
      const fnCount = Object.keys(data.functions).length;
      const rel = relative(root, baselinePath).replace(/\\/g, "/") || baselinePath;

      if (args.json) {
        console.log(JSON.stringify({ ok: true, baseline: rel, files: fileCount, functions: fnCount }, null, 2));
      } else {
        console.log(`code-size: baseline сохранён в ${rel} (файлов: ${fileCount}, функций: ${fnCount}).`);
      }
      return 0;
    } catch (err) {
      console.error(`code-size: ошибка создания baseline: ${err.message}`);
      return 2;
    }
  }

  if (command === "check") {
    let result;
    try { result = checkCodeSize(root, { baselinePath, config }); }
    catch (err) { console.error(`code-size: ${err.message}`); return 2; }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const exemptFiles = result.files.filter((x) => x.exempt);
      const exemptFns = result.functions.filter((x) => x.exempt);
      for (const f of exemptFiles) {
        console.log(`  [EXEMPT] ${f.file} (${f.lines} строк) — ${f.reason}`);
      }
      for (const fn of exemptFns) {
        console.log(`  [EXEMPT] ${fn.file}:${fn.line} ${fn.name}() (${fn.lines} строк) — ${fn.reason}`);
      }
      if (result.failures.length > 0) {
        console.error("code-size: ОБНАРУЖЕНЫ НАРУШЕНИЯ РАЗМЕРА КОДА\n");
        for (const f of result.failures) console.error(`  [FAIL] ${f.message}`);
        console.error(`\ncode-size: FAIL — ${result.failures.length} нарушений. Зафиксируйте \`baseline\` или добавьте \`defer:\` / \`code-size:allow\`.`);
      } else {
        const exemptNotes = result.stats.exempt > 0 ? ` (${result.stats.exempt} exempt)` : "";
        console.log(`code-size: PASS — нарушений нет${exemptNotes}. Проверено ${result.stats.scannedFiles} файлов, ${result.stats.scannedFunctions} функций.`);
      }
    }
    return result.ok ? 0 : 1;
  }

  if (command === "scan") {
    const filesList = collectFiles(root, config.scope);
    const offenders = [];
    for (const rel of filesList) {
      const scanned = scanFile(root, rel);
      if (scanned.lines > config.maxLines) {
        offenders.push({ type: "file", file: rel, lines: scanned.lines, threshold: config.maxLines, deferExempt: scanned.deferExempt });
      }
      for (const fn of scanned.functions) {
        if (fn.lines > config.maxFunctionLines) {
          offenders.push({ type: "function", file: rel, name: fn.name, line: fn.startLine, lines: fn.lines, threshold: config.maxFunctionLines, allowed: fn.allowed });
        }
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ ok: true, offenders }, null, 2));
    } else {
      console.log(`code-size: найдено ${offenders.length} нарушителей (${config.maxLines} строк файл, ${config.maxFunctionLines} строк функция):\n`);
      for (const o of offenders) {
        if (o.type === "file") {
          const ex = o.deferExempt ? " [EXEMPT: defer]" : "";
          console.log(`  FILE  ${o.file}: ${o.lines} строк (порог ${o.threshold})${ex}`);
        } else {
          const ex = o.allowed ? " [EXEMPT: allow]" : "";
          console.log(`  FUNC  ${o.file}:${o.line} ${o.name}(): ${o.lines} строк (порог ${o.threshold})${ex}`);
        }
      }
    }
    return 0;
  }

  console.error(`code-size: неизвестная команда '${command}'`);
  printUsage();
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
