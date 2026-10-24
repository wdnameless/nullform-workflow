#!/usr/bin/env node
/**
 * tools/doctor-shared.mjs — shared definitions for doctor and doctor-checks.
 * Leaf module: must not import from doctor.mjs or doctor-checks.mjs.
 */

import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cleanYamlValue } from "./oracle-model.mjs";

export const CORE_TOOLS = [
  "workflow.mjs", "worktree-snapshot.mjs",
  "review/evidence.mjs", "review/native-tools.mjs", "review/budget.mjs",
  "review/http-runtime.mjs", "review/http-child.mjs", "review/http-evidence.mjs",
  "installation/state.mjs", "installation/profiles.mjs", "installation/adapters.mjs",
  "installation/config.mjs", "installation/capabilities.mjs", "installation/hermes-policy.mjs",
  "installation/journal.mjs", "installation/restore.mjs",
  "workflow/claims.mjs", "workflow/workspaces.mjs",
  "prompt-lint.mjs", "skill-audit.mjs", "skills-doctor.mjs", "glossary.mjs",
  "replay.mjs", "codemap.mjs", "return-contract.mjs", "cache-policy.mjs",
  "cache-doctor.mjs", "context-inbox.mjs", "domain-context.mjs", "oracle-model.mjs",
  "debt-ledger.mjs", "benchmark.mjs", "usage-audit.mjs", "test-lens.mjs",
  "code-size.mjs", "auto-review.mjs", "doctor.mjs", "sync-prune.mjs",
  "memory-cadence.mjs", "mutation-test.mjs", "gherkin-spec.mjs", "dashboard.mjs",
  "fix-plugin-windows.cjs", "session_cost.py", "verify.mjs", "audit.ps1",
  "sync.ps1", "sync.mjs", "sync-manifest.json", "audit.sh", "sync.sh",
];

export const REQUIRED_ROLES = [
  "orchestrator", "fixer", "designer", "oracle", "librarian", "explorer", "reviewer",
];

export function normalizePath(p) {
  if (!p) return "";
  try {
    return realpathSync(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  } catch {
    return resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  }
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

/** Кавычит аргумент для cmd.exe: пробелы и метасимволы не должны разбираться шеллом. */
function quoteShellArg(value) {
  const text = String(value);
  return /[\s"^&|<>()]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
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
