import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeSessionFile,
  compareFingerprints,
  formatRuReport,
  CAUSE_CODES,
  CAUSE_EXPLANATIONS_RU,
} from '../cache-doctor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, 'fixtures', 'cache');

describe('Cache Doctor Core Analysis', () => {
  it('identifies COLD_BOOT and warm hits on warm-cold.jsonl', () => {
    const file = resolve(FIXTURES_DIR, 'warm-cold.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 3);
    assert.equal(result.warmTurns, 2);
    assert.equal(result.coldTurns, 1);
    assert.equal(result.zeroUsageTurns, 0);

    // Turn 1 is COLD_BOOT
    assert.equal(result.diagnoses.length, 1);
    assert.equal(result.diagnoses[0].turn, 1);
    assert.equal(result.diagnoses[0].cause, CAUSE_CODES.COLD_BOOT);
    assert.match(result.diagnoses[0].explanation, /холодный старт/);
    assert.equal(result.causesSummary[CAUSE_CODES.COLD_BOOT], 1);
  });

  it('identifies MODEL_SWITCH cause code on model-switch.jsonl', () => {
    const file = resolve(FIXTURES_DIR, 'model-switch.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 3);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.coldTurns, 2);

    // Diagnoses: Turn 1 is COLD_BOOT, Turn 3 is MODEL_SWITCH
    const causes = result.diagnoses.map((d) => d.cause);
    assert.deepEqual(causes, [CAUSE_CODES.COLD_BOOT, CAUSE_CODES.MODEL_SWITCH]);
    assert.equal(result.causesSummary[CAUSE_CODES.MODEL_SWITCH], 1);
  });

  it('identifies FALLBACK cause code on fallback.jsonl', () => {
    const file = resolve(FIXTURES_DIR, 'fallback.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 2);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.coldTurns, 1);

    const fallbackDiag = result.diagnoses.find((d) => d.cause === CAUSE_CODES.FALLBACK);
    assert.ok(fallbackDiag, 'Expected FALLBACK cause code');
    assert.equal(fallbackDiag.turn, 2);
    assert.match(fallbackDiag.explanation, /fallback/);
    assert.equal(result.causesSummary[CAUSE_CODES.FALLBACK], 1);
  });

  it('identifies UNKNOWN cause code on unexplained cold turn (unknown.jsonl)', () => {
    const file = resolve(FIXTURES_DIR, 'unknown.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 2);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.coldTurns, 1);

    const unknownDiag = result.diagnoses.find((d) => d.cause === CAUSE_CODES.UNKNOWN);
    assert.ok(unknownDiag, 'Expected UNKNOWN cause code');
    assert.equal(unknownDiag.turn, 2);
    assert.match(unknownDiag.explanation, /Неизвестная причина|холодный ход/);
    assert.equal(result.causesSummary[CAUSE_CODES.UNKNOWN], 1);
  });

  it('identifies ZERO_USAGE error on zero-usage-error.jsonl', () => {
    const file = resolve(FIXTURES_DIR, 'zero-usage-error.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 2);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.zeroUsageTurns, 1);

    const zeroDiag = result.diagnoses.find((d) => d.cause === CAUSE_CODES.ZERO_USAGE);
    assert.ok(zeroDiag, 'Expected ZERO_USAGE cause code');
    assert.equal(zeroDiag.turn, 2);
    assert.match(zeroDiag.explanation, /нулевой usage или ошибку/);
    assert.equal(result.causesSummary[CAUSE_CODES.ZERO_USAGE], 1);
  });

  it('identifies COMPACTION on explicit compaction custom event (compaction.jsonl)', () => {
    const file = resolve(FIXTURES_DIR, 'compaction.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.totalTurns, 2);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.coldTurns, 1);

    const compDiag = result.diagnoses.find((d) => d.cause === CAUSE_CODES.COMPACTION);
    assert.ok(compDiag, 'Expected COMPACTION cause code');
    assert.equal(compDiag.turn, 2);
    assert.match(compDiag.explanation, /сжатие контекста/);
    assert.equal(result.causesSummary[CAUSE_CODES.COMPACTION], 1);
  });

  it('identifies PREFIX_DRIFT when fingerprint comparison reveals layer changes', () => {
    const oldPath = resolve(FIXTURES_DIR, 'fingerprint-old.json');
    const newPath = resolve(FIXTURES_DIR, 'fingerprint-new.json');
    const fpResult = compareFingerprints(oldPath, newPath);

    assert.equal(fpResult.drifted, true);
    assert.deepEqual(fpResult.changedLayers, ['combined', 'rules']);

    const file = resolve(FIXTURES_DIR, 'fingerprint-change.jsonl');
    const result = analyzeSessionFile(file, { fingerprintComparison: fpResult });

    assert.equal(result.totalTurns, 2);
    assert.equal(result.warmTurns, 1);
    assert.equal(result.coldTurns, 1);

    const driftDiag = result.diagnoses.find((d) => d.cause === CAUSE_CODES.PREFIX_DRIFT);
    assert.ok(driftDiag, 'Expected PREFIX_DRIFT cause code');
    assert.equal(driftDiag.turn, 2);
    assert.match(driftDiag.explanation, /фингерпринт/);
    assert.equal(result.causesSummary[CAUSE_CODES.PREFIX_DRIFT], 1);
  });

  it('does NOT report false misses for providers that do not declare cache fields (no-cache-provider.jsonl)', () => {
    const file = resolve(FIXTURES_DIR, 'no-cache-provider.jsonl');
    const result = analyzeSessionFile(file);

    assert.equal(result.diagnoses.length, 0);
    assert.equal(result.coldTurns, 0);
    assert.equal(result.warmTurns, 0);
    assert.equal(result.causesSummary[CAUSE_CODES.COLD_BOOT], 0);
    assert.equal(result.causesSummary[CAUSE_CODES.UNKNOWN], 0);
  });
});

describe('Cache Doctor Reporting Formats', () => {
  it('formats human-readable RU text report', () => {
    const file = resolve(FIXTURES_DIR, 'model-switch.jsonl');
    const sessionRes = analyzeSessionFile(file);
    const textReport = formatRuReport([sessionRes], { drifted: false, changedLayers: [] });

    assert.match(textReport, /Cache Doctor: Отчет о промахах кэша/);
    assert.match(textReport, /Сессия:/);
    assert.match(textReport, /Всего ходов: 3/);
    assert.match(textReport, /MODEL_SWITCH/);
    assert.match(textReport, /COLD_BOOT/);
  });

  it('produces deterministic output across multiple invocations', () => {
    const file = resolve(FIXTURES_DIR, 'compaction.jsonl');
    const res1 = JSON.stringify(analyzeSessionFile(file));
    const res2 = JSON.stringify(analyzeSessionFile(file));
    assert.equal(res1, res2);
  });
});
