#!/usr/bin/env node
/**
 * Cache Doctor — tools/cache-doctor.mjs
 * 
 * Анализирует .jsonl сессии и объясняет наблюдаемые причины промахов промпт-кэша.
 * Никогда не мутирует модели, сессии или промпты.
 * Принцип: quality first, savings second.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseArgs as utilParseArgs } from 'node:util';

export const CAUSE_CODES = {
  MODEL_SWITCH: 'MODEL_SWITCH',
  FALLBACK: 'FALLBACK',
  COMPACTION: 'COMPACTION',
  PREFIX_DRIFT: 'PREFIX_DRIFT',
  ZERO_USAGE: 'ZERO_USAGE',
  COLD_BOOT: 'COLD_BOOT',
  UNKNOWN: 'UNKNOWN',
};

export const CAUSE_EXPLANATIONS_RU = {
  MODEL_SWITCH: 'Переключение модели между ходами',
  FALLBACK: 'Активирована резервная модель (fallback)',
  COMPACTION: 'Произошло сжатие контекста или саммари (compaction)',
  PREFIX_DRIFT: 'Изменился фингерпринт/префикс промпта (prefix drift)',
  ZERO_USAGE: 'Провайдер вернул нулевой usage или ошибку (zero usage)',
  COLD_BOOT: 'Первый ход на модели (холодный старт)',
  UNKNOWN: 'Неизвестная причина или необъяснимый холодный ход',
};

/**
 * Сравнивает слои двух фингерпринтов промпта.
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {{ drifted: boolean, changedLayers: string[], oldLayers: Record<string, string>, newLayers: Record<string, string> }}
 */
export function compareFingerprints(oldPath, newPath) {
  if (!oldPath || !newPath || !existsSync(oldPath) || !existsSync(newPath)) {
    return { drifted: false, changedLayers: [], oldLayers: {}, newLayers: {} };
  }

  try {
    const oldData = JSON.parse(readFileSync(oldPath, 'utf8'));
    const newData = JSON.parse(readFileSync(newPath, 'utf8'));

    const oldLayers = oldData.layers || oldData.surfaces || oldData;
    const newLayers = newData.layers || newData.surfaces || newData;

    const allKeys = Array.from(new Set([...Object.keys(oldLayers), ...Object.keys(newLayers)])).sort();
    const changedLayers = [];

    for (const key of allKeys) {
      if (key === 'version' || key === 'generatedAt') continue;
      if (oldLayers[key] !== newLayers[key]) {
        changedLayers.push(key);
      }
    }

    return {
      drifted: changedLayers.length > 0,
      changedLayers,
      oldLayers,
      newLayers,
    };
  } catch {
    return { drifted: false, changedLayers: [], oldLayers: {}, newLayers: {} };
  }
}

/**
 * Анализирует события в файле сессии .jsonl.
 * @param {string} filePath
 * @param {{ fingerprintComparison?: { drifted: boolean, changedLayers: string[] } }} [options]
 * @returns {object} Результат анализа сессии
 */
export function analyzeSessionFile(filePath, options = {}) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let currentModel = null;
  let isFallback = false;
  let modelSwitched = false;
  let compactionOccurred = false;
  const warmModelSet = new Set();

  let turnCounter = 0;
  let warmTurns = 0;
  let coldTurns = 0;
  let zeroUsageTurns = 0;

  const diagnoses = [];
  const causesSummary = {
    [CAUSE_CODES.MODEL_SWITCH]: 0,
    [CAUSE_CODES.FALLBACK]: 0,
    [CAUSE_CODES.COMPACTION]: 0,
    [CAUSE_CODES.PREFIX_DRIFT]: 0,
    [CAUSE_CODES.ZERO_USAGE]: 0,
    [CAUSE_CODES.COLD_BOOT]: 0,
    [CAUSE_CODES.UNKNOWN]: 0,
  };

  const fingerprintDrifted = Boolean(options.fingerprintComparison?.drifted);
  const changedLayers = options.fingerprintComparison?.changedLayers || [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event || typeof event !== 'object') continue;

    const eventType = event.type;

    // 1. Модели и переключения
    if (eventType === 'model_change') {
      const rawModel = event.model || event.to;
      const prov = event.provider;
      const fullModel = prov && rawModel && !rawModel.includes('/') ? `${prov}/${rawModel}` : rawModel;

      if (event.resolvedModelIsFallback || event.isFallback || event.fallback) {
        isFallback = true;
      }

      if (currentModel !== null && fullModel && fullModel !== currentModel) {
        modelSwitched = true;
      }

      if (fullModel) {
        currentModel = fullModel;
      }
      continue;
    }

    if (eventType === 'fallback') {
      isFallback = true;
      if (event.model && currentModel !== null && event.model !== currentModel) {
        modelSwitched = true;
        currentModel = event.model;
      }
      continue;
    }

    // 2. События сжатия контекста / саммари
    if (
      eventType === 'compaction' ||
      eventType === 'summary' ||
      eventType === 'context_compaction' ||
      event.customType === 'compaction' ||
      event.customType === 'summary' ||
      (eventType === 'custom' && (event.customType === 'compaction' || event.customType === 'summary'))
    ) {
      compactionOccurred = true;
      continue;
    }

    // 3. Сообщения ассистента
    if (eventType === 'message') {
      const msg = event.message;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'assistant') continue;

      turnCounter++;

      const prov = msg.provider || event.provider || 'unknown';
      const rawModel = msg.model || event.model || currentModel || 'unknown';
      const fullModel = prov !== 'unknown' && !rawModel.includes('/') ? `${prov}/${rawModel}` : rawModel;

      if (currentModel === null) {
        currentModel = fullModel;
      } else if (fullModel !== currentModel && !fullModel.includes('unknown')) {
        modelSwitched = true;
        currentModel = fullModel;
      }

      if (msg.resolvedModelIsFallback || msg.isFallback || msg.fallback) {
        isFallback = true;
      }

      const usage = msg.usage;
      if (!usage || typeof usage !== 'object') continue;

      // ПРАВИЛО: Не сообщать о промахах для провайдеров, которые не декларируют кэш-поля!
      const hasCacheSupport =
        'cacheRead' in usage ||
        'cacheWrite' in usage ||
        'prompt_cache_hit_tokens' in usage ||
        'cached_tokens' in usage;

      if (!hasCacheSupport) {
        continue;
      }

      const cacheRead = Number(usage.cacheRead ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0);
      const input = Number(usage.input ?? 0);
      const output = Number(usage.output ?? 0);
      const isError = msg.stopReason === 'error' || Boolean(msg.errorStatus) || Boolean(event.error);

      if (input === 0 && output === 0 && cacheRead === 0) {
        zeroUsageTurns++;
      } else if (cacheRead > 0) {
        warmTurns++;
        warmModelSet.add(fullModel);
        // Сброс триггеров после успешного теплого попадания
        isFallback = false;
        modelSwitched = false;
        compactionOccurred = false;
        continue; // Теплый ход — не промах
      } else if (input > 0 && cacheRead === 0) {
        coldTurns++;
      }

      // Диагностика причины промаха
      let cause = CAUSE_CODES.UNKNOWN;
      let detail = CAUSE_EXPLANATIONS_RU[CAUSE_CODES.UNKNOWN];

      if ((input === 0 && output === 0 && cacheRead === 0) || isError) {
        cause = CAUSE_CODES.ZERO_USAGE;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}${msg.stopReason ? ` (stopReason: ${msg.stopReason})` : ''}`;
      } else if (isFallback) {
        cause = CAUSE_CODES.FALLBACK;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}: модель ${fullModel}`;
        isFallback = false;
      } else if (modelSwitched) {
        cause = CAUSE_CODES.MODEL_SWITCH;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}: переключено на ${fullModel}`;
        modelSwitched = false;
      } else if (compactionOccurred) {
        cause = CAUSE_CODES.COMPACTION;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}`;
        compactionOccurred = false;
      } else if (fingerprintDrifted) {
        cause = CAUSE_CODES.PREFIX_DRIFT;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]} (слои: ${changedLayers.join(', ')})`;
      } else if (!warmModelSet.has(fullModel)) {
        cause = CAUSE_CODES.COLD_BOOT;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}: ${fullModel}`;
      } else {
        cause = CAUSE_CODES.UNKNOWN;
        detail = `${CAUSE_EXPLANATIONS_RU[cause]}: холодный ход после прогретого кэша`;
      }

      causesSummary[cause]++;
      diagnoses.push({
        turn: turnCounter,
        model: fullModel,
        cause,
        explanation: detail,
        usage: {
          input,
          output,
          cacheRead,
        },
      });
    }
  }

  return {
    file: filePath,
    totalTurns: turnCounter,
    warmTurns,
    coldTurns,
    zeroUsageTurns,
    diagnoses,
    causesSummary,
  };
}

/**
 * Форматирует отчет в текстовом виде на русском языке (RU text).
 * @param {object[]} sessionResults
 * @param {object} [fingerprintComparison]
 * @returns {string}
 */
export function formatRuReport(sessionResults, fingerprintComparison) {
  const lines = [];
  lines.push('=== Cache Doctor: Отчет о промахах кэша ===');

  if (fingerprintComparison && fingerprintComparison.drifted) {
    lines.push('');
    lines.push('[Сравнение фингерпринтов]:');
    lines.push('  Дрейф префикса обнаружен: ДА');
    lines.push(`  Изменившиеся слои: ${fingerprintComparison.changedLayers.join(', ')}`);
  } else if (fingerprintComparison) {
    lines.push('');
    lines.push('[Сравнение фингерпринтов]:');
    lines.push('  Дрейф префикса не обнаружен (слои идентичны).');
  }

  for (const session of sessionResults) {
    lines.push('');
    lines.push(`Сессия: ${session.file}`);
    lines.push(
      `  Всего ходов: ${session.totalTurns} (Тёплых: ${session.warmTurns}, Холодных: ${session.coldTurns}, Нулевых/ошибочных: ${session.zeroUsageTurns})`
    );

    if (session.diagnoses.length === 0) {
      lines.push('  Промахов кэша не обнаружено (все ходы прогреты или провайдер без кэширования).');
    } else {
      lines.push('  Диагностика промахов:');
      for (const diag of session.diagnoses) {
        lines.push(
          `    Ход #${diag.turn} [${diag.model}] ${diag.cause}: ${diag.explanation} (in=${diag.usage.input}, cr=${diag.usage.cacheRead})`
        );
      }
      lines.push('  Сводка по причинам:');
      for (const [code, count] of Object.entries(session.causesSummary)) {
        if (count > 0) {
          lines.push(`    ${code}: ${count}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Точка входа CLI
 */
export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = utilParseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      fingerprint: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || (positionals.length === 0 && !values.fingerprint)) {
    console.log(`Cache Doctor — инструменты наблюдаемости нейросетевого кэша

Использование:
  node tools/cache-doctor.mjs [--fingerprint old.json,new.json] [--json] <session.jsonl...>

Параметры:
  --fingerprint old,new   Сравнить два фингерпринта промпта и учесть дрейф префикса
  --json                  Вывести результат в формате JSON
  -h, --help              Показать эту справку
`);
    process.exit(0);
  }

  const asJson = values.json;
  const fingerprintArg = values.fingerprint || null;
  const files = positionals;
  let fingerprintComparison = null;
  if (fingerprintArg) {
    const [oldPath, newPath] = fingerprintArg.split(',');
    if (oldPath && newPath) {
      fingerprintComparison = compareFingerprints(resolve(oldPath), resolve(newPath));
    }
  }

  const sessionResults = [];
  for (const file of files) {
    const resolvedPath = resolve(file);
    if (!existsSync(resolvedPath)) {
      console.error(`Файл не найден: ${file}`);
      continue;
    }
    const res = analyzeSessionFile(resolvedPath, { fingerprintComparison });
    sessionResults.push(res);
  }

  if (asJson) {
    const output = {
      sessions: sessionResults,
      fingerprintComparison: fingerprintComparison || { drifted: false, changedLayers: [] },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatRuReport(sessionResults, fingerprintComparison));
  }
}

// Запуск при прямом вызове
if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main();
}
