/**
 * tools/tests/mutation-test.test.mjs — Тесты для инструмента мутационного тестирования.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MUTATION_OPERATORS,
  generateMutants,
  runMutationTesting,
  formatMutationReport,
  parseArgs,
} from "../mutation-test.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../mutation-test.mjs", import.meta.url)));
import { createTempDir } from "./test-helpers.mjs";


test("MUTATION_OPERATORS: содержит ключевые мутационные операторы", () => {
  const names = MUTATION_OPERATORS.map((op) => op.name);
  assert.ok(names.includes("equality-inversion"));
  assert.ok(names.includes("boolean-true"));
  assert.ok(names.includes("boolean-false"));
  assert.ok(names.includes("logical-and"));
  assert.ok(names.includes("logical-or"));
  assert.ok(names.includes("arithmetic-add"));
});

test("generateMutants: находит и генерирует различные типы мутантов", () => {
  const code = `
    function calculate(a, b) {
      if (a === b) return true;
      if (a > 10 && b < 5) return false;
      return a + b;
    }
  `;

  const mutants = generateMutants(code, { maxMutants: 10 });
  assert.ok(mutants.length >= 4);

  const operators = mutants.map((m) => m.operator);
  assert.ok(operators.includes("equality-inversion"));
  assert.ok(operators.includes("boolean-true") || operators.includes("boolean-false"));
  assert.ok(operators.includes("logical-and"));
  assert.ok(operators.includes("arithmetic-add"));
});

test("parseArgs: валидация аргументов и обработка ошибок", () => {
  const clean = parseArgs(["--target", "src/calc.js", "--threshold", "85"]);
  assert.equal(clean.target, "src/calc.js");
  assert.equal(clean.threshold, 85);
  assert.equal(clean.errors.length, 0);

  const invalidThresh = parseArgs(["--threshold", "150"]);
  assert.ok(invalidThresh.errors.some((e) => e.includes("--threshold")));

  const invalidMutants = parseArgs(["--max-mutants", "abc"]);
  assert.ok(invalidMutants.errors.some((e) => e.includes("--max-mutants")));

  const unknown = parseArgs(["--bad-flag"]);
  assert.ok(unknown.errors.some((e) => e.includes("неизвестный параметр")));
});

test("runMutationTesting: dry-run не запускает тесты и возвращает список мутантов", () => {
  const tmp = createTempDir();
  try {
    const targetFile = join(tmp, "math.js");
    writeFileSync(targetFile, "export function add(a, b) { return a + b; }", "utf8");

    const res = runMutationTesting({
      targetPath: targetFile,
      dryRun: true,
    });

    assert.equal(res.dryRun, true);
    assert.ok(res.totalMutants > 0);
    assert.equal(readFileSync(targetFile, "utf8"), "export function add(a, b) { return a + b; }");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runMutationTesting: падает, если тесты исходно красные", () => {
  const tmp = createTempDir();
  try {
    const targetFile = join(tmp, "app.js");
    writeFileSync(targetFile, "const x = 1;", "utf8");

    assert.throws(
      () => {
        runMutationTesting({
          targetPath: targetFile,
          testCmd: 'node -e "process.exit(1)"',
        });
      },
      /Базовый набор тестов упал на исходном коде/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runMutationTesting: убивает мутантов и восстанавливает файл на диске", () => {
  const tmp = createTempDir();
  try {
    const targetFile = join(tmp, "logic.js");
    const originalContent = `
      function isEven(n) {
        return n % 2 === 0;
      }
      module.exports = { isEven };
    `.trim();

    writeFileSync(targetFile, originalContent, "utf8");

    const testFile = join(tmp, "logic.test.js");
    const testContent = `
      const assert = require('node:assert/strict');
      const { isEven } = require('./logic.js');
      assert.equal(isEven(2), true);
      assert.equal(isEven(3), false);
    `.trim();

    writeFileSync(testFile, testContent, "utf8");

    // Запускаем мутационное тестирование
    const summary = runMutationTesting({
      targetPath: targetFile,
      testCmd: `node ${testFile}`,
      threshold: 50,
      maxMutants: 5,
    });

    assert.ok(summary.totalMutants > 0);
    assert.ok(summary.killed > 0);
    assert.equal(summary.passed, true);
    assert.equal(typeof summary.mutationScore, "number");

    // ПРОВЕРКА: исходный файл остался в первозданном виде!
    assert.equal(readFileSync(targetFile, "utf8"), originalContent);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatMutationReport: формирует понятный RU отчет", () => {
  const report = formatMutationReport({
    target: "src/calc.js",
    totalMutants: 10,
    killed: 9,
    survived: 1,
    mutationScore: 90.0,
    threshold: 80,
    passed: true,
    results: [
      {
        id: 1,
        operator: "equality-inversion",
        lineNumber: 5,
        originalLine: "if (a === 1)",
        mutatedLine: "if (a !== 1)",
        status: "survived",
      },
    ],
  });

  assert.ok(report.includes("ОТЧЁТ МУТАЦИОННОГО ТЕСТИРОВАНИЯ"));
  assert.ok(report.includes("90%"));
  assert.ok(report.includes("В НОРМЕ (PASSED)"));
  assert.ok(report.includes("ВЫЖИВШИЕ МУТАНТЫ"));
});

test("CLI: --help, --dry-run, --check и --json возвращают ожидаемые exit codes", () => {
  const helpProc = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(helpProc.status, 0);
  assert.ok(helpProc.stdout.includes("mutation-test.mjs"));

  const noTarget = spawnSync(process.execPath, [CLI_PATH], { encoding: "utf8" , windowsHide: true});
  assert.equal(noTarget.status, 2);

  const tmp = createTempDir();
  try {
    const targetFile = join(tmp, "demo.js");
    writeFileSync(targetFile, "function fn(x) { return x === 1; }", "utf8");

    const dryProc = spawnSync(process.execPath, [CLI_PATH, "--target", targetFile, "--dry-run", "--json"], {
      encoding: "utf8",
    });
    assert.equal(dryProc.status, 0);
    const parsed = JSON.parse(dryProc.stdout);
    assert.equal(parsed.dryRun, true);
    assert.ok(parsed.totalMutants > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
