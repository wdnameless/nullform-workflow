#!/usr/bin/env node
/**
 * tools/auto-review.mjs — автоматический контроль качества и архитектурный гейт.
 *
 * ФУНКЦИОНАЛ:
 *   - Выполняет или считывает свежий скан archmap (state.json).
 *   - Подсчитывает проблемы по уровням важности (critical, high, medium, low).
 *   - Отслеживает циклы и новые циклы по сравнению с предыдущим снимком.
 *   - Проверяет TypeScript (tsc --noEmit), если в проекте есть tsconfig.json.
 *   - Проверяет ESLint, если в проекте есть .eslintrc* или eslint.config.*.
 *   - Запускает npm test, если в package.json объявлен test-скрипт, и выводит количество тестов.
 *   - Формирует понятный отчёт на русском языке с рекомендациями (без правки кода).
 *   - Завершается с кодом 1 при наличии критических/высоких проблем или новых циклов;
 *     иначе код 0.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   node tools/auto-review.mjs --root .
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/** Resolve npm-family executables on Windows without a shell (injection-safe). */
function npmBin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

const DIR = ".archmap";
const STATE = "state.json";
const PREV = "previous.json";

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
 * Проверяет, актуален ли существующий state.json по mtime исходников.
 */
function isStateFresh(root, stateFilePath) {
  if (!existsSync(stateFilePath)) return false;
  try {
    const stateMtime = statSync(stateFilePath).mtimeMs;
    const skipDirs = new Set([
      "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
      "coverage", "__pycache__", ".venv", "venv", "vendor", ".turbo", ".archmap",
      ".codemap", ".workflow", ".prompt-lint"
    ]);

    let maxSourceMtime = 0;

    function walk(dir) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name)) continue;
          walk(join(dir, ent.name));
        } else if (ent.isFile()) {
          const ext = ent.name.slice(ent.name.lastIndexOf("."));
          if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java"].includes(ext)) {
            const s = statSync(join(dir, ent.name));
            if (s.mtimeMs > maxSourceMtime) maxSourceMtime = s.mtimeMs;
          }
        }
      }
    }

    walk(root);
    return maxSourceMtime > 0 && stateMtime >= maxSourceMtime;
  } catch {
    return false;
  }
}

/**
 * Запускает archmap scan при необходимости.
 */
function ensureArchmapScan(root, toolsDir) {
  const statePath = join(root, DIR, STATE);
  if (isStateFresh(root, statePath)) {
    const loaded = readJsonSafe(statePath);
    if (loaded) return loaded;
  }

  // Запуск node archmap.mjs scan --root <root>
  const archmapScript = join(toolsDir, "archmap.mjs");
  if (existsSync(archmapScript)) {
    const res = spawnSync(process.execPath, [archmapScript, "scan", "--root", root], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (res.error) {
      console.warn("Предупреждение: ошибка запуска archmap.mjs:", res.error.message);
    }
  }

  return readJsonSafe(statePath);
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

  // 1. Архитектурный анализ через archmap
  log("--- 1. Архитектурный аудит (archmap) ---");
  const state = ensureArchmapScan(root, toolsDir);
  const prevState = readJsonSafe(join(root, DIR, PREV));

  if (!state) {
    log("⚠️ Не удалось получить состояние архитектуры из .archmap/state.json.");
  } else {
    const totals = state.totals || {};
    log(`Статистика: файлов — ${totals.files ?? 0}, строк — ${totals.loc ?? 0}, индекс MI — ${totals.avgMi ?? 0}/100`);

    // Подсчет проблем по уровням важности
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    if (Array.isArray(state.problems)) {
      for (const p of state.problems) {
        if (p.severity === "critical") criticalCount++;
        else if (p.severity === "high") highCount++;
        else if (p.severity === "medium") mediumCount++;
        else if (p.severity === "low") lowCount++;
      }
      log(`Проблемы архитектуры: 🔴 ${criticalCount} критических | 🟠 ${highCount} высоких | 🟡 ${mediumCount} средних | ⚪ ${lowCount} низких`);

      if (criticalCount > 0 || highCount > 0) {
        hasGateFailure = true;
        failureReasons.push(`Обнаружены критические или высокие проблемы архитектуры (${criticalCount} крит., ${highCount} выс.)`);
        log("\nОбнаруженные критические и важные проблемы:");
        state.problems
          .filter((p) => p.severity === "critical" || p.severity === "high")
          .slice(0, 10)
          .forEach((p) => {
            const loc = p.where && p.where[0] ? `${p.where[0].file}:${p.where[0].line}` : "";
            log(`  • [${p.severity.toUpperCase()}] ${p.title} (${loc})`);
            if (p.why) log(`    Причина: ${p.why}`);
            if (p.fix) log(`    Решение: ${p.fix}`);
          });
      }
    } else {
      // Fallback: если state.problems отсутствует, проверяем findings (считаем high)
      const findingsList = Array.isArray(state.findings) ? state.findings : [];
      for (const f of findingsList) {
        if (f.severity === "high") highCount++;
        else if (f.severity === "medium") mediumCount++;
        else if (f.severity === "low") lowCount++;
      }
      if (findingsList.length > 0) {
        log(`Находки архитектуры (устаревший формат): 🟠 ${highCount} высоких | 🟡 ${mediumCount} средних | ⚪ ${lowCount} низких`);
        if (highCount > 0) {
          hasGateFailure = true;
          failureReasons.push(`Обнаружены критические/высокие замечания архитектуры (${highCount} выс.)`);
        }
      }
    }

    // Проверка циклов и новых циклов
    const currentCycles = state.cycles || [];
    const prevCycles = prevState?.cycles || [];
    const currentCycleKeys = new Set(currentCycles.map((c) => Array.isArray(c) ? c.join("->") : String(c)));
    const prevCycleKeys = new Set(prevCycles.map((c) => Array.isArray(c) ? c.join("->") : String(c)));

    const newCycles = currentCycles.filter((c) => {
      const key = Array.isArray(c) ? c.join("->") : String(c);
      return !prevCycleKeys.has(key);
    });

    log(`Циклические зависимости модулей: всего ${currentCycles.length}, новых ${newCycles.length}`);

    if (newCycles.length > 0) {
      hasGateFailure = true;
      failureReasons.push(`Появились новые циклические зависимости (${newCycles.length})`);
      log("🔴 Новые циклы (запрещены гейтом):");
      newCycles.forEach((c) => {
        log(`  • ${Array.isArray(c) ? c.join(" -> ") : c}`);
      });
    } else if (currentCycles.length > 0) {
      // Если это первый скан и есть циклы
      if (!prevState) {
        hasGateFailure = true;
        failureReasons.push(`Обнаружены циклические зависимости (${currentCycles.length})`);
        log("🔴 Обнаружены циклы в зависимостях:");
        currentCycles.forEach((c) => {
          log(`  • ${Array.isArray(c) ? c.join(" -> ") : c}`);
        });
      } else {
        log("ℹ️ Существующие ранее циклы не увеличились.");
      }
    } else {
      log("✅ Циклических зависимостей нет.");
    }
  }

  // 2. Статическая типизация: tsc --noEmit
  log("\n--- 2. Проверка типов (TypeScript) ---");
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
      log(`⚠️ TypeScript: обнаружены ошибки компиляции (код ${tscRes.status}).`);
      const errOut = (tscRes.stdout + "\n" + tscRes.stderr).trim();
      const firstFew = errOut.split("\n").slice(0, 5).join("\n");
      if (firstFew) log(`   ${firstFew}`);
    }
  } else {
    log("ℹ️ tsconfig.json не обнаружен, проверка типов пропущена.");
  }

  // 3. Линтер: eslint
  log("\n--- 3. Линтинг (ESLint) ---");
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

  // 4. Запуск тестов проекта (если есть npm test в package.json)
  log("\n--- 4. Автоматические тесты (npm test) ---");
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
      log(`⚠️ Тесты завершились с ошибкой (код ${testRes.status}): пройдено ${passCount}, провалено ${failCount || 1}`);
    }
  } else {
    log("ℹ️ В package.json отсутствует скрипт 'test', выполнение тестов пропущено.");
  }

  // 5. Итоговый результат
  log("\n================================================================");
  if (hasGateFailure) {
    log("❌ ИТОГ: АВТО-РЕВЬЮ НЕ ПРОЙДЕНО (Код 1)");
    for (const reason of failureReasons) {
      log(`  - 🔴 ${reason}`);
    }
    log("Рекомендация: исправьте критические проблемы и разорвите циклические зависимости перед мерджем.");
    log("================================================================");
    return { success: false, exitCode: 1, report: reportLines.join("\n") };
  } else {
    log("✅ ИТОГ: АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО (Код 0)");
    log("Критических дефектов архитектуры и новых циклов не обнаружено.");
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
