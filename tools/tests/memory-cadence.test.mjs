/**
 * tools/tests/memory-cadence.test.mjs — Тесты для memory-cadence.mjs
 *
 * Проверяет:
 *   - loadConfig (валидный, отсутствующий, с комментариями и кавычками, JSON формат)
 *   - checkCadenceStatus (без ревизии -> isOverdue: true, свежая -> isOverdue: false, просроченная -> isOverdue: true)
 *   - recordCadenceReview (сохранение записи, обновление lastReview, история, повторный check)
 *   - CLI: --check при отсутствии ревизии (exit 1), после --record (exit 0)
 *   - CLI: --json вывод и структура данных
 *   - CLI: --help справка
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadConfig,
  loadCadenceState,
  recordCadenceReview,
  checkCadenceStatus,
  formatCadenceReport,
  parseArgs,
} from "../memory-cadence.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../memory-cadence.mjs", import.meta.url)));
import { createTempDir } from "./test-helpers.mjs";


test("loadConfig: отсутствующий config.yml возвращает fallback-структуру без исключений", () => {
  const tmp = createTempDir();
  try {
    const missingPath = join(tmp, "nonexistent-config.yml");
    const cfg = loadConfig(missingPath);

    assert.equal(cfg.exists, false);
    assert.equal(cfg.path, missingPath);
    assert.deepEqual(cfg.hindsight, {
      apiUrl: null,
      bankId: null,
      apiToken: null,
    });
    assert.deepEqual(cfg.memory, {
      backend: null,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: валидный config.yml извлекает hindsight и memory.backend", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const yamlContent = [
      "providers:",
      "  streamTimeout: 120",
      "memory:",
      '  backend: "off"',
      "hindsight:",
      "  bankId: main # default bank",
      "  apiToken: 'hs_sec_12345'",
      "  apiUrl: https://memory.test.local/mcp/",
    ].join("\n");

    writeFileSync(configPath, yamlContent, "utf8");
    const cfg = loadConfig(configPath);

    assert.equal(cfg.exists, true);
    assert.equal(cfg.memory.backend, "off");
    assert.equal(cfg.hindsight.bankId, "main");
    assert.equal(cfg.hindsight.apiToken, "hs_sec_12345");
    assert.equal(cfg.hindsight.apiUrl, "https://memory.test.local/mcp/");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: поддерживает конфиг в формате JSON", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.json");
    const jsonContent = JSON.stringify({
      memory: { backend: "sqlite" },
      hindsight: {
        apiUrl: "https://hindsight.internal/api",
        bankId: "work-bank",
      },
    });

    writeFileSync(configPath, jsonContent, "utf8");
    const cfg = loadConfig(configPath);

    assert.equal(cfg.exists, true);
    assert.equal(cfg.memory.backend, "sqlite");
    assert.equal(cfg.hindsight.apiUrl, "https://hindsight.internal/api");
    assert.equal(cfg.hindsight.bankId, "work-bank");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkCadenceStatus: без ревизии -> isOverdue: true и daysSinceReview: null", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const statePath = join(tmp, "missing-state.json");

    writeFileSync(
      configPath,
      ["hindsight:", "  bankId: main", "  apiUrl: https://memory.test/mcp/"].join("\n"),
      "utf8"
    );

    const status = checkCadenceStatus(configPath, statePath, 7);

    assert.equal(status.isOverdue, true);
    assert.equal(status.daysSinceReview, null);
    assert.equal(status.hindsightConfigured, true);
    assert.equal(status.maxDays, 7);
    assert.equal(status.lastReview, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkCadenceStatus: hindsightConfigured: false если секция hindsight отсутствует", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "empty-config.yml");
    const statePath = join(tmp, "state.json");

    writeFileSync(configPath, "theme:\n  dark: titanium\n", "utf8");

    const status = checkCadenceStatus(configPath, statePath, 7);
    assert.equal(status.hindsightConfigured, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recordCadenceReview: запись сохраняется, повторный checkCadenceStatus дает isOverdue: false", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const statePath = join(tmp, "sub", "memory-cadence.json");

    writeFileSync(
      configPath,
      ["hindsight:", "  bankId: main", "  apiUrl: https://memory.test/mcp/"].join("\n"),
      "utf8"
    );

    // До записи: ревизии нет, статус просрочен
    const beforeStatus = checkCadenceStatus(configPath, statePath, 7);
    assert.equal(beforeStatus.isOverdue, true);

    // Запись ревизии
    const recorded = recordCadenceReview(statePath, {
      reviewer: "test-agent",
      notes: "Проведена очистка устаревших воспоминаний",
      status: "completed",
    });

    assert.equal(recorded.reviewer, "test-agent");
    assert.equal(recorded.status, "completed");
    assert.equal(recorded.notes, "Проведена очистка устаревших воспоминаний");
    assert.ok(recorded.date);

    // Проверка файла состояния
    assert.equal(existsSync(statePath), true);
    const loadedState = loadCadenceState(statePath);
    assert.equal(loadedState.exists, true);
    assert.equal(loadedState.lastReview.reviewer, "test-agent");
    assert.equal(loadedState.history.length, 1);

    // После записи: статус свежий (не просрочен)
    const afterStatus = checkCadenceStatus(configPath, statePath, 7);
    assert.equal(afterStatus.isOverdue, false);
    assert.ok(afterStatus.daysSinceReview !== null);
    assert.ok(afterStatus.daysSinceReview <= 0.1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkCadenceStatus: старая ревизия (> maxDays) дает isOverdue: true", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const statePath = join(tmp, "state.json");

    writeFileSync(configPath, "hindsight:\n  bankId: main\n", "utf8");

    // Записываем ревизию с датой 10 дней назад
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    recordCadenceReview(statePath, {
      date: tenDaysAgo,
      reviewer: "historical-agent",
      notes: "Old review",
    });

    const status = checkCadenceStatus(configPath, statePath, 7);
    assert.equal(status.isOverdue, true);
    assert.ok(status.daysSinceReview >= 9.9);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatCadenceReport: формирует человекочитаемый отчет", () => {
  const reportOverdue = formatCadenceReport({
    isOverdue: true,
    maxDays: 7,
    daysSinceReview: null,
    lastReview: null,
    hindsightConfigured: true,
    config: {
      path: "config.yml",
      exists: true,
      hindsight: { bankId: "main", apiUrl: "https://test.mcp" },
      memory: { backend: "off" },
    },
    state: { path: "state.json", exists: false },
  });

  assert.ok(reportOverdue.includes("СТАТУС КАДЕНЦИИ ПАМЯТИ"));
  assert.ok(reportOverdue.includes("ПРОСРОЧЕНА (OVERDUE)"));
  assert.ok(reportOverdue.includes("ТРЕБУЕТСЯ РЕВИЗИЯ ПАМЯТИ"));

  const reportFresh = formatCadenceReport({
    isOverdue: false,
    maxDays: 7,
    daysSinceReview: 1.5,
    lastReview: { date: "2026-09-20T10:00:00.000Z", reviewer: "alice" },
    hindsightConfigured: true,
    config: {
      path: "config.yml",
      exists: true,
      hindsight: { bankId: "main", apiUrl: "https://test.mcp" },
      memory: { backend: "off" },
    },
    state: { path: "state.json", exists: true },
  });

  assert.ok(reportFresh.includes("В НОРМЕ (FRESH)"));
  assert.ok(reportFresh.includes("1.5 дн."));
  assert.ok(reportFresh.includes("alice"));
});

test("CLI: --help печатает справку и завершается с кодом 0", () => {
  const proc = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(proc.status, 0);
  assert.ok(proc.stdout.includes("memory-cadence.mjs"));
  assert.ok(proc.stdout.includes("--check"));
  assert.ok(proc.stdout.includes("--record"));
});

test("CLI: --check при отсутствии ревизии завершается с кодом 1, после --record — с кодом 0", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const statePath = join(tmp, "cadence.json");

    writeFileSync(configPath, "hindsight:\n  bankId: main\n", "utf8");

    // 1. Проверка свежести при отсутствии ревизии -> exit code 1
    const check1 = spawnSync(
      process.execPath,
      [CLI_PATH, "--check", "--config", configPath, "--state", statePath],
      { encoding: "utf8" }
    );
    assert.equal(check1.status, 1, "При отсутствии ревизии exit code должен быть 1");

    // 2. Запись факта ревизии -> exit code 0
    const recordProc = spawnSync(
      process.execPath,
      [CLI_PATH, "--record", "--reviewer", "cli-agent", "--config", configPath, "--state", statePath],
      { encoding: "utf8" }
    );
    assert.equal(recordProc.status, 0, "Запись ревизии должна завершаться с кодом 0");
    assert.ok(recordProc.stdout.includes("Ревизия памяти успешно записана"));

    // 3. Проверка свежести после ревизии -> exit code 0
    const check2 = spawnSync(
      process.execPath,
      [CLI_PATH, "--check", "--config", configPath, "--state", statePath],
      { encoding: "utf8" }
    );
    assert.equal(check2.status, 0, "После записи ревизии exit code должен быть 0");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --json вывод выводит валидный JSON с ожидаемыми полями", () => {
  const tmp = createTempDir();
  try {
    const configPath = join(tmp, "config.yml");
    const statePath = join(tmp, "cadence.json");

    writeFileSync(
      configPath,
      ["hindsight:", "  bankId: main", "  apiUrl: https://memory.json.test/"].join("\n"),
      "utf8"
    );

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "--json", "--config", configPath, "--state", statePath],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);

    assert.equal(typeof parsed.isOverdue, "boolean");
    assert.equal(parsed.isOverdue, true);
    assert.equal(parsed.hindsightConfigured, true);
    assert.equal(parsed.daysSinceReview, null);
    assert.equal(parsed.maxDays, 7);
    assert.equal(parsed.config.hindsight.bankId, "main");
    assert.equal(parsed.config.hindsight.apiUrl, "https://memory.json.test/");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: неверный --max-days или неизвестный флаг отклоняется с exit 2", () => {
  const resInvalid = spawnSync(process.execPath, [CLI_PATH, "--max-days", "abc"], { encoding: "utf8" });
  assert.equal(resInvalid.status, 2);
  assert.ok(resInvalid.stderr.includes("--max-days"));

  const resUnknown = spawnSync(process.execPath, [CLI_PATH, "--bad-flag"], { encoding: "utf8" });
  assert.equal(resUnknown.status, 2);
  assert.ok(resUnknown.stderr.includes("неизвестный параметр"));
});

test("CLI: --root переопределяет каталог состояния .workflow", () => {
  const tmp = createTempDir();
  try {
    const proc = spawnSync(process.execPath, [CLI_PATH, "--root", tmp, "--record"], { encoding: "utf8" });
    assert.equal(proc.status, 0);
    assert.ok(existsSync(join(tmp, ".workflow", "memory-cadence.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
