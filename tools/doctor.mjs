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

import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  "code-size.mjs",
  "auto-review.mjs",
  "doctor.mjs",
  "sync-prune.mjs",
  "memory-cadence.mjs",
  "mutation-test.mjs",
  "gherkin-spec.mjs",
  "dashboard.mjs",
  "fix-plugin-windows.cjs",
  "session_cost.py",
  "verify.mjs",
  "audit.ps1",
  "sync.ps1",
  "sync.mjs",
  "sync-manifest.json",
  "audit.sh",
  "sync.sh",
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
  // массив аргументов вместе с shell даёт DEP0190 в stderr (а install.ps1 читает
  // stderr доктора и падал на этом предупреждении). Собираем одну команду с
  // явным квотированием пути.
  const viaShell = process.platform === "win32";
  const command = viaShell
    ? [quoteShellArg("omp"), "agents", "unpack", "--dir", quoteShellArg(dir), "--json"].join(" ")
    : "omp";
  const res = spawnSync(command, viaShell ? [] : ["agents", "unpack", "--dir", dir, "--json"], {
    encoding: "utf8",
    shell: viaShell,
    windowsHide: true,
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
  // shell (та же причина, что в unpackBuiltinAgents). Массив аргументов вместе
  // с shell даёт DEP0190 в stderr; install.ps1 читает stderr доктора и падал на
  // этом предупреждении после того, как вывод перестал теряться. Поэтому
  // команда собирается в одну строку с явным квотированием.
  const isWin = process.platform === "win32";
  const res = isWin
    ? spawnSync([quoteShellArg("omp"), ...args.map(quoteShellArg)].join(" "), {
        encoding: "utf8",
        shell: true,
        timeout,
        windowsHide: true,
      })
    : spawnSync("omp", args, {
        encoding: "utf8",
        timeout,
        windowsHide: true,
      });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error || null,
  };
}

/** Кавычит аргумент для cmd.exe: пробелы и метасимволы не должны разбираться шеллом. */
function quoteShellArg(value) {
  const text = String(value);
  return /[\s"^&|<>()]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}


/** Манифест плагинов `agent/plugins.json` → `[{name, spec, required}]`; без `spec` берётся имя. */
function readPluginsManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(`Ошибка разбора манифеста: ${e.message}`);
  }
  const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
  return list
    .filter((p) => p && typeof p.name === "string" && p.name)
    .map((p) => ({
      name: p.name,
      spec: typeof p.spec === "string" && p.spec ? p.spec : p.name,
      required: p.required === true,
    }));
}

/** Ожидаемая версия из spec вида 'package@1.2.3'; null если версия не указана. */
function expectedVersionOf(plugin) {
  if (!plugin || typeof plugin.spec !== "string") return null;
  const spec = plugin.spec;
  const lastAt = spec.lastIndexOf("@");
  if (lastAt > 0) {
    return spec.slice(lastAt + 1);
  }
  return null;
}

/** Установленные плагины из вывода `omp plugin list --json` → Map<name, {name, version}>. */
function installedPlugins(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Ошибка разбора JSON: ${e.message}`);
  }
  const map = new Map();
  if (Array.isArray(parsed?.npm)) {
    for (const p of parsed.npm) {
      if (p && typeof p.name === "string" && p.name) {
        map.set(p.name, {
          name: p.name,
          version: typeof p.version === "string" && p.version.trim() ? p.version.trim() : null,
        });
      }
    }
  }
  if (Array.isArray(parsed?.marketplace)) {
    for (const p of parsed.marketplace) {
      if (p) {
        let name = typeof p.name === "string" ? p.name : null;
        let version = typeof p.version === "string" && p.version.trim() ? p.version.trim() : null;
        if (!name && typeof p.id === "string") {
          const lastAt = p.id.lastIndexOf("@");
          if (lastAt > 0) {
            name = p.id.slice(0, lastAt);
            if (!version) version = p.id.slice(lastAt + 1);
          } else {
            name = p.id;
          }
        }
        if (name) {
          map.set(name, { name, version });
        }
      }
    }
  }
  if (map.size === 0 && !Array.isArray(parsed?.npm) && !Array.isArray(parsed?.marketplace)) {
    throw new Error("в выводе нет массива npm или marketplace");
  }
  return map;
}

/**
 * Результат `omp plugin list --json` → `{installed, listError}`.
 *
 * OMP 18.3.3+ печатает ПОЛНЫЙ и разбираемый документ и затем выходит с кодом 1:
 * его хук `beforeExit` срабатывает, пока команда ещё не завершилась
 * («the event loop drained while it was still pending»). Код возврата врёт, данные
 * корректны, поэтому валидный список важнее кода. Пустой или неразбираемый вывод,
 * а также `omp`, отсутствующий в PATH, остаются настоящей ошибкой.
 */
function resolvePluginList(listed) {
  if (listed.error) {
    const timedOut = listed.error.code === "ETIMEDOUT";
    return {
      installed: null,
      listError: timedOut ? "таймаут команды" : `omp не запущен (${listed.error.message})`,
    };
  }

  const absent = /not recognized|не является внутренней|command not found|no such file/i.test(
    listed.stderr || ""
  );
  if (!absent) {
    try {
      return { installed: installedPlugins(listed.stdout), listError: null };
    } catch {
      // fall through to the honest non-zero report below
    }
  }

  if (listed.status === 0) {
    let reason = "неизвестная ошибка разбора";
    try {
      installedPlugins(listed.stdout);
    } catch (err) {
      reason = err.message;
    }
    return { installed: null, listError: `вывод omp plugin list не разобран: ${reason}` };
  }

  const tail = tailOf(listed.stderr || listed.stdout);
  return {
    installed: null,
    listError: absent
      ? "omp не найден в PATH"
      : `omp plugin list завершился с кодом ${listed.status}${tail ? `: ${tail}` : ""}`,
  };
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
  let pruneLogs = false;
  let skipPluginCheck = false;
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
    } else if (arg === "--prune-logs") {
      pruneLogs = true;
    } else if (arg === "--skip-plugin-check") {
      skipPluginCheck = true;
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
    skipPluginCheck,
    pruneLogs,
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
          windowsHide: true,
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
        { encoding: "utf8", windowsHide: true }
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
          { encoding: "utf8", windowsHide: true }
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

  // 5b. check 'plugin-patches': the console-window / EPIPE patches live in
  // node_modules and are LOST on every plugin upgrade. Verifying only that the
  // patcher FILE exists cannot see that: the harness would report healthy while
  // the unpatched plugin crashes the host with an unhandled rejection
  // (OMP: "Cannot call write after a stream was destroyed" -> RPC exit 1).
  {
    const id = "plugin-patches";
    // Derived from the resolved agents home, not homedir(): a sandbox install
    // (`--user-home`) must inspect ITS plugins, and a hardcoded home made the
    // check both wrong for sandboxes and impossible to test.
    const plugRoot = join(dirname(agentsHome), ".omp", "plugins", "node_modules");
    const piLens = join(plugRoot, "pi-lens", "dist", "index.js");
    const fixer = join(harness, "tools", "fix-plugin-windows.cjs");

    if (!existsSync(fixer)) {
      checks.push({ id, status: "fail", detail: "tools/fix-plugin-windows.cjs не найден" });
    } else if (!existsSync(piLens)) {
      checks.push({ id, status: "pass", detail: "pi-lens не установлен: патчить нечего" });
    } else {
      const text = readFileSync(piLens, "utf8");
      // Only the marker proves the patch: vanilla vscode-jsonrpc already contains
      // ERR_STREAM_DESTROYED (5 occurrences), so matching that string would report
      // an unpatched plugin as healthy.
      const guarded = text.includes("patched-epipe-handler");
      if (guarded) {
        checks.push({
          id,
          status: "pass",
          detail: "патчи плагинов применены (pi-lens: EPIPE-глушитель)",
        });
      } else {
        checks.push({
          id,
          status: "warn",
          detail:
            "pi-lens БЕЗ патча: обновление плагина сняло правки — запустите `node tools/fix-plugin-windows.cjs`",
        });
      }
    }
  }

  // 6. check 'skills' (spawn skills-doctor.mjs)
  {
    const id = "skills";
    const skillsDoctorPath = join(harness, "tools", "skills-doctor.mjs");
    const installedSkills = join(agentsHome, "skills");
    let repoSkills = null;
    const repoClone = discoverRepoClone(harness);
    if (repoClone && existsSync(join(repoClone, "skills"))) {
      repoSkills = join(repoClone, "skills");
    } else if ((mode === "repo" || isRepoTree(harness)) && existsSync(join(harness, "skills"))) {
      repoSkills = join(harness, "skills");
    }

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
    } else if (!repoSkills) {
      checks.push({
        id,
        status: "warn",
        detail: "parity не проверялась: нет копии репозитория",
      });
    } else {
      const res = spawnSync(
        process.execPath,
        [skillsDoctorPath, "--installed", installedSkills, "--repo", repoSkills],
        { encoding: "utf8", windowsHide: true }
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
          { encoding: "utf8", windowsHide: true }
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
  // Обязательные плагины (pi-lens, oh-my-pi-plugin-morph) по умолчанию дают FAIL.
  // Опциональные плагины по умолчанию дают WARN, и только `--require-plugins` делает их FAIL.
  {
    const id = "plugins";
    const skippedMarker = join(harness, "agent", "plugins.skipped");
    if (options.skipPluginCheck) {
      checks.push({
        id,
        status: "skip",
        detail: "Проверка плагинов пропущена (--skip-plugin-check)",
      });
    } else if (existsSync(skippedMarker)) {
      checks.push({
        id,
        status: "skip",
        detail: "плагины пропущены при установке (-SkipPlugins); установите и повторите",
      });
    } else {
      const manifestPath = join(harness, "agent", "plugins.json");
      const omp = options.runOmp || runOmp;

      let declared = null;
      let manifestError = null;
      if (!existsSync(manifestPath)) {
        checks.push({
          id,
          status: "fail",
          detail: "Манифест плагинов отсутствует (agent/plugins.json): требуемые плагины не определены",
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
          status: "fail",
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
        const { installed, listError } = resolvePluginList(listed);

        if (listError) {
          checks.push({
            id,
            status: "fail",
            detail: `Не удалось проверить установку плагинов: ${listError}. Проверьте вручную: omp plugin list --json`,
          });
        } else {
          const missing = declared.filter((p) => !installed.has(p.name));
          const extra = [...installed.keys()].filter((n) => !declared.some((p) => p.name === n));

          const versionMismatches = [];
          for (const p of declared) {
            if (installed.has(p.name)) {
              const inst = installed.get(p.name);
              const exp = expectedVersionOf(p);
              if (exp) {
                const instVersion = inst?.version || null;
                if (!instVersion || instVersion !== exp) {
                  versionMismatches.push({
                    name: p.name,
                    expected: exp,
                    installed: instVersion || "неизвестно",
                    required: p.required,
                    spec: p.spec,
                  });
                }
              }
            }
          }

          const missingRequired = missing.filter((p) => p.required);
          const missingOptional = missing.filter((p) => !p.required);
          const mismatchedRequired = versionMismatches.filter((m) => m.required);
          const mismatchedOptional = versionMismatches.filter((m) => !m.required);

          let status = "pass";
          let detail = `${declared.length}/${declared.length} плагинов установлено`;

          const parts = [];
          if (missingRequired.length > 0) {
            const reqHints = summarizeList(missingRequired.map((p) => `omp plugin install ${p.spec}`));
            parts.push(`Не установлены обязательные плагины (${missingRequired.length}): ${summarizeList(missingRequired.map((p) => p.name))}. Установить: ${reqHints}`);
          }
          if (mismatchedRequired.length > 0) {
            const vHints = summarizeList(mismatchedRequired.map((m) => `${m.name} (${m.installed} != ${m.expected})`));
            const installHints = summarizeList(mismatchedRequired.map((m) => `omp plugin install ${m.spec}`));
            parts.push(`Несоответствие версии обязательных плагинов (${mismatchedRequired.length}): ${vHints}. Обновить: ${installHints}`);
          }
          if (missingOptional.length > 0) {
            const optHints = summarizeList(missingOptional.map((p) => `omp plugin install ${p.spec}`));
            parts.push(`Не установлены опциональные плагины (${missingOptional.length} из ${declared.length}): ${summarizeList(missingOptional.map((p) => p.name))}. Установить: ${optHints}`);
          }
          if (mismatchedOptional.length > 0) {
            const optVHints = summarizeList(mismatchedOptional.map((m) => `${m.name} (${m.installed} != ${m.expected})`));
            const installHints = summarizeList(mismatchedOptional.map((m) => `omp plugin install ${m.spec}`));
            parts.push(`Несоответствие версии опциональных плагинов (${mismatchedOptional.length}): ${optVHints}. Обновить: ${installHints}`);
          }

          if (missingRequired.length > 0 || mismatchedRequired.length > 0) {
            status = "fail";
            detail = parts.join(". ");
          } else if (missingOptional.length > 0 || mismatchedOptional.length > 0) {
            status = options.requirePlugins ? "fail" : "warn";
            detail = parts.join(". ");
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
          orphans = findPruneCandidates({ harness, repo: repoClone }).filter((rel) => rel !== "agent/plugins.skipped");
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

  // 12. check 'logs-hygiene': аудит размера и количества сессионных логов в ~/.omp/logs/.
  {
    const id = "logs-hygiene";
    const logsDir = join(homedir(), ".omp", "logs");
    if (!existsSync(logsDir)) {
      checks.push({
        id,
        status: "pass",
        detail: "Каталог логов отсутствует (~/.omp/logs): чисто",
      });
    } else {
      let files = [];
      try { files = readdirSync(logsDir); } catch {}
      let totalBytes = 0;
      let staleFiles = [];
      const now = Date.now();
      const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
      for (const f of files) {
        try {
          const st = statSync(join(logsDir, f));
          totalBytes += st.size;
          if (now - st.mtimeMs > maxAgeMs) staleFiles.push({ name: f, path: join(logsDir, f) });
        } catch {}
      }

      if (options.pruneLogs && staleFiles.length > 0) {
        let pruned = 0;
        for (const sf of staleFiles) {
          try { rmSync(sf.path, { force: true }); pruned++; } catch {}
        }
        checks.push({
          id,
          status: "pass",
          detail: `Очищено ${pruned} лог-файлов старше 14 дней. Осталось: ${files.length - pruned}`,
        });
      } else {
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        if (files.length > 1000 || totalBytes > 50 * 1024 * 1024) {
          checks.push({
            id,
            status: "warn",
            detail: `${files.length} файлов логов (${mb} МБ), ${staleFiles.length} старше 14 дней. Очистить: node tools/doctor.mjs --prune-logs`,
          });
        } else {
          checks.push({
            id,
            status: "pass",
            detail: `${files.length} файлов логов (${mb} МБ) в норме`,
          });
        }
      }
    }
  }

  // 13. check 'provider-reachability' (только с --probe): сети и отчёта без флага нет.
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
  --require-plugins  отсутствие любых (включая опциональные) плагинов из agent/plugins.json
           делает doctor FAIL (по умолчанию обязательные плагины дают FAIL, а опциональные — WARN).
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

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`doctor: необработанная ошибка: ${err.message}\n`);
    process.exitCode = 2;
  });
}
