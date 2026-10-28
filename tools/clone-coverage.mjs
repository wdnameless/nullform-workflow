#!/usr/bin/env node
/**
 * tools/clone-coverage.mjs — контроль дублирования кода (Type-1/Type-2 clone detector & ratchet gate).
 *
 * Пороговые значения (по умолчанию):
 *   minLines: 10 строк на окно клона (минимальный размер для фиксации)
 *   failLines: 35 строк на блок (порог блокировки в CI при отсутствии в baseline)
 *
 * Границы обнаружения (честная спецификация):
 *   - Type-1: идентичный нормализованный код (удалены комментарии, пустые строки, свёрнуты пробелы).
 *   - Type-2: синтаксически идентичный код после токенизации (замена идентификаторов, чисел, строк).
 *   - НЕ ЛОВИТ: Type-3 (клоны с пропусками/перестановками операторов), Type-4 (семантические эквиваленты
 *     с разной синтаксической структурой), нейросетевые/эмбеддинговые подобия.
 *   - Исключены ли тесты из области видимости по умолчанию? НЕТ. Клоны в тестовых файлах реальны:
 *     дублирование фикстур, повторяющиеся блоки проверок и копипаста хелперов требуют контроля
 *     и рефакторинга наравне с продуктовым кодом.
 *
 * Escape-люки:
 *   - Маркер defer: в заголовке файла (первые 50 строк) освобождает файл от падения.
 *   - Комментарий // clone:allow (или # clone:allow, // clone-coverage:allow) на строке начала клона.
 *
 * defer: Type-1/2 sliding-window clone detector | ceiling: 700 lines | upgrade: AST-based Type-3 clone detector
 *
 * Базовая линия:
 *   .clone-baseline.json фиксирует существующие блоки >= failLines, предотвращая блокировку legacy-кода.
 *   `check` падает ТОЛЬКО при:
 *     (a) росте клона сверх baselined размера, или
 *     (b) появлении НОВОГО клона >= failLines, отсутствующего в baseline.
 *
 * CLI:
 *   node tools/clone-coverage.mjs check [--root <dir>] [--json] [--baseline <file>]
 *   node tools/clone-coverage.mjs baseline [--root <dir>] [--json] [--baseline <file>]
 *   node tools/clone-coverage.mjs scan [--root <dir>] [--json]
 */

import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  DEFAULT_SCOPE,
  globToRegex,
  collectFiles,
  loadBaseline as _loadCodeSizeBaseline,
  hasHeaderDeferMarker,
  parseArgs,
} from "./code-size.mjs";

export const DEFAULT_THRESHOLDS = { minLines: 10, failLines: 35 };
export { DEFAULT_SCOPE, globToRegex, parseArgs };
export const DEFAULT_BASELINE_FILE = ".clone-baseline.json";

export function loadScope(root) {
  const configFile = join(root, ".clone.json");
  if (existsSync(configFile)) {
    try {
      const data = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
      if (Array.isArray(data?.scope)) {
        return data.scope;
      }
    } catch {}
  }
  return DEFAULT_SCOPE;
}
function resolveThresholds(options = {}) {
  const minLines = options.minLines ?? options.thresholds?.minLines ?? DEFAULT_THRESHOLDS.minLines;
  const failLines = options.failLines ?? options.thresholds?.failLines ?? DEFAULT_THRESHOLDS.failLines;
  return { minLines, failLines };
}

const STRIP_COMMENT_RE = /(["'`])(?:\\.|(?!\1)[^\\])*\1|(\/\/.*$|#.*$|\/\*.*?\*\/)/g;
const TOKEN_RE = /(["'`])(?:\\.|(?!\1)[^\\])*\1|\b\d[\w.]*|[A-Za-z_$][\w$]*/g;
const ALLOW_REGEX = /(?:\/\/|#)\s*clone(?:-coverage)?:allow\b/i;

/**
 * Нормализовать строку исходного кода:
 * удалить комментарии, свернуть множественные пробелы, убрать граничные пробелы.
 * Пустые строки и строки, состоящие только из комментариев, превращаются в "".
 */
export function normalizeLine(line) {
  if (typeof line !== "string") return "";
  const trimmed = line.trim();
  if (/^\/\*+/.test(trimmed) && !trimmed.includes("*/")) return "";
  if (/^\*\//.test(trimmed)) return "";
  if (/^\*(?:\s|$|\/|\*)/.test(trimmed)) return "";
  const stripped = line.replace(STRIP_COMMENT_RE, (match, _quote, comment) => {
    if (comment) return "";
    return match;
  });
  return stripped.trim().replace(/\s+/g, " ");
}

/**
 * Преобразовать строку в токен-слепую форму (Type-2):
 * строковые литералы -> $STR, числа -> $NUM, идентификаторы -> $ID.
 */
export function tokenBlindLine(str) {
  if (typeof str !== "string") return "";
  return str.replace(TOKEN_RE, (match, quote) => {
    if (quote) return "$STR";
    if (/^\d/.test(match)) return "$NUM";
    return "$ID";
  });
}

/**
 * Вычислить хэш строки или массива строк с заменой токенов (Type-2).
 */
export function tokenBlindHash(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines).split("\n");
  const blinded = arr.map((l) => tokenBlindLine(normalizeLine(l))).join("\n");
  return createHash("sha256").update(blinded).digest("hex").slice(0, 16);
}

function hashString(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Ключ базовой линии: отсортированный список вхождений "file:line".
 */
export function baselineKey(clone) {
  if (!clone || !Array.isArray(clone.occurrences)) return "";
  return clone.occurrences
    .map((o) => `${o.file}:${o.line}`)
    .sort()
    .join(",");
}

/**
 * Загрузить базовую линию клонов (.clone-baseline.json).
 */
export function loadCloneBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    return { version: 1, thresholds: { ...DEFAULT_THRESHOLDS }, clones: [] };
  }
  try {
    const raw = readFileSync(baselinePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? 1,
      thresholds: {
        minLines: typeof parsed.thresholds?.minLines === "number" ? parsed.thresholds.minLines : DEFAULT_THRESHOLDS.minLines,
        failLines: typeof parsed.thresholds?.failLines === "number" ? parsed.thresholds.failLines : DEFAULT_THRESHOLDS.failLines,
      },
      clones: Array.isArray(parsed.clones) ? parsed.clones : [],
    };
  } catch (err) {
    throw new Error(`Ошибка чтения baseline ${baselinePath}: ${err.message}`);
  }
}
export { loadCloneBaseline as loadBaseline };

/**
 * Рассчитать коэффициент покрытия клонами (ratio от 0.0 до 1.0).
 * Дублирующиеся строки накладывающихся клонов учитываются строго один раз.
 */
export function coverage(clones, totalLines) {
  if (!totalLines || totalLines <= 0 || !Array.isArray(clones) || clones.length === 0) return 0;
  const uniqueLines = new Set();
  for (const c of clones) {
    if (!c.occurrences || !c.lines) continue;
    for (const occ of c.occurrences) {
      for (let offset = 0; offset < c.lines; offset++) {
        uniqueLines.add(`${occ.file}:${occ.line + offset}`);
      }
    }
  }
  return uniqueLines.size / totalLines;
}

/**
 * Внутреннее сканирование с деталями (кэш нормализованных строк и статистика).
 */
export function scanClonesWithDetails(root, options = {}) {
  const minLines = options.minLines ?? options.thresholds?.minLines ?? DEFAULT_THRESHOLDS.minLines;
  const scope = options.scope || loadScope(root);
  const filesList = options.files || options.filesList || collectFiles(root, scope);

  const fileData = new Map();
  let totalLines = 0;

  for (const rel of filesList) {
    const full = resolve(root, rel);
    let raw;
    try {
      raw = readFileSync(full, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    } catch {
      continue;
    }
    const rawLines = raw.split("\n");
    totalLines += rawLines.length;
    const normLines = rawLines.map(normalizeLine);
    const blindLines = normLines.map(tokenBlindLine);
    fileData.set(rel, { rawLines, normLines, blindLines });
  }


  function scanPass(isT1) {
    const keyProp = isT1 ? "normLines" : "blindLines";
    return scanPairBlocks(fileData, keyProp, minLines, isT1);
  }

  const allPairBlocks = [...scanPass(true), ...scanPass(false)];
  allPairBlocks.sort((a, b) => b.len - a.len);

  const maximalPairBlocks = [];
  for (const b of allPairBlocks) {
    if (b.file1 === b.file2 && b.start1 + b.len > b.start2) continue;
    const subsumed = maximalPairBlocks.some((eb) => {
      if (b.kind === "T1" && eb.kind === "T2") return false;
      return (
        b.file1 === eb.file1 &&
        b.file2 === eb.file2 &&
        b.start1 >= eb.start1 &&
        b.start1 + b.len <= eb.start1 + eb.len &&
        b.start2 >= eb.start2 &&
        b.start2 + b.len <= eb.start2 + eb.len
      );
    });
    if (!subsumed) {
      maximalPairBlocks.push(b);
    }
  }

  const cloneMap = new Map();
  for (const b of maximalPairBlocks) {
    const mapKey = `${b.kind}:${b.hash}:${b.len}`;
    if (!cloneMap.has(mapKey)) {
      cloneMap.set(mapKey, { hash: b.hash, kind: b.kind, lines: b.len, occMap: new Map() });
    }
    const entry = cloneMap.get(mapKey);
    entry.occMap.set(`${b.file1}:${b.start1}`, { file: b.file1, line: b.start1 });
    entry.occMap.set(`${b.file2}:${b.start2}`, { file: b.file2, line: b.start2 });
  }

  const clones = Array.from(cloneMap.values()).map((c) => ({
    hash: c.hash,
    kind: c.kind,
    lines: c.lines,
    occurrences: Array.from(c.occMap.values()).sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line
    ),
  }));

  // Детерминированная сортировка: сначала по убыванию строк, затем по ключу вхождений
  clones.sort((a, b) => b.lines - a.lines || baselineKey(a).localeCompare(baselineKey(b)));

  return { clones, totalLines, fileData, filesList };
}

/**
 * Сканирование дубликатов кода.
 * @returns {Array<{ hash: string, kind: 'T1'|'T2', lines: number, occurrences: Array<{ file: string, line: number }> }>}
 */
export function scanClones(root, options = {}) {
  return scanClonesWithDetails(root, options).clones;
}

/** Индекс скользящих окон minLines: hash -> вхождения. */
function indexWindows(fileData, keyProp, minLines) {
  const winIndex = new Map();
  for (const [rel, data] of fileData) {
    const lines = data[keyProp];
    const norm = data.normLines;
    for (let i = 0; i <= lines.length - minLines; i++) {
      const wNorm = norm.slice(i, i + minLines);
      if (wNorm.every((l) => l === "")) continue; // игнорируем окна из пустых/комментариев
      const h = hashString(lines.slice(i, i + minLines).join("\n"));
      if (!winIndex.has(h)) winIndex.set(h, []);
      winIndex.get(h).push({ file: rel, lineIdx: i });
    }
  }
  return winIndex;
}

/** Упорядочить пару вхождений для детерминированного ключа. */
function orderPair(o1, o2) {
  return (o1.file < o2.file || (o1.file === o2.file && o1.lineIdx < o2.lineIdx)) ? [o1, o2] : [o2, o1];
}

/** Совпадают ли строки назад от позиции (с защитой от самопересечения в одном файле). */
function matchBackward(lines1, lines2, s1, s2, sameFile) {
  return s1 > 0 && s2 > 0 && lines1[s1 - 1] === lines2[s2 - 1] && (!sameFile || s1 - 1 !== s2 - 1);
}

/** Совпадают ли строки вперёд от позиции. */
function matchForward(lines1, lines2, s1, s2, len) {
  return s1 + len < lines1.length && s2 + len < lines2.length && lines1[s1 + len] === lines2[s2 + len];
}

/** Срезать пустые/комментарные строки с краёв блока. */
function trimBlankEdges(norm1, norm2, s1, s2, len) {
  while (len > 0 && (norm1[s1] === "" || norm2[s2] === "")) { s1++; s2++; len--; }
  while (len > 0 && (norm1[s1 + len - 1] === "" || norm2[s2 + len - 1] === "")) { len--; }
  return { s1, s2, len };
}

/** Расширить совпавшее окно до максимального блока; null если короче minLines или точный дубль в T2-проходе. */
function extendPairBlock(fileData, keyProp, minLines, first, second, isT1) {
  const lines1 = fileData.get(first.file)[keyProp];
  const lines2 = fileData.get(second.file)[keyProp];
  const norm1 = fileData.get(first.file).normLines;
  const norm2 = fileData.get(second.file).normLines;
  const sameFile = first.file === second.file;
  let s1 = first.lineIdx;
  let s2 = second.lineIdx;
  while (matchBackward(lines1, lines2, s1, s2, sameFile)) { s1--; s2--; }
  const fwd = extendForward(lines1, lines2, norm1, norm2, s1, s2, sameFile);
  const t = trimBlankEdges(norm1, norm2, s1, s2, fwd.len);
  if (t.len < minLines) return null;
  if (!isT1 && fwd.isExact) return null;
  const kind = isT1 ? "T1" : "T2";
  const blockText = (isT1 ? norm1 : lines1).slice(t.s1, t.s1 + t.len).join("\n");
  return { file1: first.file, start1: t.s1 + 1, file2: second.file, start2: t.s2 + 1, len: t.len, kind, hash: hashString(blockText) };
}

/** Расширение вперёд с флагом точного совпадения нормализованных строк. */
function extendForward(lines1, lines2, norm1, norm2, s1, s2, sameFile) {
  let len = 0;
  let isExact = true;
  while (matchForward(lines1, lines2, s1, s2, len)) {
    if (sameFile && s1 + len >= s2) break;
    if (norm1[s1 + len] !== norm2[s2 + len]) isExact = false;
    len++;
  }
  return { len, isExact };
}

/** Все попарные блоки одного прохода (T1 или T2). */
function scanPairBlocks(fileData, keyProp, minLines, isT1) {
  const winIndex = indexWindows(fileData, keyProp, minLines);
  const visited = new Set();
  const pairBlocks = [];
  for (const [, occs] of winIndex) {
    collectOccPairs(fileData, keyProp, minLines, isT1, occs, visited, pairBlocks);
  }
  return pairBlocks;
}

/** Пары одного хеша: расширить, пометить посещёнными, собрать блоки. */
function collectOccPairs(fileData, keyProp, minLines, isT1, occs, visited, pairBlocks) {
  if (occs.length < 2) return;
  for (let i = 0; i < occs.length; i++) {
    for (let j = i + 1; j < occs.length; j++) {
      tryOccPair(fileData, keyProp, minLines, isT1, occs[i], occs[j], visited, pairBlocks);
    }
  }
}

/** Одна пара вхождений: расширить в блок или пропустить. */
function tryOccPair(fileData, keyProp, minLines, isT1, a, b, visited, pairBlocks) {
  const [first, second] = orderPair(a, b);
  if (first.file === second.file && first.lineIdx === second.lineIdx) return;
  const pairKey = `${first.file}<=>${second.file}`;
  if (visited.has(`${pairKey}:${first.lineIdx}:${second.lineIdx}`)) return;
  const block = extendPairBlock(fileData, keyProp, minLines, first, second, isT1);
  if (!block) return;
  for (let k = 0; k <= block.len - minLines; k++) {
    visited.add(`${pairKey}:${block.start1 - 1 + k}:${block.start2 - 1 + k}`);
  }
  pairBlocks.push(block);
}

function checkExempt(clone, _root, fileData) {
  for (const occ of clone.occurrences) {
    const data = fileData.get(occ.file);
    if (!data) continue;
    const text = data.rawLines.slice(0, 50).join("\n");
    if (hasHeaderDeferMarker(text)) {
      return { exempt: true, reason: `defer marker in header (${occ.file})` };
    }
    const occLineIdx = occ.line - 1;
    const checkLines = [
      data.rawLines[occLineIdx - 1],
      data.rawLines[occLineIdx],
      data.rawLines[occLineIdx + 1],
    ];
    for (const cl of checkLines) {
      if (typeof cl === "string" && ALLOW_REGEX.test(cl)) {
        return { exempt: true, reason: `clone:allow comment (${occ.file}:${occ.line})` };
      }
    }
  }
  return { exempt: false, reason: "" };
}

/**
 * Построить baseline с зафиксированными клонами >= failLines.
 */
export function buildBaseline(root, options = {}) {
  const thresholds = resolveThresholds(options);
  const minLines = thresholds.minLines;
  const failLines = thresholds.failLines;

  const { clones } = scanClonesWithDetails(root, { ...options, minLines });
  const offenders = clones.filter((c) => c.lines >= failLines);
  offenders.sort((a, b) => baselineKey(a).localeCompare(baselineKey(b)));

  return {
    version: 1,
    thresholds,
    clones: offenders.map((c) => ({
      hash: c.hash,
      kind: c.kind,
      lines: c.lines,
      occurrences: c.occurrences,
    })),
  };
}

/**
 * Проверить дерево на дубликаты и дрейф относительно baseline.
 */
export function checkClones(root, options = {}) {
  const thresholds = resolveThresholds(options);
  const minLines = thresholds.minLines;
  const failLines = thresholds.failLines;

  const baselinePath = options.baselinePath || (options.baseline ? resolve(options.baseline) : join(root, DEFAULT_BASELINE_FILE));
  const baseline = options.baselineData || loadCloneBaseline(baselinePath);

  const baselineMap = new Map();
  for (const c of baseline.clones || []) {
    baselineMap.set(baselineKey(c), c);
  }

  const { clones, totalLines, fileData, filesList } = scanClonesWithDetails(root, { ...options, minLines });
  const ratio = coverage(clones, totalLines);

  const failures = [];
  const reportedClones = [];
  let exemptCount = 0;
  let baselinedCount = 0;

  for (const clone of clones) {
    const key = baselineKey(clone);
    const baselined = baselineMap.get(key);
    const isExempt = checkExempt(clone, root, fileData);

    let status = "ok";
    let failType = null;
    let diff = 0;

    if (clone.lines >= failLines) {
      if (isExempt.exempt) {
        status = "exempt";
        exemptCount++;
      } else if (baselined) {
        if (clone.lines > baselined.lines) {
          failType = "growth";
          diff = clone.lines - baselined.lines;
          status = "fail";
          failures.push({
            type: "clone_growth",
            clone,
            key,
            lines: clone.lines,
            baseLines: baselined.lines,
            diff,
            message: `Клон вырос сверх baseline: ${key} (${clone.lines} > baseline ${baselined.lines}, +${diff})`,
          });
        } else {
          status = "baselined";
          baselinedCount++;
        }
      } else {
        failType = "new";
        status = "fail";
        failures.push({
          type: "clone_new",
          clone,
          key,
          lines: clone.lines,
          threshold: failLines,
          message: `Новый клон превышает порог: ${key} (${clone.lines} >= failLines ${failLines})`,
        });
      }
    }

    reportedClones.push({
      ...clone,
      key,
      status,
      failType,
      diff,
      exempt: isExempt.exempt,
      reason: isExempt.reason || "",
      baseLines: baselined?.lines ?? null,
    });
  }

  return {
    ok: failures.length === 0,
    thresholds,
    coverage: ratio,
    stats: {
      scannedFiles: filesList.length,
      totalLines,
      clonesCount: clones.length,
      failures: failures.length,
      exempt: exemptCount,
      baselined: baselinedCount,
    },
    failures,
    clones: reportedClones,
  };
}


function printUsage() {
  console.log(`tools/clone-coverage.mjs — контроль дублирования кода (Type-1/Type-2 clone detector & ratchet gate)

Команды:
  check     Проверить дерево на дубликаты кода и дрейф от baseline (exit 1 при нарушении)
  baseline  Создать/обновить .clone-baseline.json с текущими нарушителями
  scan      Показать обнаруженные клоны без сверки с baseline

Опции: --root/-r <dir>, --baseline/-b <file>, --json, --help/-h
Escape-люки:
  defer: в первых 50 строках файла освобождает от проверок.
  // clone:allow на строке начала клона освобождает конкретный блок.
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const err of args.errors) console.error(`clone-coverage: ${err}`);
    printUsage();
    return 2;
  }
  if (args.help) { printUsage(); return 0; }
  const root = args.root ? resolve(args.root) : process.cwd();
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`clone-coverage: каталог --root '${root}' не существует`);
    return 2;
  }
  const baselinePath = args.baseline ? resolve(args.baseline) : join(root, DEFAULT_BASELINE_FILE);
  const command = args._[0];
  if (!command) { printUsage(); return 0; }
  if (command === "baseline") return runBaselineCommand(root, baselinePath, args);
  if (command === "check") return runCheckCommand(root, baselinePath, args);
  if (command === "scan") return runScanCommand(root, args);
  console.error(`clone-coverage: неизвестная команда '${command}'`);
  printUsage();
  return 2;
}

/** Команда baseline: зафиксировать текущих нарушителей. */
function runBaselineCommand(root, baselinePath, args) {
  try {
    const data = buildBaseline(root, { baselinePath });
    writeFileSync(baselinePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    const rel = relative(root, baselinePath).replace(/\\/g, "/") || baselinePath;
    if (args.json) console.log(JSON.stringify({ ok: true, baseline: rel, clones: data.clones.length }, null, 2));
    else console.log(`clone-coverage: baseline сохранён в ${rel} (зафиксировано нарушителей: ${data.clones.length}).`);
    return 0;
  } catch (err) {
    console.error(`clone-coverage: ошибка создания baseline: ${err.message}`);
    return 2;
  }
}

/** Команда check: сверка с baseline, печать нарушений. */
function runCheckCommand(root, baselinePath, args) {
  let result;
  try {
    result = checkClones(root, { baselinePath });
  } catch (err) {
    console.error(`clone-coverage: ${err.message}`);
    return 2;
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printCheckResult(result);
  return result.ok ? 0 : 1;
}

/** Человекочитаемая печать результата check. */
function printCheckResult(result) {
  for (const ex of result.clones.filter((x) => x.exempt)) {
    console.log(`  [EXEMPT] ${ex.key} (${ex.lines} строк) — ${ex.reason}`);
  }
  if (result.failures.length > 0) {
    console.error("clone-coverage: ОБНАРУЖЕНЫ НАРУШЕНИЯ ДУБЛИРОВАНИЯ КОДА\n");
    for (const f of result.failures) console.error(`  [FAIL] ${f.message}`);
    console.error(`\nclone-coverage: FAIL — ${result.failures.length} нарушений. Зафиксируйте \`baseline\` или устраните дублирование.`);
  } else {
    const exemptNotes = result.stats.exempt > 0 ? ` (${result.stats.exempt} exempt)` : "";
    console.log(
      `clone-coverage: PASS — нарушений нет${exemptNotes} (coverage: ${(result.coverage * 100).toFixed(1)}%). ` +
      `Проверено ${result.stats.scannedFiles} файлов, найдено ${result.stats.clonesCount} клонов.`
    );
  }
}

/** Команда scan: список клонов без сверки. */
function runScanCommand(root, args) {
  let details;
  try {
    details = scanClonesWithDetails(root);
  } catch (err) {
    console.error(`clone-coverage: ${err.message}`);
    return 2;
  }
  const ratio = coverage(details.clones, details.totalLines);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, clones: details.clones, coverage: ratio, totalLines: details.totalLines }, null, 2));
    return 0;
  }
  console.log(
    `clone-coverage: найдено ${details.clones.length} клонов ` +
    `(minLines: ${DEFAULT_THRESHOLDS.minLines}, failLines: ${DEFAULT_THRESHOLDS.failLines}, coverage: ${(ratio * 100).toFixed(1)}%):\n`
  );
  for (const c of details.clones) {
    console.log(`  [${c.kind}] ${c.lines} строк (hash: ${c.hash})`);
    for (const occ of c.occurrences) console.log(`      ${occ.file}:${occ.line}`);
  }
  return 0;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main();
}
