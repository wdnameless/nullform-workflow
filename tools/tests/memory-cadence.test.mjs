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
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadConfig,
  loadCadenceState,
  recordCadenceReview,
  recordCadenceDecision,
  buildSessionPack,
  checkCadenceStatus,
  formatCadenceReport,
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

test("recordCadenceDecision: сохраняет решения keep/reject/defer и отклоняет reason < 10 символов", () => {
  const tmp = createTempDir();
  try {
    const statePath = join(tmp, "cadence.json");

    // 1. Валидное решение keep (reason >= 10 символов)
    const rec1 = recordCadenceDecision(statePath, {
      id: "mem-001",
      decision: "keep",
      reason: "Архитектурно важное решение проекта",
    });
    assert.equal(rec1.id, "mem-001");
    assert.equal(rec1.decision, "keep");
    assert.equal(rec1.reason, "Архитектурно важное решение проекта");
    assert.ok(rec1.at);

    // Проверка round-trip через loadCadenceState
    let state = loadCadenceState(statePath);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0].id, "mem-001");
    assert.equal(state.decisions[0].decision, "keep");

    // 2. Валидное решение reject
    recordCadenceDecision(statePath, {
      id: "mem-002",
      decision: "reject",
      reason: "Устаревший контекст прошлой итерации",
    });

    // 3. Валидное решение defer
    recordCadenceDecision(statePath, {
      id: "mem-003",
      decision: "defer",
      reason: "Требует дополнительного исследования",
    });

    state = loadCadenceState(statePath);
    assert.equal(state.decisions.length, 3);

    // 4. reason < 10 символов отклоняется
    assert.throws(
      () => {
        recordCadenceDecision(statePath, {
          id: "mem-004",
          decision: "reject",
          reason: "Коротко",
        });
      },
      (err) => {
        return err instanceof Error && /at least 10 characters/i.test(err.message);
      }
    );

    // 5. Недопустимый decision отклоняется
    assert.throws(
      () => {
        recordCadenceDecision(statePath, {
          id: "mem-005",
          decision: "invalid_decision",
          reason: "Обоснование решения достаточной длины",
        });
      },
      (err) => {
        return err instanceof Error && /must be one of: keep, reject, defer/i.test(err.message);
      }
    );

    // 6. Отсутствие id отклоняется
    assert.throws(
      () => {
        recordCadenceDecision(statePath, {
          decision: "keep",
          reason: "Обоснование решения достаточной длины",
        });
      },
      (err) => {
        return err instanceof Error && /Decision id is required/i.test(err.message);
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildSessionPack: фильтрует rejected, помечает deferred, сохраняет существующий формат пакета", () => {
  const tmp = createTempDir();
  try {
    const statePath = join(tmp, "cadence.json");

    recordCadenceDecision(statePath, {
      id: "mem-keep",
      decision: "keep",
      reason: "Актуальное правило для всей команды",
    });
    recordCadenceDecision(statePath, {
      id: "mem-reject",
      decision: "reject",
      reason: "Устаревшая информация не должна попадать в сессию",
    });
    recordCadenceDecision(statePath, {
      id: "mem-defer",
      decision: "defer",
      reason: "Требует подтверждения от оракула",
    });

    const state = loadCadenceState(statePath);

    // Тест 1: Входной формат — массив
    const rawArray = [
      { id: "mem-keep", content: "keep content", priority: 1 },
      { id: "mem-reject", content: "reject content", priority: 2 },
      { id: "mem-defer", content: "defer content", priority: 3 },
      { id: "mem-unknown", content: "unknown content", priority: 4 },
    ];

    const packedArray = buildSessionPack(rawArray, state);
    assert.equal(Array.isArray(packedArray), true);
    assert.equal(packedArray.length, 3);

    const idsInPack = packedArray.map((m) => m.id);
    assert.ok(idsInPack.includes("mem-keep"));
    assert.ok(idsInPack.includes("mem-defer"));
    assert.ok(idsInPack.includes("mem-unknown"));
    assert.ok(!idsInPack.includes("mem-reject"), "rejected воспоминание должно быть исключено из сессионного пакета");

    const deferredItem = packedArray.find((m) => m.id === "mem-defer");
    assert.equal(deferredItem.deferred, true, "deferred воспоминание должно быть помечено deferred: true");
    assert.equal(deferredItem.content, "defer content", "исходные поля должны сохраняться");
    assert.equal(deferredItem.priority, 3, "исходные поля должны сохраняться");

    const keptItem = packedArray.find((m) => m.id === "mem-keep");
    assert.equal(keptItem.deferred, undefined, "keep воспоминание не должно иметь deferred: true");

    // Тест 2: Входной формат — объект пакета с метаданными
    const sessionPackObject = {
      session: "session-xyz-123",
      createdAt: "2026-10-30T10:00:00.000Z",
      memories: rawArray,
      extraFlag: true,
    };

    const packedObj = buildSessionPack(sessionPackObject, statePath);
    assert.equal(packedObj.session, "session-xyz-123", "исходные метаданные пакета должны оставаться нетронутыми");
    assert.equal(packedObj.extraFlag, true, "исходные флаги должны оставаться нетронутыми");
    assert.equal(packedObj.memories.length, 3);
    assert.ok(!packedObj.memories.some((m) => m.id === "mem-reject"), "rejected исключен из memories пакета");
    assert.ok(packedObj.memories.find((m) => m.id === "mem-defer").deferred, "deferred помечен в memories пакета");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --record-decision сохраняет решение, отклоняет reason < 10 символов с кодом 2", () => {
  const tmp = createTempDir();
  try {
    const statePath = join(tmp, "cadence.json");

    // 1. Отклонение reason < 10 символов с кодом 2
    const resShort = spawnSync(
      process.execPath,
      [CLI_PATH, "--state", statePath, "--record-decision", "--id", "m-short", "--decision", "reject", "--reason", "short"],
      { encoding: "utf8" }
    );
    assert.equal(resShort.status, 2, "reason < 10 символов должен завершаться с кодом 2");
    assert.ok(resShort.stderr.includes("10 символов"));

    // 2. Успешная запись валидного решения
    const resOk = spawnSync(
      process.execPath,
      [CLI_PATH, "--state", statePath, "--record-decision", "--id", "m-ok", "--decision", "reject", "--reason", "Контекст более не актуален"],
      { encoding: "utf8" }
    );
    assert.equal(resOk.status, 0, "Успешная запись должна завершаться с кодом 0");
    assert.ok(resOk.stdout.includes("Решение по памяти успешно записано"));

    // 3. Проверка записи в файле состояния
    const state = loadCadenceState(statePath);
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0].id, "m-ok");
    assert.equal(state.decisions[0].decision, "reject");
    assert.equal(state.decisions[0].reason, "Контекст более не актуален");

    // 4. Запись с флагом --json
    const resJson = spawnSync(
      process.execPath,
      [CLI_PATH, "--state", statePath, "--record-decision", "--id", "m-json", "--decision", "defer", "--reason", "Требует уточнения у пользователя", "--json"],
      { encoding: "utf8" }
    );
    assert.equal(resJson.status, 0);
    const parsed = JSON.parse(resJson.stdout);
    assert.equal(parsed.action, "recorded-decision");
    assert.equal(parsed.decision.id, "m-json");
    assert.equal(parsed.decision.decision, "defer");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: неполные параметры для --record-decision отклоняются с кодом 2", () => {
  // без --id
  const resNoId = spawnSync(
    process.execPath,
    [CLI_PATH, "--record-decision", "--decision", "keep", "--reason", "Важное обоснование"],
    { encoding: "utf8" }
  );
  assert.equal(resNoId.status, 2);
  assert.ok(resNoId.stderr.includes("--id"));

  // без --decision
  const resNoDec = spawnSync(
    process.execPath,
    [CLI_PATH, "--record-decision", "--id", "m-1", "--reason", "Важное обоснование"],
    { encoding: "utf8" }
  );
  assert.equal(resNoDec.status, 2);
  assert.ok(resNoDec.stderr.includes("--decision"));

  // недопустимый --decision
  const resBadDec = spawnSync(
    process.execPath,
    [CLI_PATH, "--record-decision", "--id", "m-1", "--decision", "invalid", "--reason", "Важное обоснование"],
    { encoding: "utf8" }
  );
  assert.equal(resBadDec.status, 2);
  assert.ok(resBadDec.stderr.includes("keep, reject, defer"));
});
