#!/usr/bin/env node
/**
 * tools/auto-review.mjs — автоматический контроль качества и гейт.
 *
 * ФУНКЦИОНАЛ:
 *   - Проверяет TypeScript (tsc --noEmit), если в проекте есть tsconfig.json (отчёт-only).
 *   - Проверяет ESLint, если в проекте есть .eslintrc* или eslint.config.* (отчёт-only).
 *   - Запускает npm test, если в package.json объявлен test-скрипт (гейт).
 *   - Проверяет долговой реестр: node debt-ledger.mjs scan --root <root> --check (гейт).
 *   - Формирует понятный отчёт на русском языке (без правки кода).
 *   - Завершается с кодом 1 при провале любого гейта; иначе код 0.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   node tools/auto-review.mjs [--root <dir>]
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/** Resolve npm-family executables on Windows without a shell (injection-safe). */
function npmBin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function parseArgs(argv) {
  const flags = { root: "." };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      flags.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
    }
  }
  return flags;
}

function readJsonSafe(filepath) {
  if (!existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * Поиск конфигурационных файлов eslint (.eslintrc*, eslint.config.*).
 */
function findEslintConfig(root) {
  try {
    const files = readdirSync(root);
    return files.find((f) => f.startsWith(".eslintrc") || f.startsWith("eslint.config."));
  } catch {
    return null;
  }
}

export async function runAutoReview(opts = {}) {
  const root = resolve(opts.root || ".");
  const toolsDir = resolve(fileURLToPath(new URL(".", import.meta.url)));

  const reportLines = [];
  function log(msg = "") {
    reportLines.push(msg);
    if (!opts.silent) console.log(msg);
  }

  log("================================================================");
  log("🔍 Авто-ревью проекта (auto-review.mjs)");
  log(`📂 Директория: ${root}`);
  log("================================================================\n");

  let hasGateFailure = false;
  const failureReasons = [];

  // 1. Статическая типизация: tsc --noEmit
  log("--- 1. Проверка типов (TypeScript) ---");
  const tsconfigPath = join(root, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    log("Найдена конфигурация tsconfig.json, запуск tsc --noEmit...");
    const tscRes = spawnSync(npmBin("npx"), ["--yes", "tsc", "--noEmit", "-p", tsconfigPath], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      shell: false,
    });
    if (tscRes.status === 0) {
      log("✅ TypeScript: проверка типов пройдена успешно без ошибок.");
    } else {
      log(`⚠️ TypeScript: обнаружены ошибки компиляции (код ${tscRes.status}). (Отчёт-only)`);
      const errOut = (tscRes.stdout + "\n" + tscRes.stderr).trim();
      const firstFew = errOut.split("\n").slice(0, 5).join("\n");
      if (firstFew) log(`   ${firstFew}`);
    }
  } else {
    log("ℹ️ tsconfig.json не обнаружен, проверка типов пропущена.");
  }

  // 2. Линтер: eslint
  log("\n--- 2. Линтинг (ESLint) ---");
  const eslintCfg = findEslintConfig(root);
  if (eslintCfg) {
    log(`Найден конфигурационный файл линтера: ${eslintCfg}`);
    const eslintRes = spawnSync(npmBin("npx"), ["--yes", "eslint", "."], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      shell: false,
    });
    if (eslintRes.status === 0) {
      log("✅ ESLint: нарушений правил линтинга не найдено.");
    } else {
      log(`⚠️ ESLint: обнаружены предупреждения или ошибки (код ${eslintRes.status}). (Отчёт-only)`);
    }
  } else {
    log("ℹ️ Конфигурация ESLint не найдена, шаг линтинга пропущен.");
  }

  // 3. Запуск тестов проекта (если есть npm test в package.json)
  log("\n--- 3. Автоматические тесты (npm test) ---");
  const pkgJsonPath = join(root, "package.json");
  const pkg = readJsonSafe(pkgJsonPath);

  if (pkg?.scripts?.test) {
    log(`Запуск тестового скрипта: npm test ("${pkg.scripts.test}")...`);
    const testRes = spawnSync(npmBin("npm"), ["test"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      shell: false,
    });

    const combinedOutput = (testRes.stdout || "") + "\n" + (testRes.stderr || "");

    // Парсим количество тестов (поддержка node:test, jest, vitest, mocha)
    let passCount = 0;
    let failCount = 0;

    // Регулярные выражения для node:test ("ℹ tests 10", "ℹ pass 9", "ℹ fail 1")
    const nodePass = combinedOutput.match(/ℹ\s+pass\s+(\d+)/i) || combinedOutput.match(/passed\s+(\d+)/i);
    const nodeFail = combinedOutput.match(/ℹ\s+fail\s+(\d+)/i) || combinedOutput.match(/failed\s+(\d+)/i);

    if (nodePass) passCount = parseInt(nodePass[1], 10);
    if (nodeFail) failCount = parseInt(nodeFail[1], 10);

    if (testRes.status === 0) {
      log(`✅ Тесты успешно выполнены: пройдено ~${passCount}, провалено ${failCount}`);
    } else {
      hasGateFailure = true;
      failureReasons.push(`Провалены автоматические тесты (код ${testRes.status})`);
      log(`🔴 Тесты завершились с ошибкой (код ${testRes.status}): пройдено ${passCount}, провалено ${failCount || 1}`);
      const errOut = combinedOutput.trim().split("\n").slice(-10).join("\n");
      if (errOut) log(`   ${errOut}`);
    }
  } else {
    log("ℹ️ В package.json отсутствует скрипт 'test', выполнение тестов пропущено.");
  }

  // 4. Долговой реестр: debt-ledger scan --check
  log("\n--- 4. Долговой реестр (debt-ledger) ---");
  const debtLedgerScript = join(toolsDir, "debt-ledger.mjs");
  if (existsSync(debtLedgerScript)) {
    const dlRes = spawnSync(process.execPath, [debtLedgerScript, "scan", "--root", root, "--check"], {
      stdio: "pipe",
      encoding: "utf8",
    });

    const dlOut = (dlRes.stdout || "").trim();
    if (dlOut) {
      log(dlOut);
    }

    if (dlRes.status === 0) {
      log("✅ Долговой реестр: все маркеры имеют триггеры или отложенные упрощения отсутствуют.");
    } else {
      hasGateFailure = true;
      failureReasons.push(`Обнаружены маркеры отложенных упрощений без триггера (debt-ledger, код ${dlRes.status})`);
      log(`🔴 Долговой реестр: обнаружены нарушения (код ${dlRes.status}).`);
    }
  } else {
    log("ℹ️ debt-ledger.mjs не обнаружен, шаг пропущен.");
  }

  // 5. Итоговый результат
  log("\n================================================================");
  if (hasGateFailure) {
    log("❌ ИТОГ: АВТО-РЕВЬЮ НЕ ПРОЙДЕНО (Код 1)");
    for (const reason of failureReasons) {
      log(`  - 🔴 ${reason}`);
    }
    log("Рекомендация: устраните сбои тестов и добавьте триггеры к маркерам отложенных упрощений перед мерджем.");
    log("================================================================");
    return { success: false, exitCode: 1, report: reportLines.join("\n") };
  } else {
    log("✅ ИТОГ: АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО (Код 0)");
    log("Все обязательные гейты пройдены.");
    log("================================================================");
    return { success: true, exitCode: 0, report: reportLines.join("\n") };
  }
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = parseArgs(process.argv.slice(2));
  runAutoReview({ root: flags.root }).then((res) => {
    process.exit(res.exitCode);
  }).catch((err) => {
    console.error("Ошибка выполнения auto-review:", err);
    process.exit(2);
  });
}
