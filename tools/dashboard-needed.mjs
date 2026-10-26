#!/usr/bin/env node
/**
 * tools/dashboard-needed.mjs — «что человеку осталось сделать самому» и разбор слепой
 * приёмки. Два независимых чтения одного рода: содержимое проекта глазами человека,
 * который его получил.
 *
 * Почему отдельным модулем: оба читают файлы, которых нет у остальных коллекторов
 * (`.env.example`, маркеры-заглушки, `oracle.md`), и вместе они утяжеляли
 * `dashboard-collectors` сверх его потолка без всякой связи с остальной сборкой.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./brief.mjs";

/** Файлы, где перечислены имена переменных без значений. */
const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template", "secrets.example.env"];

/**
 * Маркеры-заглушки.
 *
 * Регистр у PLACEHOLDER/CHANGEME значим намеренно: без него метка совпадает со
 * строковыми литералами вида "placeholder" (имя статуса в наших же таблицах), и
 * панель заполняется находками о самом дашборде. TODO:/FIXME: — наоборот, встречаются
 * в обоих регистрах.
 */
// Границы слова здесь не годятся: `_` — тоже граница, поэтому `\b` не находил
// `PLACEHOLDER_TOKEN`, а это самый частый вид заглушки в коде.
const PLACEHOLDER_RE = /(?:^|[^A-Z])(?:PLACEHOLDER|CHANGEME|YOUR_TOKEN_HERE)|(?:TODO|FIXME):/;

/** Строка шаблона → имя переменной. Значение не читается вообще. */
function envNameOf(line) {
  const m = String(line).match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/);
  return m ? m[1] : null;
}

/** Служебные каталоги и скрытые файлы не сканируются. */
function skipEntry(name) {
  return name === "node_modules" || name === ".git" || name.startsWith(".");
}

/** Тестовые каталоги: фикстуры не выдаются за работу человека. */
function isTestDir(name) {
  return name === "tests" || name === "__tests__";
}

/** stat без исключения: нечитаемая запись — не повод падать. */
function statOf(path) {
  try { return statSync(path); } catch { return null; }
}

/** Прочитать файл и дописать найденные строки; нечитаемый файл молча пропускается. */
function readInto(rootAbs, full, out, limit) {
  let text = "";
  try { text = readFileSync(full, "utf8"); } catch { return; }
  collectFromFile(rootAbs, full, text, out, limit);
}

/** Обход дерева в пределах одного модуля: возвращает строки с заглушками. */
function scanDir(rootAbs, dir, selfPath, out, limit) {
  const base = join(rootAbs, dir);
  if (!existsSync(base)) return;
  const walk = (d) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      visit(join(d, e), e);
    }
  };
  /** Один элемент дерева: каталог продолжается, файл читается, остальное пропускается. */
  const visit = (full, name) => {
    if (skipEntry(name)) return;
    const st = statOf(full);
    if (!st) return;
    if (st.isDirectory()) {
      // Тесты — фикстуры, а не продукт: `TODO:` в тесте проверяет сам детектор, и
      // показывать его как «нужны твои данные» значит учить человека игнорировать панель.
      if (!isTestDir(name)) walk(full);
      return;
    }
    if (st.size > 200_000 || full === selfPath) return;
    readInto(rootAbs, full, out, limit);
  };
  walk(base);
}

/** Строки одного файла, совпавшие с маркером. */
function collectFromFile(rootAbs, full, text, out, limit) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    if (!PLACEHOLDER_RE.test(lines[i])) continue;
    out.push({
      file: relative(rootAbs, full).replace(/\\/g, "/"),
      line: i + 1,
      text: redactSecrets(lines[i].trim()).slice(0, 120),
    });
  }
}

/**
 * Что человеку осталось сделать самому.
 *
 * Ключи — только ИМЕНА: значение не попадает в результат даже если шаблон заполнен
 * по-настоящему. Заглушки и допущения — с координатой, чтобы их можно было найти.
 */
/** Имена переменных из шаблонов: значения не читаются вообще. */
function readEnvKeys(rootAbs) {
  const envKeys = [];
  for (const name of ENV_TEMPLATES) {
    const p = join(rootAbs, name);
    if (!existsSync(p)) continue;
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const key = envNameOf(line);
      if (key && !envKeys.includes(key)) envKeys.push(key);
    }
  }
  return envKeys.slice(0, 40);
}

/** Допущения из манифеста: строки, где статус говорит assum*. */
function readAssumptions(manifestPath) {
  if (!manifestPath || !existsSync(manifestPath)) return [];
  const out = [];
  let text = "";
  try { text = readFileSync(manifestPath, "utf8"); } catch { return []; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\|\s*(R\d+[a-z]?)\s*\|\s*([^|]+)\|(.*)$/i);
    if (!m || !/assum/i.test(m[3])) continue;
    out.push(`${m[1].trim()} — ${m[2].trim().replace(/^["«]|["»]$/g, "").slice(0, 140)}`);
  }
  return out.slice(0, 20);
}

/**
 * Что человеку осталось сделать самому: ключи, заглушки, допущения.
 *
 * Три независимых чтения, поэтому и три помощника выше: вместе они давали функцию
 * сложнее порога, а порознь каждый читается за один взгляд.
 */
export function collectNeeded(absRoot, { manifestPath = null, limit = 40 } = {}) {
  const rootAbs = resolve(absRoot);
  const selfPath = fileURLToPath(import.meta.url);
  const placeholders = [];
  for (const dir of ["src", "lib", "app", "tools", "agent", "core"]) {
    scanDir(rootAbs, dir, selfPath, placeholders, limit);
    if (placeholders.length >= limit) break;
  }
  return {
    envKeys: readEnvKeys(rootAbs),
    placeholders,
    assumptions: readAssumptions(manifestPath),
  };
}

/** Каталог изменения: явный, иначе самый свежий в openspec/changes. */
function changeDir(absRoot, change) {
  if (change) return join(absRoot, "openspec", "changes", change);
  const changesDir = join(absRoot, "openspec", "changes");
  if (!existsSync(changesDir)) return null;
  try {
    const dirs = readdirSync(changesDir)
      .filter((d) => d !== "archive" && statSync(join(changesDir, d)).isDirectory())
      .map((d) => ({ d, at: statSync(join(changesDir, d)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return dirs.length ? join(changesDir, dirs[0].d) : null;
  } catch {
    return null;
  }
}

/** Файл вердикта: `oracle*.md` или `acceptance.md`. */
function verdictFile(dir) {
  try {
    return readdirSync(dir).find((f) => /^(oracle(-+[a-z0-9]+)*|acceptance)\.md$/i.test(f)) || null;
  } catch {
    return null;
  }
}

/**
 * Разбор вердикта оракула: сколько требований проверено, сколько подтверждено, где
 * разошлось.
 *
 * `null` означает «приёмки ещё не было» — карточка тогда не рисуется, вместо пустой
 * рамки. Строки-заголовки таблицы не считаются: иначе `checked` раздувается.
 */
export function collectBlind(absRoot, change = null) {
  const dir = changeDir(absRoot, change);
  if (!dir || !existsSync(dir)) return null;
  const file = verdictFile(dir);
  if (!file) return null;

  let text = "";
  try { text = readFileSync(join(dir, file), "utf8"); } catch { return null; }

  let checked = 0;
  let matched = 0;
  const disagreements = [];
  for (const line of text.split("\n")) {
    const row = line.match(/^\s*\|\s*([RGD]\d+[a-z]?)\s*\|([^|]*)\|[^|]*\|([^|]*)\|/i);
    if (!row) continue;
    const cell = `${row[2]} ${row[3]}`.toLowerCase();
    // `partial|missing|proven` — основы, а не целые слова: оракулы пишут "partially",
    // "missing" и "proven", и граница слова отбрасывала первую форму молча.
    if (!/(proven|partial|missing)/.test(cell)) continue;
    checked += 1;
    if (/proven/.test(cell) && !/(partial|missing)/.test(cell)) {
      matched += 1;
      continue;
    }
    const why = (row[3] || "").trim().replace(/\s+/g, " ").slice(0, 120) || "не подтверждено";
    disagreements.push(`${row[1].trim()} — ${why}`);
  }
  if (checked === 0) return null;
  return { checked, matched, disagreements, source: `${change || basename(dir)}/${file}` };
}

/**
 * Возраст кэша автопроверок.
 *
 * Кэш без `generatedAt` считается устаревшим, а не свежим: «зелёное» без даты — это
 * ровно та тишина, из-за которой плитка показывала ok при проверках 33-дневной давности.
 */
export function checksAge(checks) {
  const at = checks?.generatedAt;
  if (!at) return { days: null, stale: Boolean(checks) };
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return { days: null, stale: true };
  const days = Math.floor(ms / 86400000);
  return { days, stale: days > 1 };
}

/* ------------------------------------------------------------------ */
/*  Состояние прогона                                                  */
/* ------------------------------------------------------------------ */

/**
 * Состояние прогона: открытое ожидание — собственное состояние, а не «open».
 * Без этого герой никогда не станет оранжевым, хотя часы уже стоят.
 */
export function runStatusOf(state) {
  if (state.status === "open" && state.waiting?.from) return "waiting";
  return state.status || "open";
}

/** Манифест прогона: явный артефакт, иначе манифест его изменения. */
function manifestOf(absRoot, artifacts, changeId, joinPath) {
  if (artifacts.manifest?.path) return joinPath(absRoot, artifacts.manifest.path);
  if (changeId) return joinPath(absRoot, "openspec", "changes", changeId, "manifest.md");
  return null;
}

/**
 * Прогон плюс то, что осталось человеку.
 *
 * `cached` и `collectRunState` передаются снаружи: модуль остаётся чистым чтением
 * файлов и не заводит собственный кэш, который пришлось бы инвалидировать отдельно.
 */
export function collectHumanGap(absRoot, artifacts, { cached, collectRunState, join: joinPath }) {
  const runRef = cached(`run:${absRoot}`, 1000, () => collectRunState(absRoot, null));
  const changeId = runRef?.change || null;
  const manifestPath = manifestOf(absRoot, artifacts, changeId, joinPath);
  return {
    runRef,
    needed: cached(`needed:${absRoot}`, 30000, () => collectNeeded(absRoot, { manifestPath })),
    blind: cached(`blind:${absRoot}`, 30000, () => collectBlind(absRoot, changeId)),
  };
}
