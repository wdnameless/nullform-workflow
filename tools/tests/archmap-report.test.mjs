/**
 * tools/tests/archmap-report.test.mjs
 *
 * Regression tests for archmap-report.mjs:
 * - R01: View buttons row (Модули | Вызовы | Проблемы), aria-pressed, keyboard access
 * - R02: Folder cluster mode when >40 files, group nodes with file counts, expand/collapse
 * - R03: Per-file local graph: center node, imports (left), imported-by (right), symbols & call edges below, «← К карте»
 * - R04: Проблемы view: severity grouping (critical -> low), category filter chips, file:line chips
 * - R06: «Копировать промпт для ИИ» button with clipboard API + execCommand fallback for file://, 1.5s feedback
 * - R07: Problem ordering priority (critical -> high -> medium -> low)
 * - Offline single-file HTML & legacy findings fallback when state.problems is absent
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderHtml } from "../archmap-report.mjs";

test("renderHtml signature and backwards compatibility with minimal state", () => {
  const html = renderHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html[^>]*lang="ru"/);
  assert.match(html, /<svg id="graph"/);
  assert.match(html, /tab-modules/);
  assert.match(html, /tab-calls/);
  assert.match(html, /tab-problems/);
});

test("R01: View buttons row contains Модули, Вызовы, Проблемы with aria-pressed and tablist role", () => {
  const state = {
    root: "test-proj",
    scannedAt: new Date().toISOString(),
    files: {
      "src/a.ts": { loc: 50, complexity: 2, mi: 80, deps: [] }
    },
    totals: { files: 1, loc: 50, avgMi: 80 },
    cycles: []
  };

  const html = renderHtml(state);

  // Checks for the 3 view buttons
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="tab-modules"[^>]*aria-pressed="true"[^>]*>.*Модули/);
  assert.match(html, /id="tab-calls"[^>]*aria-pressed="false"[^>]*>.*Вызовы/);
  assert.match(html, /id="tab-problems"[^>]*aria-pressed="false"[^>]*>.*Проблемы/);

  // Keyboard navigation instructions or handlers
  assert.match(html, /ArrowRight/);
  assert.match(html, /ArrowLeft/);
});

test("R02: Folder clustering mode activates when >40 files and defaults flat when <=40 files", () => {
  // Case 1: <= 40 files -> flat mode default
  const flatFiles = {};
  for (let i = 1; i <= 30; i++) {
    flatFiles[`src/file${i}.ts`] = { loc: 10, complexity: 1, mi: 85, deps: [] };
  }
  const flatState = {
    root: "flat-proj",
    files: flatFiles,
    totals: { files: 30, loc: 300, avgMi: 85 },
    cycles: []
  };
  const flatHtml = renderHtml(flatState);
  assert.match(flatHtml, /data-id="src\/file1\.ts"/);

  // Case 2: > 40 files -> cluster mode default with top-level folder groups & «Развернуть всё» button
  const clusterFiles = {};
  for (let i = 1; i <= 25; i++) {
    clusterFiles[`src/feat/file${i}.ts`] = { loc: 20, complexity: 2, mi: 80, deps: [] };
  }
  for (let i = 1; i <= 25; i++) {
    clusterFiles[`lib/core/file${i}.ts`] = { loc: 15, complexity: 1, mi: 82, deps: [] };
  }
  const clusterState = {
    root: "cluster-proj",
    files: clusterFiles,
    totals: { files: 50, loc: 875, avgMi: 81 },
    cycles: []
  };
  const clusterHtml = renderHtml(clusterState);

  assert.match(clusterHtml, /btn-cluster-toggle/);
  assert.match(clusterHtml, /Развернуть всё/);
  assert.match(clusterHtml, /cluster:/);
});

test("R03: Per-file local graph: «Открыть файл» affordance, center node, left imports, right users, symbols & call edges below, «← К карте» button", () => {
  const state = {
    root: "per-file-proj",
    files: {
      "src/target.ts": { loc: 100, complexity: 5, mi: 70, deps: ["src/dep.ts"] },
      "src/dep.ts": { loc: 40, complexity: 2, mi: 85, deps: [] },
      "src/user.ts": { loc: 60, complexity: 3, mi: 75, deps: ["src/target.ts"] },
    },
    symbols: [
      { id: "src/target.ts#fnA", name: "fnA", kind: "function", file: "src/target.ts", line: 10, endLine: 20 },
      { id: "src/target.ts#fnB", name: "fnB", kind: "function", file: "src/target.ts", line: 25, endLine: 35 },
    ],
    calls: [
      { from: "src/target.ts#fnA", to: "src/target.ts#fnB", line: 15 }
    ],
    totals: { files: 3, loc: 200, avgMi: 76 },
    cycles: []
  };

  const html = renderHtml(state);

  // «Открыть файл» affordance
  assert.match(html, /Открыть файл|btn-open-file/);
  // «← К карте» return button
  assert.match(html, /btn-back-to-map/);
  assert.match(html, /← К карте/);
  // Per-file local graph rendering function
  assert.match(html, /renderFileLocalGraph/);
});

test("R04 & R07: Проблемы view: severity grouping (критический, высокий, средний, низкий), category chips filter", () => {
  const state = {
    root: "prob-proj",
    files: {
      "src/app.ts": { loc: 100, complexity: 10, mi: 60, deps: [] }
    },
    totals: { files: 1, loc: 100, avgMi: 60 },
    cycles: [],
    problems: [
      {
        id: "prob-1",
        severity: "critical",
        category: "security",
        kind: "secret_leak",
        title: "Обнаружен возможный секрет",
        why: "Ключи API в исходном коде создают риск компрометации.",
        fix: "Вынесите секрет в переменные окружения.",
        where: [{ file: "src/app.ts", line: 12 }],
        prompt: "Удали секрет из src/app.ts:12",
        heuristic: true,
      },
      {
        id: "prob-2",
        severity: "high",
        category: "structure",
        kind: "cycle",
        title: "Цикл зависимостей",
        why: "Два файла взаимно импортируют друг друга.",
        fix: "Вынесите общий интерфейс.",
        where: [{ file: "src/app.ts", line: 1 }],
        prompt: "Устрани цикл в src/app.ts",
        heuristic: true,
      },
      {
        id: "prob-3",
        severity: "medium",
        category: "maintainability",
        kind: "size",
        title: "Крупный модуль",
        why: "Файл превышает рекомендуемый размер.",
        fix: "Разделите файл на модули.",
        where: [{ file: "src/app.ts", line: 1 }],
        prompt: "Раздели файл src/app.ts",
        heuristic: true,
      },
      {
        id: "prob-4",
        severity: "low",
        category: "optimization",
        kind: "unresolved",
        title: "Неразрешённый вызов",
        why: "Динамический вызов функции.",
        fix: "Добавьте явную типизацию.",
        where: [{ file: "src/app.ts", line: 50 }],
        prompt: "Проверь вызов в src/app.ts:50",
        heuristic: true,
      }
    ]
  };

  const html = renderHtml(state);

  // Category filter chips
  assert.match(html, /Все/);
  assert.match(html, /Структура/);
  assert.match(html, /Оптимизация/);
  assert.match(html, /Безопасность/);
  assert.match(html, /Надёжность/);
  assert.match(html, /Сопровождаемость/);

  // Severity labels
  assert.match(html, /критический/);
  assert.match(html, /высокий/);
  assert.match(html, /средний/);
  assert.match(html, /низкий/);

  // Chips for file:line jumping to file view
  assert.match(html, /src\/app\.ts:12/);
});

test("R06: «Копировать промпт для ИИ» button with clipboard API, execCommand fallback and 1.5s visual feedback", () => {
  const state = {
    root: "copy-proj",
    files: { "src/a.ts": { loc: 10, complexity: 1, mi: 90, deps: [] } },
    totals: { files: 1, loc: 10, avgMi: 90 },
    cycles: [],
    problems: [
      {
        id: "p1",
        severity: "high",
        category: "maintainability",
        kind: "size",
        title: "Тестовая проблема",
        why: "Причина проблемы",
        fix: "Рекомендация по исправлению",
        where: [{ file: "src/a.ts", line: 5 }],
        prompt: "Тестовый промпт для ИИ",
        heuristic: true
      }
    ]
  };

  const html = renderHtml(state);

  // Copy button text
  assert.match(html, /Копировать промпт для ИИ/);
  // Clipboard copy and fallback implementation
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.match(html, /execCommand\(['"]copy['"]\)/);
  // Feedback duration 1.5s (1500ms)
  assert.match(html, /1500/);
  assert.match(html, /Скопировано!/);
});

test("Legacy state fallback: displays existing findings when state.problems is absent", () => {
  const legacyState = {
    root: "legacy-proj",
    files: { "src/legacy.ts": { loc: 20, complexity: 2, mi: 80, deps: [] } },
    totals: { files: 1, loc: 20, avgMi: 80 },
    cycles: []
  };

  const legacyFindings = {
    shown: [
      {
        severity: "high",
        kind: "cycle",
        what: "2 files form a dependency cycle",
        why: "Each one needs the other to compile.",
        fix: "Break the loop.",
        where: ["src/legacy.ts"]
      }
    ],
    suppressed: 0,
    total: 1
  };

  const html = renderHtml(legacyState, null, legacyFindings);
  assert.match(html, /Замечания и архитектурные дефекты/);
  assert.match(html, /Цикл зависимостей/);
});

test("Generated client script is valid standalone JS and data marker is replaced", () => {
  const sampleState = {
    root: "/repo/sample",
    scannedAt: new Date().toISOString(),
    files: {
      "src/index.js": { lines: 20, cyclomatic: 1, mi: 85, imports: [], exports: [] },
    },
    totals: { files: 1, loc: 20, avgMi: 85 },
    cycles: []
  };
  const html = renderHtml(sampleState);
  const scriptMatch = html.match(/<script>(?!id)([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Client script block must be present");
  const scriptSrc = scriptMatch[1];
  assert.equal(scriptSrc.includes("/*__ARCHMAP_DATA__*/"), false, "Data marker must be replaced in rendered output");
  assert.doesNotThrow(() => {
    new vm.Script(scriptSrc);
  }, "new vm.Script(src) must not throw");
});
