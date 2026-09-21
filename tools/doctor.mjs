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
 *   prompt-baseline · configs · orphan-files · agents-drift ·
 *   provider-reachability (только с --probe).
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

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPruneCandidates } from "./sync-prune.mjs";
import { cleanYamlValue, parseModelsYaml, probeProvider } from "./oracle-model.mjs";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CORE_TOOLS = [
  "workflow.mjs",
  "prompt-lint.mjs",
  "skills-doctor.mjs",
  "glossary.mjs",
  "replay.mjs",
  "codemap.mjs",
  "return-contract.mjs",
  "cache-policy.mjs",
  "cache-doctor.mjs",
  "context-inbox.mjs",
  "domain-context.mjs",
  "oracle-model.mjs",
  "debt-ledger.mjs",
  "benchmark.mjs",
  "usage-audit.mjs",
  "test-lens.mjs",
  "auto-review.mjs",
  "doctor.mjs",
  "sync-prune.mjs",
  "memory-cadence.mjs",
  "audit.ps1",
  "sync.ps1",
];

/**
 * Обязательный набор определений ролей в `agent/agents` (имена файлов без `.md`).
 * `sonic` намеренно отсутствует: это наш сужающий форк (mechanical-only), он опционален.
 * Число файлов не проверяется сознательно — важно, что обязательные роли на месте,
 * иначе удаление или переименование роли проходит незамеченным за «>= 8».
 */
export const REQUIRED_ROLES = [
  "orchestrator",
  "fixer",
  "designer",
  "oracle",
  "librarian",
  "explorer",
  "reviewer",
];

export function normalizePath(p) {
  if (!p) return "";
  return resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}
export function stripBom(text) {
  if (typeof text !== "string") return text;
  return text.replace(/^\uFEFF/, "");
}

/** Маркеры, отличающие репозиторий от живого харнесса (см. sync.ps1 Resolve-RepoRoot). */
const REPO_MARKERS = ["install.ps1", join("agent", "models.yml.example")];

/** true — каталог является дистрибутивным репозиторием (а не живым харнессом). */
export function isRepoTree(dir) {
  return REPO_MARKERS.every((marker) => existsSync(join(dir, marker)));
}

/** Клон репозитория внутри харнесса (`<harness>/workflow-repo`) — цель сравнения для orphan-files. */
export function discoverRepoClone(harness) {
  const candidate = join(harness, "workflow-repo");
  return isRepoTree(candidate) ? candidate : null;
}

/** Имена определений ролей (`*.md` без расширения) в каталоге; `[]`, если каталога нет. */
export function roleNamesIn(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Обязательные роли, которых нет в наборе имён (пустой массив — набор полон). */
export function missingRequiredRoles(names) {
  return REQUIRED_ROLES.filter((role) => !names.includes(role));
}

/** Сравнение текстов определений: BOM и переводы строк не считаются различием. */
function normalizeDef(text) {
  return stripBom(text).replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Дрейф наших определений ролей относительно встроенных агентов OMP.
 * @returns {{forks: string[], drift: string[], matched: string[]}} имена файлов (`role.md`)
 */
export function compareAgentDefs(agentsDir, builtinDir) {
  const forks = [];
  const drift = [];
  const matched = [];

  for (const name of readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
    const builtinPath = join(builtinDir, name);
    const bucket = !existsSync(builtinPath)
      ? forks
      : normalizeDef(readFileSync(join(agentsDir, name), "utf8")) ===
          normalizeDef(readFileSync(builtinPath, "utf8"))
        ? matched
        : drift;
    bucket.push(name);
  }

  return { forks, drift, matched };
}

/**
 * Распаковка встроенных агентов OMP во временный каталог (`omp agents unpack`).
 * @returns {{dir: string|null, error: string|null}} каталог вызывающий обязан удалить.
 */
export function unpackBuiltinAgents() {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "omp-builtin-agents-"));
  } catch (err) {
    return { dir: null, error: `временный каталог не создан: ${err.message}` };
  }

  // На Windows `omp` — это .cmd-шим, а Node ≥ 18.20 запускает .cmd только через shell;
  // shell не квотирует аргументы сам, поэтому путь к временному каталогу квотируем явно.
  const viaShell = process.platform === "win32";
  const targetDir = viaShell ? `"${dir}"` : dir;
  const res = spawnSync("omp", ["agents", "unpack", "--dir", targetDir, "--json"], {
    encoding: "utf8",
    shell: viaShell,
  });

  const failure = res.error
    ? res.error.message
    : res.status !== 0
      ? `код ${res.status}: ${(res.stderr || res.stdout || "").trim().split(/\r?\n/).pop() || "нет вывода"}`
      : null;

  if (failure || readdirSync(dir).filter((f) => f.endsWith(".md")).length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { dir: null, error: failure || "omp не записал ни одного агента" };
  }

  return { dir, error: null };
}

/** Провайдер модели вида `provider/model:tag` → `provider`; без разделителя — null. */
function providerOfModel(model) {
  if (!model || !model.includes("/")) return null;
  return model.slice(0, model.indexOf("/"));
}

/**
 * Роли модели из config.yml: секция `modelRoles:` и `task.agentModelOverrides:`.
 * @returns {Array<{role: string, section: string, model: string}>}
 */
export function parseRoleModels(configContent) {
  const roles = [];
  if (!configContent) return roles;

  let section = null;
  let inOverrides = false;

  for (const line of stripBom(String(configContent)).split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (topMatch) {
      section = topMatch[1];
      inOverrides = false;
      continue;
    }

    const childMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (childMatch) {
      inOverrides = section === "task" && childMatch[1] === "agentModelOverrides";
      continue;
    }

    if (section === "modelRoles") {
      const m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(\S.*)$/);
      if (m) roles.push({ role: m[1], section: "modelRoles", model: cleanYamlValue(m[2]) });
    } else if (inOverrides) {
      const m = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*(\S.*)$/);
      if (m) roles.push({ role: m[1], section: "agentModelOverrides", model: cleanYamlValue(m[2]) });
    }
  }

  return roles;
}

/** Список для detail: длинные перечни обрезаются, чтобы отчёт оставался читаемым. */
function summarizeList(items, limit = 8) {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} … (+${items.length - limit})`;
}

/** Хвост вывода команды для detail: последние непустые строки, обрезанные по длине. */
function tailOf(text, lines = 2, limit = 300) {
  const tail = (text || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join(" ");
  return tail.length > limit ? `${tail.slice(0, limit)}…` : tail;
}

/**
 * Запуск `omp <args>` с таймаутом: плагины — аддон к харнессу, поэтому отказ
 * команды возвращается результатом, а не исключением. Аргументы — фиксированные
 * литералы вызывающего (`plugin list --json`, `plugin doctor`): shell не квотирует
 * их сам, а `^` в диапазоне версии им бы съелся. `options.runOmp` — инъекция для
 * тестов (как `builtinAgentsDir`), чтобы не звать реальный CLI.
 */
export function runOmp(args, { timeout = 60000 } = {}) {
  // На Windows `omp` — это .cmd-шим, а Node ≥ 18.20 запускает .cmd только через
  // shell (та же причина, что в unpackBuiltinAgents).
  const res = spawnSync("omp", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout,
  });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error || null,
  };
}

/** Манифест плагинов `agent/plugins.json` → `[{name, spec}]`; без `spec` берётся имя. */
function readPluginsManifest(path) {
  const parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
  const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
  return list
    .filter((p) => p && typeof p.name === "string" && p.name)
    .map((p) => ({ name: p.name, spec: typeof p.spec === "string" && p.spec ? p.spec : p.name }));
}

/** Имена установленных плагинов из вывода `omp plugin list --json`. */
function installedPluginNames(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed?.npm)) throw new Error("в выводе нет массива npm");
  return parsed.npm.map((p) => p && p.name).filter((n) => typeof n === "string" && n);
}

/** Причина WARN по результату `omp plugin doctor`; пустая строка — чисто. */
function ompHealthNote(res) {
  if (res.error) {
    return res.error.code === "ETIMEDOUT"
      ? "omp plugin doctor: таймаут (>60с)"
      : `omp plugin doctor не запущен (${res.error.message})`;
  }
  if (res.status !== 0) {
    const tail = tailOf(res.stderr || res.stdout);
    return `omp plugin doctor завершился с кодом ${res.status}${tail ? `: ${tail}` : ""}`;
  }
  return "";
}

/**
 * Хвост detail для provider-reachability: роли, чьи провайдеры не описаны в models.yml
 * (проверить их нечем — это не WARN, но и не «доступно»), плюс заметки опроса.
 */
function unprobedNote(unprobedRoles, notes = []) {
  const parts = [];
  if (unprobedRoles.length > 0) {
    const byProvider = new Map();
    for (const r of unprobedRoles) {
      const provider = providerOfModel(r.model);
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(r.role);
    }
    const groups = [...byProvider].map(([provider, roleNames]) => `${provider} (${roleNames.join(", ")})`);
    parts.push(`роли вне models.yml не проверялись: ${summarizeList(groups)}`);
  }
  for (const note of notes) parts.push(note);
  return parts.length > 0 ? `. ${parts.join("; ")}` : "";
}

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
  let harness = null;
  let agentDir = null;
  let agentsHome = null;
  let mode = null;
  let json = false;
  let quiet = false;
  let probe = false;
  let requirePlugins = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--harness") {
      harness = args[++i];
    } else if (arg === "--agent-dir") {
      agentDir = args[++i];
    } else if (arg === "--agents-home") {
      agentsHome = args[++i];
    } else if (arg === "--mode") {
      mode = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--probe") {
      probe = true;
    } else if (arg === "--require-plugins") {
      requirePlugins = true;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
  }

  const defaultHarness = resolve(__dirname, "..");
  const home = homedir();
  const defaultAgentDir = join(home, ".omp", "agent");
  const defaultAgentsHome = join(home, ".agents");
  return {
    harness: harness ? resolve(harness) : defaultHarness,
    agentDir: agentDir ? resolve(agentDir) : defaultAgentDir,
    agentsHome: agentsHome ? resolve(agentsHome) : defaultAgentsHome,
    mode,
    json,
    quiet,
    probe,
    requirePlugins,
    help: false,
  };
}

export function runDoctor(options) {
  const { harness, agentDir, agentsHome, mode: requestedMode } = options;
  // Результат сетевого опроса приходит из main() (--probe); без него проверки нет.
  const probeResults = options.probeResults || null;

  const harnessRootFile = join(agentDir, ".harness-root");
  let hasHarnessRoot = false;
  let harnessRootMatches = false;
  let harnessRootTarget = "";

  if (existsSync(harnessRootFile)) {
    hasHarnessRoot = true;
    try {
      harnessRootTarget = stripBom(readFileSync(harnessRootFile, "utf8")).trim();
      harnessRootMatches = normalizePath(harnessRootTarget) === normalizePath(harness);
    } catch {
      harnessRootMatches = false;
    }
  }

  const isInstalledDetected = hasHarnessRoot && harnessRootMatches;
  const mode = requestedMode || (isInstalledDetected ? "installed" : "repo");
  const checks = [];

  // 1. check 'node': version >= 18
  {
    const id = "node";
    const majorVersion = parseInt(process.versions.node.split(".")[0], 10);
    if (majorVersion >= 18) {
      checks.push({
        id,
        status: "pass",
        detail: `Node.js v${process.versions.node} (>= 18)`,
      });
    } else {
      checks.push({
        id,
        status: "fail",
        detail: `Node.js v${process.versions.node} устарел (требуется >= 18)`,
      });
    }
  }

  // 2. check 'harness-files'
  {
    const id = "harness-files";
    const missing = [];

    const agentsMd = join(harness, "agent", "AGENTS.md");
    if (!existsSync(agentsMd)) missing.push("agent/AGENTS.md");

    const agentsDir = join(harness, "agent", "agents");
    const roleNames = roleNamesIn(agentsDir);
    for (const role of missingRequiredRoles(roleNames)) {
      missing.push(`agent/agents/${role}.md (обязательная роль)`);
    }

    const edFile = join(harness, "rules", "enterprise-directives.md");
    if (!existsSync(edFile)) missing.push("rules/enterprise-directives.md");

    const portableFile = join(harness, "core", "PORTABLE.md");
    if (!existsSync(portableFile)) missing.push("core/PORTABLE.md");

    const contextMd = join(harness, "CONTEXT.md");
    if (!existsSync(contextMd)) missing.push("CONTEXT.md");

    const readmeMd = join(harness, "README.md");
    if (!existsSync(readmeMd)) missing.push("README.md");

    const templatesDir = join(harness, "templates");
    if (!existsSync(templatesDir)) missing.push("templates/");

    const paseoDir = join(harness, "paseo");
    if (!existsSync(paseoDir)) missing.push("paseo/");

    if (missing.length === 0) {
      checks.push({
        id,
        status: "pass",
        detail: `Все обязательные файлы и директории харнесса присутствуют (обязательные роли: ${REQUIRED_ROLES.length}, всего определений: ${roleNames.length})`,
      });
    } else {
      checks.push({
        id,
        status: "fail",
        detail: `Отсутствуют обязательные файлы харнесса: ${missing.join(", ")}`,
      });
    }
  }

  // 3. check 'tools-syntax': core set present and node --check on all tools/*.mjs
  {
    const id = "tools-syntax";
    const toolsDir = join(harness, "tools");
    const missingCore = [];
    const syntaxErrors = [];

    for (const file of CORE_TOOLS) {
      const full = join(toolsDir, file);
      if (!existsSync(full)) {
        missingCore.push(file);
      }
    }

    if (existsSync(toolsDir)) {
      let mjsFiles = [];
      try {
        mjsFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".mjs"));
      } catch {
        mjsFiles = [];
      }

      for (const mjs of mjsFiles) {
        const fullPath = join(toolsDir, mjs);
        const res = spawnSync(process.execPath, ["--check", fullPath], {
          encoding: "utf8",
        });
        if (res.status !== 0) {
          syntaxErrors.push(mjs);
        }
      }
    } else {
      missingCore.push("tools/ directory missing");
    }

    if (missingCore.length > 0 || syntaxErrors.length > 0) {
      const details = [];
      if (missingCore.length > 0) {
        details.push(`отсутствуют обязательные инструменты: ${missingCore.join(", ")}`);
      }
      if (syntaxErrors.length > 0) {
        details.push(`синтаксические ошибки в: ${syntaxErrors.join(", ")}`);
      }
      checks.push({
        id,
        status: "fail",
        detail: details.join("; "),
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: `Все инструменты ядра присутствуют, синтаксис проверен (node --check)`,
      });
    }
  }

  // 4. check 'tools-smoke': prompt-lint fingerprint, debt-ledger scan
  {
    const id = "tools-smoke";
    const promptLintPath = join(harness, "tools", "prompt-lint.mjs");
    const debtLedgerPath = join(harness, "tools", "debt-ledger.mjs");
    const smokeErrors = [];

    if (existsSync(promptLintPath)) {
      const pLintRes = spawnSync(
        process.execPath,
        [promptLintPath, "fingerprint", "--root", harness],
        { encoding: "utf8" }
      );
      if (pLintRes.status !== 0) {
        smokeErrors.push(`prompt-lint fingerprint завершился с кодом ${pLintRes.status}`);
      }
    } else {
      smokeErrors.push("prompt-lint.mjs не найден для smoke-теста");
    }

    if (existsSync(debtLedgerPath)) {
      const tmpTestDir = mkdtempSync(join(tmpdir(), "doctor-smoke-"));
      try {
        const dLedgerRes = spawnSync(
          process.execPath,
          [debtLedgerPath, "scan", "--root", tmpTestDir],
          { encoding: "utf8" }
        );
        if (dLedgerRes.status !== 0) {
          smokeErrors.push(`debt-ledger scan завершился с кодом ${dLedgerRes.status}`);
        }
      } catch (err) {
        smokeErrors.push(`debt-ledger scan упал: ${err.message}`);
      } finally {
        try {
          rmSync(tmpTestDir, { recursive: true, force: true });
        } catch {}
      }
    } else {
      smokeErrors.push("debt-ledger.mjs не найден для smoke-теста");
    }

    if (smokeErrors.length > 0) {
      checks.push({
        id,
        status: "fail",
        detail: smokeErrors.join("; "),
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: "Smoke-тесты пройдены: prompt-lint fingerprint и debt-ledger scan успешны",
      });
    }
  }

  // 5. check 'agent-wiring'
  {
    const id = "agent-wiring";
    if (mode === "repo") {
      const note = !hasHarnessRoot
        ? "Режим repo: агентская директория не настроена (.harness-root отсутствует)"
        : `Режим repo: агентская директория привязана к другому харнессу (${harnessRootTarget})`;
      checks.push({
        id,
        status: "warn",
        detail: note,
      });
    } else {
      const wiringErrors = [];
      const agentsMd = join(agentDir, "AGENTS.md");
      if (!existsSync(agentsMd)) {
        wiringErrors.push(`${agentDir}/AGENTS.md отсутствует`);
      } else {
        try {
          const agentsText = stripBom(readFileSync(agentsMd, "utf8"));
          const normHarness = normalizePath(harness);
          const containsHarness =
            agentsText.includes(harness) ||
            agentsText.toLowerCase().includes(normHarness) ||
            agentsText.replace(/\\/g, "/").toLowerCase().includes(normHarness);
          if (!containsHarness) {
            wiringErrors.push(`${agentDir}/AGENTS.md не содержит путь к харнессу`);
          }
        } catch (e) {
          wiringErrors.push(`ошибка чтения ${agentDir}/AGENTS.md: ${e.message}`);
        }
      }

      if (!harnessRootMatches) {
        wiringErrors.push(`.harness-root (${harnessRootTarget}) не совпадает с харнессом (${harness})`);
      }

      const agentsSub = join(agentDir, "agents");
      const installedRoles = roleNamesIn(agentsSub);
      const missingRoles = missingRequiredRoles(installedRoles);
      if (missingRoles.length > 0) {
        wiringErrors.push(
          `${agentDir}/agents: отсутствуют обязательные роли (${summarizeList(missingRoles)})`
        );
      }

      const agentEd = join(agentDir, "rules", "enterprise-directives.md");
      if (!existsSync(agentEd)) {
        wiringErrors.push(`${agentDir}/rules/enterprise-directives.md отсутствует`);
      }

      const homeEd = join(agentsHome, "rules", "enterprise-directives.md");
      if (!existsSync(homeEd)) {
        wiringErrors.push(`${agentsHome}/rules/enterprise-directives.md отсутствует`);
      }

      if (wiringErrors.length > 0) {
        checks.push({
          id,
          status: "fail",
          detail: wiringErrors.join("; "),
        });
      } else {
        checks.push({
          id,
          status: "pass",
          detail: `Проводка агента корректна (${installedRoles.length} определений ролей, обязательный набор полон; правила и AGENTS.md проверены)`,
        });
      }
    }
  }

  // 6. check 'skills' (spawn skills-doctor.mjs)
  {
    const id = "skills";
    const skillsDoctorPath = join(harness, "tools", "skills-doctor.mjs");
    const installedSkills = join(agentsHome, "skills");
    const candidateRepoSkills = [
      join(harness, "workflow-repo", "skills"),
      join(harness, "skills"),
    ];
    const repoSkills = candidateRepoSkills.find((p) => existsSync(p)) || join(harness, "skills");

    if (!existsSync(skillsDoctorPath)) {
      checks.push({
        id,
        status: "fail",
        detail: "tools/skills-doctor.mjs не найден",
      });
    } else if (!existsSync(installedSkills)) {
      if (mode === "repo") {
        checks.push({
          id,
          status: "warn",
          detail: `Режим repo: установленная папка навыков не найдена (${installedSkills})`,
        });
      } else {
        checks.push({
          id,
          status: "fail",
          detail: `Установленная папка навыков не найдена (${installedSkills})`,
        });
      }
    } else {
      const res = spawnSync(
        process.execPath,
        [skillsDoctorPath, "--installed", installedSkills, "--repo", repoSkills],
        { encoding: "utf8" }
      );
      const out = (res.stdout || "") + (res.stderr || "");
      const match = /(\d+)\s+installed,\s+(\d+)\s+in repo/i.exec(out);
      const countsNote = match ? ` (${match[1]} установлено, ${match[2]} в репозитории)` : "";

      if (res.status === 0) {
        checks.push({
          id,
          status: "pass",
          detail: `Все проверки навыков пройдены${countsNote}`,
        });
      } else {
        // Parse individual problem lines: format from skills-doctor:
        //   <skill_name>  <kind>  <detail>
        // e.g. "    banner-design                parity  installed copy differs from repo..."
        const lines = out.split("\n");
        const parsedProblems = [];
        const problemRegex = /^\s{2,}(\S+)\s+(parity|truncation|frontmatter|orphan|duplicate-name|encoding)\s+(.*)$/;
        for (const line of lines) {
          const pMatch = problemRegex.exec(line);
          if (pMatch) {
            parsedProblems.push({
              skill: pMatch[1],
              kind: pMatch[2],
              detail: pMatch[3].trim(),
            });
          }
        }

        if (parsedProblems.length === 0) {
          // No structured problems parsed -> fail with tail of output
          const tail = out.trim().split("\n").slice(-3).join(" ").trim() || `код ${res.status}`;
          checks.push({
            id,
            status: "fail",
            detail: `skills-doctor завершился с кодом ${res.status}${countsNote}: ${tail}`,
          });
        } else {
          const parityProblems = parsedProblems.filter((p) => p.kind === "parity");
          const failProblems = parsedProblems.filter((p) => p.kind !== "parity");

          if (failProblems.length > 0) {
            const failSummary = failProblems.map((p) => `${p.skill} (${p.kind}: ${p.detail})`).join("; ");
            checks.push({
              id,
              status: "fail",
              detail: `Обнаружены дефекты навыков${countsNote}: ${failSummary}`,
            });
          } else {
            // Only parity issues exist -> WARN
            checks.push({
              id,
              status: "warn",
              detail: `${parityProblems.length} parity (marketplace-managed drift is expected)${countsNote}`,
            });
          }
        }
      }
    }
  }

  // 7. check 'prompt-baseline': .prompt-lint/baseline.json exists AND prompt-lint check --root <harness> exit 0
  {
    const id = "prompt-baseline";
    const baselineFile = join(harness, ".prompt-lint", "baseline.json");
    if (!existsSync(baselineFile)) {
      checks.push({
        id,
        status: "warn",
        detail: "Файл .prompt-lint/baseline.json отсутствует (рекомендуется создать через baseline)",
      });
    } else {
      const promptLintPath = join(harness, "tools", "prompt-lint.mjs");
      if (!existsSync(promptLintPath)) {
        checks.push({
          id,
          status: "fail",
          detail: "tools/prompt-lint.mjs не найден для проверки baseline",
        });
      } else {
        const res = spawnSync(
          process.execPath,
          [promptLintPath, "check", "--root", harness],
          { encoding: "utf8" }
        );
        if (res.status === 0) {
          checks.push({
            id,
            status: "pass",
            detail: "Бейзлайн промптов актуален (дрейф не обнаружен)",
          });
        } else {
          // Check if baseline drift occurred
          checks.push({
            id,
            status: "warn",
            detail: `Обнаружен дрейф поверхностей промптов от бейзлайна (код ${res.status})`,
          });
        }
      }
    }
  }

  // 8. check 'configs': if mcp.json/models.yml/config.yml exist in agent-dir: mcp.json parse; NEVER print values
  {
    const id = "configs";
    const reported = [];
    let configError = null;

    const mcpJson = join(agentDir, "mcp.json");
    if (existsSync(mcpJson)) {
      try {
        const content = stripBom(readFileSync(mcpJson, "utf8"));
        JSON.parse(content);
        reported.push("mcp.json (валидный JSON)");
      } catch (err) {
        configError = `mcp.json не является валидным JSON: ${err.message}`;
      }
    }

    const modelsYml = join(agentDir, "models.yml");
    if (existsSync(modelsYml)) {
      reported.push("models.yml (присутствует)");
    }

    const configYml = join(agentDir, "config.yml");
    if (existsSync(configYml)) {
      reported.push("config.yml (присутствует)");
    }

    if (configError) {
      checks.push({
        id,
        status: "fail",
        detail: configError,
      });
    } else if (reported.length > 0) {
      checks.push({
        id,
        status: "pass",
        detail: `Конфигурационные файлы: ${reported.join(", ")}`,
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: "Конфигурационные файлы в agent-dir отсутствуют (не настроены)",
      });
    }
  }

  // 9. check 'plugins': манифест `agent/plugins.json` против `omp plugin list --json`.
  // Нет манифеста — плагины не заявлены, проверять нечего (pass). Нет `omp` или
  // список не разобран — WARN с причиной: харнесс без плагинов остаётся рабочим.
  // Недостающие плагины — тоже WARN, и только `--require-plugins` делает их FAIL.
  {
    const id = "plugins";
    const manifestPath = join(harness, "agent", "plugins.json");
    const omp = options.runOmp || runOmp;

    let declared = null;
    let manifestError = null;
    if (!existsSync(manifestPath)) {
      checks.push({
        id,
        status: "pass",
        detail: "Манифест плагинов отсутствует (agent/plugins.json): заявленных плагинов нет",
      });
    } else {
      try {
        declared = readPluginsManifest(manifestPath);
      } catch (err) {
        manifestError = err.message;
      }

      if (manifestError) {
        checks.push({
          id,
          status: "warn",
          detail: `Манифест плагинов не прочитан (${manifestPath}): ${manifestError}`,
        });
      } else if (declared.length === 0) {
        checks.push({
          id,
          status: "pass",
          detail: "Манифест плагинов пуст: устанавливать нечего",
        });
      } else {
        const listed = omp(["plugin", "list", "--json"]);
        let installed = null;
        let listError = null;

        if (listed.error) {
          listError = listed.error.code === "ETIMEDOUT" ? "таймаут команды" : `omp не запущен (${listed.error.message})`;
        } else if (listed.status !== 0) {
          const tail = tailOf(listed.stderr || listed.stdout);
          const absent = /not recognized|не является внутренней|command not found|no such file/i.test(listed.stderr || "");
          listError = absent
            ? "omp не найден в PATH"
            : `omp plugin list завершился с кодом ${listed.status}${tail ? `: ${tail}` : ""}`;
        } else {
          try {
            installed = installedPluginNames(listed.stdout);
          } catch (err) {
            listError = `вывод omp plugin list не разобран: ${err.message}`;
          }
        }

        if (listError) {
          checks.push({
            id,
            status: "warn",
            detail: `Не удалось получить список установленных плагинов: ${listError}. Проверьте вручную: omp plugin list --json`,
          });
        } else {
          const missing = declared.filter((p) => !installed.includes(p.name));
          const extra = installed.filter((n) => !declared.some((p) => p.name === n));

          let status = "pass";
          let detail = `${declared.length}/${declared.length} плагинов установлено`;
          if (missing.length > 0) {
            status = options.requirePlugins ? "fail" : "warn";
            const hints = summarizeList(missing.map((p) => `omp plugin install ${p.spec}`));
            detail = `Не установлены плагины (${missing.length} из ${declared.length}): ${summarizeList(missing.map((p) => p.name))}. Установить: ${hints}`;
          }
          if (extra.length > 0) {
            detail += ` Установлены сверх манифеста (${extra.length}): ${summarizeList(extra)}`;
          }

          // Необязательный health-чек самих плагинов: его ненулевой код — WARN
          // с хвостом вывода, но никогда не FAIL (и не запускается, если `omp`
          // уже не ответил выше — иначе одна причина дала бы два предупреждения).
          const healthNote = ompHealthNote(omp(["plugin", "doctor"]));
          if (healthNote) {
            detail += ` ${healthNote}`;
            if (status === "pass") status = "warn";
          }

          checks.push({ id, status, detail });
        }
      }
    }
  }

  // 10. check 'orphan-files': файлы каталогов манифеста, которых нет в репозитории.
  // tools/ → FAIL (инструмент вне дистрибутива ломает установку у других),
  // прочие каталоги → WARN. Область обхода общая с `sync.ps1 -Prune` (sync-prune.mjs).
  {
    const id = "orphan-files";
    if (isRepoTree(harness)) {
      checks.push({
        id,
        status: "skip",
        detail: "Харнесс является дистрибутивным репозиторием: файлов вне репозитория быть не может",
      });
    } else {
      const repoClone = discoverRepoClone(harness);
      if (!repoClone) {
        checks.push({
          id,
          status: "skip",
          detail: `Клон репозитория не обнаружен (${join(harness, "workflow-repo")}): сравнение не выполняется`,
        });
      } else {
        let orphans = [];
        let readError = null;
        try {
          orphans = findPruneCandidates({ harness, repo: repoClone });
        } catch (err) {
          readError = err.message;
        }

        if (readError) {
          checks.push({
            id,
            status: "warn",
            detail: `Не удалось сравнить харнесс с репозиторием: ${readError}`,
          });
        } else if (orphans.length === 0) {
          checks.push({
            id,
            status: "pass",
            detail: `Все файлы каталогов манифеста присутствуют в репозитории (${repoClone})`,
          });
        } else {
          const toolOrphans = orphans.filter((rel) => rel.startsWith("tools/"));
          const otherOrphans = orphans.filter((rel) => !rel.startsWith("tools/"));
          const severity = toolOrphans.length > 0 ? "fail" : "warn";
          const parts = [];
          if (toolOrphans.length > 0) {
            parts.push(`tools/ (${toolOrphans.length}): ${summarizeList(toolOrphans)}`);
          }
          if (otherOrphans.length > 0) {
            parts.push(`прочие (${otherOrphans.length}): ${summarizeList(otherOrphans)}`);
          }
          checks.push({
            id,
            status: severity,
            detail: `${orphans.length} файл(ов) харнесса отсутствуют в репозитории — ${parts.join("; ")}`,
          });
        }
      }
    }
  }

  // 11. check 'agents-drift': наши определения ролей против встроенных агентов OMP.
  // Нет встроенного с таким именем → fork (наш собственный агент, часть pass);
  // имя есть, содержимое разошлось → drift (WARN, имена перечисляются);
  // тексты совпали → ок. Никогда не FAIL: расхождение бывает намеренным (форки,
  // сужающие встроенную роль), а сам `omp` может отсутствовать.
  {
    const id = "agents-drift";
    const agentsDir = join(harness, "agent", "agents");
    const roleNames = roleNamesIn(agentsDir);

    let builtinDir = null;
    let tempDir = null;
    let skipReason = null;

    if (roleNames.length === 0) {
      skipReason = `сравнивать нечего: каталог ${agentsDir} пуст или отсутствует`;
    } else if (options.builtinAgentsDir) {
      if (existsSync(options.builtinAgentsDir)) {
        builtinDir = options.builtinAgentsDir;
      } else {
        skipReason = `каталог встроенных агентов не найден (${options.builtinAgentsDir}): сравнение не выполнялось`;
      }
    } else {
      const unpacked = unpackBuiltinAgents();
      if (unpacked.dir) {
        builtinDir = unpacked.dir;
        tempDir = unpacked.dir;
      } else {
        skipReason = `omp agents unpack недоступен (${unpacked.error}): сравнение не выполнялось`;
      }
    }

    try {
      if (!builtinDir) {
        checks.push({ id, status: "skip", detail: skipReason });
      } else {
        const { forks, drift, matched } = compareAgentDefs(agentsDir, builtinDir);
        const forkNote =
          forks.length > 0
            ? `. Наши агенты без встроенного аналога (${forks.length}): ${summarizeList(forks)}`
            : "";

        if (drift.length > 0) {
          checks.push({
            id,
            status: "warn",
            detail: `Дрейф от встроенных агентов OMP (${drift.length}): ${summarizeList(drift)} — наш файл перекрывает встроенного (first-wins)${forkNote}`,
          });
        } else {
          checks.push({
            id,
            status: "pass",
            detail: `Определения ролей не разошлись со встроенными OMP (совпало: ${matched.length}, форков: ${forks.length})${forkNote}`,
          });
        }
      }
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // 12. check 'provider-reachability' (только с --probe): сети и отчёта без флага нет.
  if (probeResults) {
    const id = "provider-reachability";
    const configYml = join(agentDir, "config.yml");
    const providerNames = Object.keys(probeResults.providers);
    const unreachable = providerNames.filter((n) => probeResults.providers[n].reachable === false);

    if (!existsSync(configYml)) {
      checks.push({
        id,
        status: "skip",
        detail: `config.yml не найден (${configYml}): роли не сопоставлялись с провайдерами`,
      });
    } else {
      let roles = [];
      try {
        roles = parseRoleModels(readFileSync(configYml, "utf8"));
      } catch (err) {
        roles = [];
        checks.push({
          id,
          status: "warn",
          detail: `config.yml не прочитан (${err.message}): роли не сопоставлялись с провайдерами`,
        });
      }

      const blockedRoles = roles.filter((r) => unreachable.includes(providerOfModel(r.model)));
      const unprobedRoles = roles.filter((r) => {
        const provider = providerOfModel(r.model);
        return provider !== null && !providerNames.includes(provider);
      });

      if (unreachable.length === 0) {
        const reachableList = providerNames.filter((n) => probeResults.providers[n].reachable === true);
        checks.push({
          id,
          status: "pass",
          detail: `Провайдеры отвечают (${reachableList.length > 0 ? reachableList.join(", ") : "нет настроенных"})${unprobedNote(unprobedRoles, probeResults.notes)}`,
        });
      } else {
        const unreachableDetail = unreachable
          .map((n) => `${n} (${probeResults.providers[n].error})`)
          .join("; ");
        const rolesDetail =
          blockedRoles.length > 0
            ? blockedRoles.map((r) => `${r.role} [${r.model}]`).join(", ")
            : "нет";
        checks.push({
          id,
          status: "warn",
          detail: `Недостижимые провайдеры: ${unreachableDetail}. Роли, указывающие на их модели: ${rolesDetail}${unprobedNote(unprobedRoles, probeResults.notes)}`,
        });
      }
    }
  }

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
    agentDir,
    requirePlugins: options.requirePlugins === true,
    checks,
    summary,
    ok,
  };
}

export function printHumanReport(result, quiet) {
  const { mode, harness, agentDir, checks, summary, ok } = result;

  if (!quiet) {
    console.log(`\ndoctor: режим=${mode} харнесс=${harness}\nагентская директория=${agentDir}\n`);
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
    console.log(`Использование: node tools/doctor.mjs [--harness <dir>] [--agent-dir <dir>] [--agents-home <dir>] [--json] [--quiet] [--probe] [--require-plugins]

  --probe  опросить провайдеров из models.yml (GET {baseUrl}/models) и сопоставить
           с ролями config.yml; недостижимые дают WARN. Требует сети.
  --require-plugins  отсутствие плагинов из agent/plugins.json делает doctor
           FAIL (по умолчанию это WARN: плагины — аддон, а не условие работы).
  --json   машинный отчёт
  --quiet  только итоговая строка`);
    return 0;
  }

  const probeResults = opts.probe ? await probeProviders(join(opts.agentDir, "models.yml")) : null;
  const result = runDoctor({ ...opts, probeResults });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result, opts.quiet);
  }

  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`doctor: необработанная ошибка: ${err.message}\n`);
      process.exit(2);
    });
}
