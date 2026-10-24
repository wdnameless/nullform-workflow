#!/usr/bin/env node
/**
 * tools/doctor.mjs — Проверка целостности окружения и установки harness.
 *
 * Использование:
 *   node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet] [--probe]
 *
 * Режимы:
 *   installed — когда <agent-dir>/.harness-root существует и указывает на текущий harness.
 *   repo — когда <agent-dir>/.harness-root отсутствует или указывает на другой путь.
 *          В режиме repo проверки agent-dir деградируют до статуса WARN с явным примечанием.
 *
 * Проверки:
 *   node · harness-files · tools-syntax · tools-smoke · agent-wiring · skills ·
 *   prompt-baseline · configs · orphan-files · agents-drift · logs-hygiene ·
 *   release-drift · provider-reachability (только с --probe).
 *
 * agents-drift (без сети):
 *   Распаковывает встроенных агентов OMP (`omp agents unpack` во временный каталог)
 *   и сравнивает с ними каждое наше `agent/agents/*.md`: имя без встроенного аналога —
 *   наш форк (информационно, внутри pass), содержимое разошлось — WARN с именами.
 *   `omp` недоступен — SKIP с причиной. Проверка никогда не даёт FAIL.
 *
 * --probe (opt-in, сеть):
 *   Опрашивает GET {baseUrl}/models у каждого провайдера из models.yml и сопоставляет
 *   роли из config.yml с результатом. Недостижимый провайдер и роли, указывающие на
 *   его модели, дают WARN (никогда FAIL: машина может быть офлайн). Без --probe
 *   сеть не трогается и проверки provider-reachability в отчёте нет.
 *
 * Коды возврата:
 *   0 — ok (fail === 0, допустимы pass, warn, skip)
 *   1 — fail > 0
 *   2 — ошибка запуска / параметров
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseModelsYaml, probeProvider } from "./oracle-model.mjs";
import { inspectHarness, resolveHostHome } from "./installation/profiles.mjs";
import { readInstallationState } from "./installation/state.mjs";
import { loadHostManifest } from "./install-harness.mjs";
import {
  checkNode, checkHarnessFiles, checkToolsSyntax, checkToolsSmoke, checkAgentWiring,
  checkPluginPatches, checkSkills, checkPromptBaseline, checkConfigs, checkPlugins,
  checkOrphanFiles, checkAgentsDrift, checkLogsHygiene, checkProviderReachability,
  checkReleaseDrift, checkVersionHarness, checkNonOmp,
} from "./doctor-checks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export {
  CORE_TOOLS, REQUIRED_ROLES, normalizePath, stripBom, isRepoTree,
  discoverRepoClone, roleNamesIn, missingRequiredRoles, compareAgentDefs,
  unpackBuiltinAgents, parseRoleModels, runOmp,
} from "./doctor-shared.mjs";
import { normalizePath, stripBom } from "./doctor-shared.mjs";


/** Манифест плагинов `agent/plugins.json` → `[{name, spec, required}]`; без `spec` берётся имя. */
/** Ожидаемая версия из spec вида 'package@1.2.3'; null если версия не указана. */

/**
 * Результат `omp plugin list --json` → `{installed, listError}`.
 *
 * OMP 18.3.3+ печатает ПОЛНЫЙ и разбираемый документ и затем выходит с кодом 1:
 * его хук `beforeExit` срабатывает, пока команда ещё не завершилась
 * («the event loop drained while it was still pending»). Код возврата врёт, данные
 * корректны, поэтому валидный список важнее кода. Пустой или неразбираемый вывод,
 * а также `omp`, отсутствующий в PATH, остаются настоящей ошибкой.
 */
/** Причина WARN по результату `omp plugin doctor`; пустая строка — чисто. */
/**
 * Хвост detail для provider-reachability: роли, чьи провайдеры не описаны в models.yml
 * (проверить их нечем — это не WARN, но и не «доступно»), плюс заметки опроса.
 */
/**
 * Опрос провайдеров из models.yml (сеть, opt-in): для каждого провайдера с baseUrl
 * выполняется GET {baseUrl}/models. Ключи в отчёт не попадают.
 *
 * @returns {Promise<{providers: Object<string, {reachable: boolean|null, error: string|null}>, notes: string[]}>}
 */
export async function probeProviders(modelsYamlPath) {
  const providers = {};
  const notes = [];

  if (!existsSync(modelsYamlPath)) {
    return { providers, notes: [`models.yml не найден: ${modelsYamlPath}`] };
  }

  let parsed;
  try {
    parsed = parseModelsYaml(stripBom(readFileSync(modelsYamlPath, "utf8")));
  } catch (err) {
    return { providers, notes: [`models.yml не разобран: ${err.message}`] };
  }

  for (const name of Object.keys(parsed.providers)) {
    const prov = parsed.providers[name];
    if (!prov.baseUrl) {
      providers[name] = { reachable: null, error: "baseUrl не задан" };
      continue;
    }

    const res = await probeProvider(prov);
    providers[name] = { reachable: !res.error, error: res.error || null };
    if (res.error) {
      notes.push(`Провайдер ${name} недостижим: ${res.error}`);
    }
  }

  return { providers, notes };
}


export function parseCliArgs(args) {
  let harness = null, targetHarness = null, projectRoot = null, userHome = null;
  let agentDir = null, agentsHome = null, mode = null, releaseUrl = null;
  let hostHome = null, hostManifest = null;
  let json = false, quiet = false, probe = false, requirePlugins = false;
  let pruneLogs = false, skipPluginCheck = false, skipReleaseCheck = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--harness") harness = args[++i];
    else if (arg.startsWith("--harness=")) harness = arg.slice("--harness=".length);
    else if (arg === "--target-harness") targetHarness = args[++i];
    else if (arg.startsWith("--target-harness=")) targetHarness = arg.slice("--target-harness=".length);
    else if (arg === "--project-root") projectRoot = args[++i];
    else if (arg.startsWith("--project-root=")) projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--user-home") userHome = args[++i];
    else if (arg.startsWith("--user-home=")) userHome = arg.slice("--user-home=".length);
    else if (arg === "--host-home") hostHome = args[++i];
    else if (arg.startsWith("--host-home=")) hostHome = arg.slice("--host-home=".length);
    else if (arg === "--host-manifest") hostManifest = args[++i];
    else if (arg.startsWith("--host-manifest=")) hostManifest = arg.slice("--host-manifest=".length);
    else if (arg === "--agent-dir") agentDir = args[++i];
    else if (arg.startsWith("--agent-dir=")) agentDir = arg.slice("--agent-dir=".length);
    else if (arg === "--agents-home") agentsHome = args[++i];
    else if (arg.startsWith("--agents-home=")) agentsHome = arg.slice("--agents-home=".length);
    else if (arg === "--mode") mode = args[++i];
    else if (arg.startsWith("--mode=")) mode = arg.slice("--mode=".length);
    else if (arg === "--json") json = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--probe") probe = true;
    else if (arg === "--require-plugins") requirePlugins = true;
    else if (arg === "--prune-logs") pruneLogs = true;
    else if (arg === "--skip-plugin-check") skipPluginCheck = true;
    else if (arg === "--release-url") releaseUrl = args[++i];
    else if (arg.startsWith("--release-url=")) releaseUrl = arg.slice("--release-url=".length);
    else if (arg === "--skip-release-check") skipReleaseCheck = true;
  }

  const defaultHarness = resolve(__dirname, "..");
  const home = userHome ? resolve(userHome) : homedir();
  if (probe && targetHarness && targetHarness !== "omp") throw new Error("--probe is inspect-only for adaptive hosts; use nullform inspect --probe");
  return {
    harness: harness ? resolve(harness) : defaultHarness,
    targetHarness: targetHarness || null,
    projectRoot: projectRoot ? resolve(projectRoot) : null,
    userHome: home,
    hostHome: hostHome ? resolve(hostHome) : null,
    hostManifest,
    agentDir: agentDir ? resolve(agentDir) : null,
    agentsHome: agentsHome ? resolve(agentsHome) : join(home, ".agents"),
    mode, json, quiet, probe, requirePlugins, skipPluginCheck, releaseUrl, skipReleaseCheck, pruneLogs, help: false,
  };
}

export function runDoctor(options) {
  const { harness, mode: requestedMode } = options;
  const explicitTargetHarness = Boolean(options.targetHarness || options.harnessName);
  const targetHarness = options.targetHarness || options.harnessName || "omp";
  const userHome = options.userHome ? resolve(options.userHome) : homedir();
  const saved = readInstallationState(userHome);
  const sameSaved = saved?.harness === targetHarness;
  const env = options.env || process.env;
  const selectedHostHome = resolveHostHome({ harness: targetHarness, userHome, hostHome: options.hostHome || (sameSaved ? saved.hostHome : undefined), env }).path;
  const agentDir = options.agentDir
    ? resolve(options.agentDir)
    : targetHarness === "omp"
      ? selectedHostHome
      : null;
  const agentsHome = options.agentsHome
    ? resolve(options.agentsHome)
    : targetHarness === "omp"
      ? join(userHome, ".agents")
      : null;
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : sameSaved ? saved.projectRoot : null;
  const profile = inspectHarness({
    harness: targetHarness, userHome, env, projectRoot,
    hostHome: selectedHostHome,
    hostManifest: loadHostManifest(options.hostManifest || (sameSaved ? saved.hostManifest : undefined), targetHarness),
  });
  const probeResults = options.probeResults || null;
  let hasHarnessRoot = false;
  let harnessRootMatches = false;
  let harnessRootTarget = "";

  if (agentDir) {
    const harnessRootFile = join(agentDir, ".harness-root");
    if (existsSync(harnessRootFile)) {
      hasHarnessRoot = true;
      try {
        harnessRootTarget = stripBom(readFileSync(harnessRootFile, "utf8")).trim();
        harnessRootMatches = normalizePath(harnessRootTarget) === normalizePath(harness);
      } catch {
        harnessRootMatches = false;
      }
    }
  }

  const isInstalledDetected = targetHarness === "omp"
    ? (hasHarnessRoot && harnessRootMatches)
    : (existsSync(harness) && (
        existsSync(join(harness, "VERSION")) ||
        existsSync(join(harness, "AGENTS.md")) ||
        existsSync(join(harness, "CLAUDE.md")) ||
        existsSync(join(harness, "openclaw.json")) ||
        existsSync(join(harness, "config.yaml")) ||
        Boolean(projectRoot && existsSync(join(projectRoot, ".cursor")))
      ));
  const mode = requestedMode || (isInstalledDetected ? "installed" : "repo");
  const checks = [];
  const ctx = {
    checks, harness, agentDir, agentsHome, userHome, projectRoot, profile, env, mode,
    targetHarness, probeResults, hasHarnessRoot, harnessRootMatches, harnessRootTarget,
    explicitTargetHarness, options,
  };
  checkNode(ctx);
  checkHarnessFiles(ctx);
  checkToolsSyntax(ctx);
  checkToolsSmoke(ctx);
  if (targetHarness === "omp") {
    checkAgentWiring(ctx);
    checkPluginPatches(ctx);
    checkSkills(ctx);
    checkPromptBaseline(ctx);
    checkConfigs(ctx);
    checkPlugins(ctx);
    checkOrphanFiles(ctx);
    checkAgentsDrift(ctx);
    checkLogsHygiene(ctx);
    checkProviderReachability(ctx);
  } else {
    checkNonOmp(ctx);
  }
  checkReleaseDrift(ctx);
  checkVersionHarness(ctx);

  // Summary calculation
  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    warn: checks.filter((c) => c.status === "warn").length,
    skip: checks.filter((c) => c.status === "skip").length,
  };

  const ok = summary.fail === 0;

  return {
    mode,
    harness,
    targetHarness,
    ...(profile ? { profile } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(agentDir ? { agentDir } : {}),
    requirePlugins: options.requirePlugins === true,
    checks,
    summary,
    ok,
  };
}

export function printHumanReport(result, quiet) {
  const { mode, harness, agentDir, checks, summary, ok } = result;

  if (!quiet) {
    console.log(`\ndoctor: режим=${mode} харнесс=${harness}\nагентская директория=${agentDir || "не требуется (non-omp)"}\n`);
    for (const c of checks) {
      const tag = c.status.toUpperCase().padEnd(4);
      let symbol = "•";
      if (c.status === "pass") symbol = "✓";
      else if (c.status === "fail") symbol = "✗";
      else if (c.status === "warn") symbol = "⚠";
      else if (c.status === "skip") symbol = "-";

      console.log(`  ${symbol} [${tag}] ${c.id.padEnd(16)} : ${c.detail}`);
    }
    console.log("");
  }

  const summaryStr = `Итог: pass=${summary.pass} fail=${summary.fail} warn=${summary.warn} skip=${summary.skip} -> ${ok ? "OK" : "FAIL"}`;
  console.log(summaryStr);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(`Использование: node tools/doctor.mjs [--harness <dir>] [--target-harness <name>] [--host-home <dir>] [--host-manifest <file>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet] [--probe] [--require-plugins]

  --probe  опросить провайдеров из models.yml (GET {baseUrl}/models) и сопоставить
           с ролями config.yml; недостижимые дают WARN. Требует сети.
  --require-plugins  отсутствие любых (включая опциональные) плагинов из agent/plugins.json
           делает doctor FAIL (по умолчанию обязательные плагины дают FAIL, а опциональные — WARN).
  --json   машинный отчёт
  --quiet  только итоговая строка`);
    return 0;
  }

  const probeResults = opts.probe ? await probeProviders(join(
    opts.agentDir || resolveHostHome({ harness: "omp", userHome: opts.userHome, hostHome: opts.hostHome }).path, "models.yml",
  )) : null;
  let releaseInfo = opts.releaseInfo || null;
  if (!releaseInfo && !opts.skipReleaseCheck && existsSync(join(opts.harness, "VERSION"))) {
    try {
      const { checkRelease } = await import("./self-update.mjs");
      releaseInfo = await checkRelease({
        root: opts.harness,
        apiUrl: opts.releaseUrl || process.env.NULLFORM_RELEASE_URL,
        timeoutMs: 3000,
      });
    } catch (err) {
      releaseInfo = { offline: true, error: err.message };
    }
  }
  const result = runDoctor({ ...opts, probeResults, releaseInfo });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result, opts.quiet);
  }

  return result.ok ? 0 : 1;
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`doctor: необработанная ошибка: ${err.message}\n`);
    process.exitCode = 2;
  });
}
