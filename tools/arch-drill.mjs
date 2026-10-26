#!/usr/bin/env node
/**
 * tools/arch-drill.mjs — уровни погружения архитектурной карты: символы файла и
 * дерево проект → модуль → файл → символ.
 *
 * Почему отдельный модуль: это единственное место, которое читает исходники ради
 * карты, и оно обязано оставаться терпимым к мусору — неразобранный файл не имеет
 * права уронить дашборд. Сканер берётся из гейта размера (`code-size.mjs`), чтобы
 * карта и гейт не расходились в том, что считать функцией.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanFile } from "./code-size.mjs";

/** Расширения, которые не считаем исходником: шрифты, медиа, архивы, замки. */
const BINARY_EXT = /\.(ttf|otf|woff2?|eot|png|jpe?g|gif|webp|svgz?|ico|bmp|mp[34]|wav|ogg|pdf|zip|gz|tar|7z|rar|xz|exe|dll|so|dylib|bin|wasm|db|sqlite3?|lock)$/i;

/** Один предикат «это не исходник» на весь дашборд: список расширений не двоится. */
export const isBinaryName = (name) => BINARY_EXT.test(name);

/** Сколько раз каждый объявленный символ зовёт соседей по файлу. */
function countSiblingCalls(text, names, self, startLine, endLine) {
  if (!startLine || endLine < startLine) return 0;
  const body = text.split("\n").slice(startLine - 1, endLine).join("\n");
  let total = 0;
  for (const other of names) {
    if (other === self) continue;
    const escaped = other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hits = body.match(new RegExp(`\\b${escaped}\\s*\\(`, "g"));
    if (hits) total += hits.length;
  }
  return total;
}

/**
 * Символы одного файла.
 *
 * Никогда не бросает: нечитаемый или неразбираемый файл даёт пустой список. Это не
 * граф вызовов — `internalCalls` считает только одноимённые вызовы соседей по файлу,
 * поэтому в подписи стоит «↻», а не «вызывает N».
 */
export function collectSymbolInventory(absRoot, relPath, { max = 40 } = {}) {
  const out = { path: String(relPath || "").replace(/\\/g, "/"), lines: 0, truncated: false, symbols: [] };
  if (!out.path) return out;
  let scanned;
  try {
    scanned = scanFile(absRoot, out.path);
  } catch {
    return out;
  }
  out.lines = Number(scanned.lines) || 0;
  const all = Array.isArray(scanned.functions) ? scanned.functions : [];
  out.truncated = all.length > max;
  if (!all.length) return out;

  let text = "";
  try {
    text = readFileSync(join(absRoot, out.path), "utf8");
  } catch {
    text = "";
  }
  const declared = all.slice(0, max);
  const names = declared.map((fn) => String(fn.name || "anonymous"));
  out.symbols = declared.map((fn) => {
    const name = String(fn.name || "anonymous");
    const startLine = Number(fn.startLine) || 0;
    const endLine = Number(fn.endLine) || 0;
    return {
      name,
      kind: "function",
      startLine,
      endLine,
      lines: Number(fn.lines) || 0,
      internalCalls: countSiblingCalls(text, names, name, startLine, endLine),
    };
  });
  return out;
}

/**
 * Дерево для карты: проект → модули → файлы → символы.
 *
 * Считает по тем же `modules`, что и «Схема», поэтому число файлов в двух видах не
 * может разойтись. Файлы сортируются по убыванию строк; двойная обрезка (в модуле
 * уже не больше 12 файлов, карта добавляет свой предел) отражается флагом `truncated`,
 * а не тишиной.
 */
export function collectArchDrill(absRoot, modules, { maxFiles = 40 } = {}) {
  const list = Array.isArray(modules) ? modules : [];
  const mods = list.map((m) => {
    const files = (m.files || [])
      .filter((f) => f && f.name && !isBinaryName(f.name))
      .slice()
      .sort((a, b) => (Number(b.lines) || 0) - (Number(a.lines) || 0));
    const shown = files.slice(0, maxFiles);
    return {
      name: String(m.name || m.path || ""),
      files: Number(m.fileCount) || 0,
      lines: Number(m.totalLines) || 0,
      truncated: files.length > shown.length || (Number(m.fileCount) || 0) > files.length,
      children: shown.map((f) => {
        const inv = collectSymbolInventory(absRoot, f.name);
        if (!inv.lines) inv.lines = Number(f.lines) || 0;
        return inv;
      }),
    };
  });
  return {
    name: resolve(absRoot).split(/[\\/]/).pop() || "project",
    files: mods.reduce((s, m) => s + m.files, 0),
    lines: mods.reduce((s, m) => s + m.lines, 0),
    modules: mods,
  };
}
