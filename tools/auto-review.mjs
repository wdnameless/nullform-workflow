#!/usr/bin/env node
/**
 * tools/auto-review.mjs — автоматический контроль качества и гейт.
 *
 * ФУНКЦИОНАЛ:
 *   - Запускает package.json скрипты build/test/typecheck/lint (если есть).
 *   - Запускает --require скрипты (обязательные, отсутствие = unverified).
 *   - Запускает --check JSON_ARGV явные команды (не-npm проекты).
 *   - TypeScript/ESLint: только локальные установленные бинарники, без npx.
 *   - Долговой реестр: debt-ledger scan --check (отдельный гейт).
 *   - Статусы проверок: pass/fail/not-applicable/unverified.
 *   - Итог: fail если есть fail; unverified если есть unverified или нет продуктовых проверок; иначе pass.
 *   - Код выхода: 0=pass, 1=fail/unverified, 2=ошибка ввода.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   node tools/auto-review.mjs [--root <dir>] [--json] [--require <script>]... [--check <json_argv>]...
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolveNpmRunner } from "./installation/state.mjs";

const PROTOTYPE_PROPERTIES = new Set([
  "constructor", "__proto__", "prototype", "toString", "valueOf",
  "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"
]);

function isPlainObject(val) {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function addRequireArg(val, flags) {
  if (!val.trim() || val.startsWith("-") || val.includes("\0") || /[\r\n]/.test(val) || PROTOTYPE_PROPERTIES.has(val)) {
    flags.errors.push(`--require: невалидное значение: ${JSON.stringify(val)}`);
  } else {
    flags.requires.push(val.trim());
  }
}

function setRootArg(val, flags, prefix = "--root") {
  if (!val.trim() || val.includes("\0")) flags.errors.push(`${prefix}: недопустимое значение директории`);
  else flags.root = val;
}

/** Parse all CLI args, collecting errors before any dispatch. */
function parseArgs(argv) {
  const flags = { root: ".", json: false, help: false, requires: [], checks: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--root") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        flags.errors.push("--root: пропущено значение директории");
      } else {
        setRootArg(argv[++i], flags);
      }
    } else if (arg.startsWith("--root=")) {
      setRootArg(arg.slice("--root=".length), flags, "--root=");
    } else if (arg === "--require") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        flags.errors.push("--require: пропущено значение скрипта");
      } else {
        addRequireArg(argv[++i], flags);
      }
    } else if (arg.startsWith("--require=")) {
      addRequireArg(arg.slice("--require=".length), flags);
    } else if (arg === "--check") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        flags.errors.push("--check: пропущено значение команды");
      } else {
        const parsed = parseCheckArgv(argv[++i]);
        if (parsed.error) flags.errors.push(parsed.error);
        else flags.checks.push(parsed.argv);
      }
    } else if (arg.startsWith("--check=")) {
      const parsed = parseCheckArgv(arg.slice("--check=".length));
      if (parsed.error) flags.errors.push(parsed.error);
      else flags.checks.push(parsed.argv);
    } else if (arg.startsWith("-")) {
      flags.errors.push(`неизвестный параметр: ${arg}`);
    } else {
      flags.errors.push(`позиционный аргумент не допускается: ${arg}`);
    }
  }
  return flags;
}

/** Parse a --check JSON_ARGV value. */
function parseCheckArgv(val) {
  if (val === undefined || val === null || typeof val !== "string" || !val.trim()) {
    return { error: "--check: пустое значение" };
  }
  let parsed;
  try {
    parsed = JSON.parse(val);
  } catch {
    return { error: `--check: невалидный JSON: ${val}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "--check: ожидается непустой массив строк" };
  }
  for (const el of parsed) {
    if (typeof el !== "string" || el.length === 0) {
      return { error: "--check: все элементы должны быть непустыми строками" };
    }
    if (el.includes("\0")) {
      return { error: "--check: элемент содержит NUL" };
    }
  }
  return { argv: parsed };
}

/** Validate runAutoReview options, throwing on malformed input. */
function validateOpts(opts) {
  if (typeof opts !== "object" || opts === null) {
    throw new TypeError("opts must be an object");
  }
  if (opts.root !== undefined) {
    if (typeof opts.root !== "string" || !opts.root.trim() || /[\x00\r\n]/.test(opts.root)) {
      throw new Error("root: must be non-empty string without control characters");
    }
  }
  for (const key of ["requiredChecks", "requires"]) {
    if (opts[key] !== undefined) {
      if (!Array.isArray(opts[key])) throw new TypeError(`${key}: must be array`);
      for (const r of opts[key]) {
        if (typeof r !== "string" || !r.trim() || r.startsWith("-") || r.includes("\0") || /[\r\n]/.test(r) || PROTOTYPE_PROPERTIES.has(r)) {
          throw new Error(`invalid require value: ${JSON.stringify(r)}`);
        }
      }
    }
  }
  for (const key of ["commands", "checks"]) {
    if (opts[key] !== undefined) {
      if (!Array.isArray(opts[key])) throw new TypeError(`${key}: must be array`);
      for (const cmd of opts[key]) {
        if (!Array.isArray(cmd) || cmd.length === 0) throw new Error(`${key}[i]: must be non-empty array`);
        for (const el of cmd) {
          if (typeof el !== "string" || el.length === 0 || el.includes("\0")) {
            throw new Error(`${key}[i]: all elements must be non-empty strings without NUL`);
          }
        }
      }
    }
  }
}

/** Validate root directory, returning check object if invalid, or null if valid. */
function validateRoot(root, log) {
  try {
    const st = statSync(root);
    if (!st.isDirectory()) {
      log("🔴 Корень не является директорией");
      return { id: "root", required: true, argv: null, status: "unverified", detail: "корень не является директорией", exitCode: null, product: true };
    }
  } catch (e) {
    log(`🔴 Корень недоступен: ${e.message || e}`);
    return { id: "root", required: true, argv: null, status: "unverified", detail: `корень недоступен: ${e.message || e}`, exitCode: null, product: true };
  }
  return null;
}

/** Read package.json with full validation. */
function loadPackageJson(root, log) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { pkg: null, error: null };
  try {
    const content = readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      log("🔴 package.json: содержимое должно быть объектом");
      return { pkg: null, error: "содержимое package.json должно быть объектом" };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "scripts") && parsed.scripts !== undefined) {
      if (!isPlainObject(parsed.scripts)) {
        log("🔴 package.json: поле scripts должно быть объектом");
        return { pkg: parsed, error: "поле scripts в package.json должно быть объектом" };
      }
      for (const key of Object.keys(parsed.scripts)) {
        if (PROTOTYPE_PROPERTIES.has(key)) {
          log(`🔴 package.json: недопустимое имя скрипта: ${key}`);
          return { pkg: parsed, error: `поле scripts содержит недопустимое имя: ${key}` };
        }
        if (typeof parsed.scripts[key] !== "string" || !parsed.scripts[key].trim()) {
          log(`🔴 package.json: скрипт "${key}" имеет невалидное значение`);
          return { pkg: parsed, error: `скрипт "${key}" имеет невалидное значение` };
        }
      }
    }
    return { pkg: parsed, error: null };
  } catch (e) {
    const msg = `ошибка чтения package.json: ${e.message || e}`;
    log(`🔴 package.json: ${msg}`);
    return { pkg: null, error: msg };
  }
}


/** Run a command with timeout/buffer bounds. Returns {status, detail, exitCode}. */
function runCommand(argv, cwd, timeoutMs = 120000) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const out = ((res.stdout || "") + "\n" + (res.stderr || "")).trim();
  const short = out.split("\n").slice(-5).join("\n");

  if (res.error) {
    if (res.error.code === "ETIMEDOUT") {
      return { status: "fail", detail: `таймаут выполнения (${timeoutMs}мс)`, exitCode: null };
    }
    if (res.error.code === "ENOBUFS" || (res.error.message && res.error.message.includes("maxBuffer"))) {
      return { status: "fail", detail: "превышен лимит вывода (maxBuffer 1MB)", exitCode: null };
    }
    return { status: "unverified", detail: `ошибка запуска: ${res.error.message || res.error}`, exitCode: null };
  }
  if (res.signal) {
    return { status: "fail", detail: `процесс завершён сигналом ${res.signal}`, exitCode: null };
  }
  if (res.status === 0) {
    return { status: "pass", detail: short || "пройдено", exitCode: 0 };
  }
  if (res.status !== null) {
    return { status: "fail", detail: short || `код завершения ${res.status}`, exitCode: res.status };
  }
  return { status: "fail", detail: short || "завершено со статусом null", exitCode: null };
}

/** Collect unique script IDs from discovered + required, in stable order. */
function collectScriptIds(requiredChecks = []) {
  const standardIds = ["build", "test", "typecheck", "lint"];
  const ids = [...standardIds];
  const seen = new Set(standardIds);
  for (const req of requiredChecks) {
    if (!seen.has(req)) {
      seen.add(req);
      ids.push(req);
    }
  }
  return ids;
}

/** Execute package-script checks. */
function executeScriptChecks(root, pkg, requiredList, npmRunner, log) {
  const checks = [];
  const problems = [];
  const requiredSet = new Set(requiredList);
  const ids = collectScriptIds(requiredList);
  const scripts = pkg?.scripts && isPlainObject(pkg.scripts) ? pkg.scripts : {};

  for (const id of ids) {
    const isRequired = requiredSet.has(id);
    if (PROTOTYPE_PROPERTIES.has(id)) {
      checks.push({ id, required: isRequired, argv: null, status: "unverified", detail: `скрипт "${id}": недопустимое имя команды`, exitCode: null, product: true });
      problems.push(`Скрипт "${id}": недопустимое имя команды`);
      log(`🔴 ${id}: недопустимое имя команды`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(scripts, id)) {
      checks.push({
        id,
        required: isRequired,
        argv: null,
        status: isRequired ? "unverified" : "not-applicable",
        detail: isRequired ? `обязательный скрипт "${id}" не найден` : `скрипт "${id}" не найден`,
        exitCode: null,
        product: true,
      });
      if (isRequired) {
        problems.push(`Обязательный скрипт "${id}" не найден`);
        log(`🔴 ${id}: не найден в package.json`);
      } else {
        log(`ℹ️ ${id}: скрипт не найден, пропущен`);
      }
      continue;
    }
    const scriptVal = scripts[id];
    if (typeof scriptVal !== "string" || !scriptVal.trim()) {
      checks.push({ id, required: true, argv: null, status: "unverified", detail: `скрипт "${id}": невалидное значение команды`, exitCode: null, product: true });
      problems.push(`Скрипт "${id}": невалидное значение команды`);
      log(`🔴 ${id}: невалидное значение команды`);
      continue;
    }

    const argv = [npmRunner.command, ...npmRunner.prefixArgs, "run", id];

    log(`--- ${id}: npm run ${id} ---`);
    const result = runCommand(argv, root);
    checks.push({ id, required: true, argv, status: result.status, detail: result.detail, exitCode: result.exitCode, product: true });
    if (result.status === "fail") {
      problems.push(`Провален скрипт "${id}"`);
      log(`🔴 ${id}: провален`);
    } else if (result.status === "unverified") {
      problems.push(`Скрипт "${id}": не удалось выполнить (${result.detail})`);
      log(`🔴 ${id}: не удалось выполнить`);
    } else {
      log(`✅ ${id}: пройден`);
    }
  }
  return { checks, problems };
}

/** Execute explicit --check commands. */
function executeExplicitChecks(commandsList, root, log) {
  const checks = [];
  const problems = [];
  for (let i = 0; i < commandsList.length; i++) {
    const argv = commandsList[i];
    const id = `check:${i}`;
    log(`--- --check ${id}: ${argv.join(" ")} ---`);
    const result = runCommand(argv, root);
    checks.push({ id, required: true, argv, status: result.status, detail: result.detail, exitCode: result.exitCode, product: true });
    if (result.status === "fail") {
      problems.push(`Провалена явная проверка ${id}`);
      log(`🔴 ${id}: провалена`);
    } else if (result.status === "unverified") {
      problems.push(`Явная проверка ${id}: не удалось выполнить (${result.detail})`);
      log(`🔴 ${id}: не удалось выполнить`);
    } else {
      log(`✅ ${id}: пройдена`);
    }
  }
  return { checks, problems };
}

/** Resolve a local binary JS entry under Node (no .cmd shell issue). Returns null if no JS entry. */
function resolveLocalJsBinary(root, name) {
  const candidates = [];
  if (name === "tsc") {
    candidates.push(join(root, "node_modules", "typescript", "bin", "tsc"));
  } else if (name === "eslint") {
    candidates.push(
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      join(root, "node_modules", "eslint", "bin", "eslint.cjs"),
      join(root, "node_modules", "eslint", "bin", "eslint.mjs"),
    );
  }
  const binPath = join(root, "node_modules", ".bin", name);
  try {
    if (existsSync(binPath)) {
      const real = realpathSync(binPath);
      if (/\.[cm]?js$/i.test(real) && existsSync(real)) {
        candidates.push(real);
      }
    }
  } catch {}

  for (const c of candidates) {
    if (existsSync(c)) {
      return { command: process.execPath, prefixArgs: [c] };
    }
  }
  return null;
}

/** Find eslint config file, returning {name} or {error}. */
function findEslintConfig(root) {
  try {
    const files = readdirSync(root);
    return { name: files.find((f) => f.startsWith(".eslintrc") || f.startsWith("eslint.config.")) || null };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/** Execute TypeScript/ESLint fallback checks (skip if script already covers). */
function executeToolFallbackChecks(root, pkg, log) {
  const checks = [];
  const problems = [];
  const scripts = pkg?.scripts && isPlainObject(pkg.scripts) ? pkg.scripts : {};
  const hasTypecheckScript = Object.prototype.hasOwnProperty.call(scripts, "typecheck") && typeof scripts.typecheck === "string" && scripts.typecheck.trim() !== "";
  const hasLintScript = Object.prototype.hasOwnProperty.call(scripts, "lint") && typeof scripts.lint === "string" && scripts.lint.trim() !== "";

  if (!hasTypecheckScript) {
    const tsconfigPath = join(root, "tsconfig.json");
    if (existsSync(tsconfigPath)) {
      const tsc = resolveLocalJsBinary(root, "tsc");
      if (tsc) {
        const argv = [tsc.command, ...tsc.prefixArgs, "--noEmit", "-p", tsconfigPath];
        log("--- TypeScript: tsc --noEmit ---");
        const result = runCommand(argv, root);
        checks.push({ id: "typescript", required: true, argv, status: result.status, detail: result.detail, exitCode: result.exitCode, product: true });
        if (result.status !== "pass") {
          problems.push(`TypeScript: ${result.detail}`);
          log(`🔴 TypeScript: ${result.status}`);
        } else {
          log("✅ TypeScript: пройдена");
        }
      } else {
        checks.push({ id: "typescript", required: true, argv: null, status: "unverified", detail: "tsc не найден локально (без npx)", exitCode: null, product: true });
        problems.push("TypeScript: tsc не найден локально");
        log("🔴 TypeScript: tsc не найден локально");
      }
    } else {
      checks.push({ id: "typescript", required: false, argv: null, status: "not-applicable", detail: "tsconfig.json не найден", exitCode: null, product: true });
      log("ℹ️ TypeScript: tsconfig.json не найден, пропущен");
    }
  }

  if (!hasLintScript) {
    const eslintResult = findEslintConfig(root);
    if (eslintResult.error) {
      checks.push({ id: "eslint", required: true, argv: null, status: "unverified", detail: `ошибка чтения конфигурации: ${eslintResult.error}`, exitCode: null, product: true });
      problems.push("ESLint: ошибка чтения конфигурации");
      log(`🔴 ESLint: ошибка чтения: ${eslintResult.error}`);
    } else if (eslintResult.name) {
      const eslint = resolveLocalJsBinary(root, "eslint");
      if (eslint) {
        const argv = [eslint.command, ...eslint.prefixArgs, "."];
        log("--- ESLint ---");
        const result = runCommand(argv, root);
        checks.push({ id: "eslint", required: true, argv, status: result.status, detail: result.detail, exitCode: result.exitCode, product: true });
        if (result.status !== "pass") {
          problems.push(`ESLint: ${result.detail}`);
          log(`🔴 ESLint: ${result.status}`);
        } else {
          log("✅ ESLint: пройдена");
        }
      } else {
        checks.push({ id: "eslint", required: true, argv: null, status: "unverified", detail: "eslint не найден локально (без npx)", exitCode: null, product: true });
        problems.push("ESLint: eslint не найден локально");
        log("🔴 ESLint: eslint не найден локально");
      }
    } else {
      checks.push({ id: "eslint", required: false, argv: null, status: "not-applicable", detail: "конфигурация ESLint не найдена", exitCode: null, product: true });
      log("ℹ️ ESLint: конфигурация не найдена, пропущен");
    }
  }

  return { checks, problems };
}

/** Execute debt-ledger scan. */
function executeDebtLedgerCheck(root, toolsDir, log) {
  log("\n--- Долговой реестр (debt-ledger) ---");
  const debtLedgerScript = join(toolsDir, "debt-ledger.mjs");
  if (!existsSync(debtLedgerScript)) {
    log("ℹ️ Долговой реестр: debt-ledger.mjs не найден");
    return {
      check: { id: "debt-ledger", required: true, argv: null, status: "not-applicable", detail: "debt-ledger.mjs не найден", exitCode: null, product: false },
      problem: null,
    };
  }
  const argv = [process.execPath, debtLedgerScript, "scan", "--root", root, "--check"];
  const res = runCommand(argv, root);
  const check = { id: "debt-ledger", required: true, argv, status: res.status, detail: res.detail, exitCode: res.exitCode, product: false };
  let problem = null;
  if (res.status === "fail") {
    problem = "Обнаружены маркеры отложенных упрощений без триггера";
    log("🔴 Долговой реестр: обнаружены нарушения");
  } else if (res.status === "pass") {
    log("✅ Долговой реестр: все маркеры имеют триггеры");
  } else {
    log(`ℹ️ Долговой реестр: ${res.detail}`);
  }
  return { check, problem };
}

/** Compute overall review result. */
function buildReviewResult(checks, problems, reportLines, log) {
  const hasFailure = checks.some((c) => c.status === "fail");
  const hasUnverified = checks.some((c) => c.required && c.status === "unverified");
  const productChecksRan = checks.some((c) => c.product && (c.status === "pass" || c.status === "fail"));
  const status = hasFailure ? "fail" : (hasUnverified || !productChecksRan) ? "unverified" : "pass";
  const exitCode = status === "pass" ? 0 : 1;

  log("\n================================================================");
  if (status === "pass") {
    log("✅ ИТОГ: АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО (Код 0)\nВсе обязательные гейты пройдены.");
  } else if (status === "fail") {
    log("❌ ИТОГ: АВТО-РЕВЬЮ НЕ ПРОЙДЕНО (Код 1)");
    for (const r of problems) log(`  - 🔴 ${r}`);
    log("Рекомендация: устраните сбои перед мерджем.");
  } else {
    log("⚠️ ИТОГ: АВТО-РЕВЬЮ НЕ ПОДТВЕРЖДЕНО (Код 1)\nНет доказательств проверки продукта.");
    for (const r of problems) log(`  - ⚠️ ${r}`);
  }
  log("================================================================");

  return { success: status === "pass", exitCode, report: reportLines.join("\n"), reasons: problems, status, checks };
}

export async function runAutoReview(opts = {}) {
  validateOpts(opts);
  const root = resolve(opts.root || ".");
  const toolsDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const reportLines = [];
  function log(msg = "") { reportLines.push(msg); if (!opts.silent) console.log(msg); }

  log(`================================================================\n🔍 Авто-ревью проекта (auto-review.mjs)\n📂 Директория: ${root}\n================================================================\n`);

  const checks = [];
  const problems = [];

  const rootCheck = validateRoot(root, log);
  if (rootCheck) {
    checks.push(rootCheck);
    problems.push(rootCheck.detail);
    return buildReviewResult(checks, problems, reportLines, log);
  }

  const { pkg, error: pkgError } = loadPackageJson(root, log);
  if (pkgError) {
    checks.push({ id: "package.json", required: true, argv: null, status: "unverified", detail: pkgError, exitCode: null, product: true });
    problems.push(`package.json: ${pkgError}`);
  }

  const requiredList = [...(opts.requiredChecks || [])];
  const commandsList = opts.commands || [];
  const npmRunner = resolveNpmRunner();

  const scriptResult = executeScriptChecks(root, pkg, requiredList, npmRunner, log);
  checks.push(...scriptResult.checks);
  problems.push(...scriptResult.problems);

  const explicitResult = executeExplicitChecks(commandsList, root, log);
  checks.push(...explicitResult.checks);
  problems.push(...explicitResult.problems);

  const toolResult = executeToolFallbackChecks(root, pkg, log);
  checks.push(...toolResult.checks);
  problems.push(...toolResult.problems);

  const dlResult = executeDebtLedgerCheck(root, toolsDir, log);
  checks.push(dlResult.check);
  if (dlResult.problem) problems.push(dlResult.problem);

  return buildReviewResult(checks, problems, reportLines, log);
}

// CLI entry point
if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(`auto-review.mjs — детерминированный авто-ревью проекта\n\nИспользование:\n  node tools/auto-review.mjs [--root <dir>] [--json] [--require <script>]... [--check <json_argv>]...\n\nПараметры:\n  --root <dir>   Корень проекта (по умолчанию: .)\n  --json         Машиночитаемый отчёт вместо текстового\n  --require <script>  Обязательный скрипт из package.json (можно повторять)\n  --check <json_argv>  Явная команда проверки (можно повторять)\n  -h, --help     Показать эту справку\n`);
    process.exit(0);
  }

  if (flags.errors.length > 0) {
    for (const e of flags.errors) process.stderr.write(`Ошибка: ${e}\n`);
    process.exit(2);
  }

  const opts = { root: flags.root, requiredChecks: flags.requires, commands: flags.checks };
  if (flags.json) {
    const ol = console.log, oi = console.info;
    console.log = () => {}; console.info = () => {};
    runAutoReview(opts).then((res) => {
      console.log = ol; console.info = oi;
      process.stdout.write(JSON.stringify({
        ok: Boolean(res.success),
        exitCode: res.exitCode,
        root: resolve(flags.root),
        total: res.reasons.length,
        problems: res.reasons.map((r) => ({ message: r })),
        report: res.report || "",
        status: res.status,
        checks: res.checks,
      }, null, 2) + "\n");
      process.exitCode = res.exitCode;
    }).catch((err) => {
      console.log = ol; console.info = oi;
      process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }) + "\n");
      process.exitCode = 2;
    });
  } else {
    runAutoReview(opts).then((res) => {
      process.exitCode = res.exitCode;
    }).catch((err) => {
      console.error("Ошибка выполнения auto-review:", err);
      process.exitCode = 2;
    });
  }
}
