#!/usr/bin/env node
/**
 * tools/session-log.mjs — единое чтение JSONL-журналов (events/metrics/sessions).
 * Заменяет 4+ дублирующихся цикла (dashboard, measure-session, cache-doctor-стиль).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Безопасный парсинг одного JSON-документа; null при ошибке. */
export function parseJsonSafe(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Чтение JSONL-файла в массив записей; битые строки пропускаются. */
export function readJsonlSafe(filePath, limit = 0) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const records = [];
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parsed = parseJsonSafe(t);
      if (parsed) records.push(parsed);
    }
    return limit > 0 ? records.slice(-limit) : records;
  } catch {
    return [];
  }
}

/** Первый существующий путь из кандидатов (для metrics/events в корне или .workflow/). */
export function resolveLogFile(rootDir, subPaths) {
  for (const sub of subPaths || []) {
    const p = join(rootDir, sub);
    if (existsSync(p)) return p;
  }
  return null;
}
