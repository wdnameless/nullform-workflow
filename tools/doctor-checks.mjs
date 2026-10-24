#!/usr/bin/env node
/**
 * tools/doctor-checks.mjs — 16 проверок доктора (выделены из runDoctor 1:1).
 * Каждая проверка: (ctx) => void; пушит в ctx.checks.
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { findPruneCandidates } from "./sync-prune.mjs";
import { preflightJsoncConfig, preflightJson5Config, preflightYamlConfig, preflightManagedMarkers, safeJsonErrorMessage, loadYaml, MANAGED_START, MANAGED_END, getMarkdownAdapter } from "./installation/config.mjs";
import { checkVersionAlignment, checkHarnessCapabilities } from "./installation/capabilities.mjs";
import { updateHermesConfigYaml } from "./installation/hermes-policy.mjs";
import {
  normalizePath, stripBom, isRepoTree, discoverRepoClone, roleNamesIn,
  missingRequiredRoles, compareAgentDefs, unpackBuiltinAgents, parseRoleModels,
  runOmp, CORE_TOOLS, REQUIRED_ROLES,
} from "./doctor-shared.mjs";

function resolveSyntaxChecker() {
  if (!process.versions.bun) return process.execPath;
  const probe = spawnSync("node", ["-p", "process.versions.bun?'':process.execPath"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const resolved = probe.status === 0 ? probe.stdout.trim() : "";
  if (!resolved) throw new Error("A real Node executable is required to check tool syntax under Bun; install Node or run doctor with Node.");
  return resolved;
}

/** Маркеры, отличающие репозиторий от живого харнесса (см. sync.ps1 Resolve-RepoRoot). */

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

function checkNonOmpHarness({ harness, targetHarness, projectRoot, profile, env }) {
  const errors = [];
  const checks = [{
    id: "host-runtime", status: "warn",
    detail: "Native runtime/session not verified. Installed files, documented APIs and declarations are not proof of active tools, credentials or execution.",
  }];
  const checkMd = path => {
    if (!existsSync(path)) { errors.push(`Missing instruction file: ${path}`); return; }
    const content = readFileSync(path, "utf8");
    try { preflightManagedMarkers(path, content); } catch (error) { errors.push(error.message); }
    if (!content.includes(MANAGED_START) || !content.includes(MANAGED_END)) errors.push(`Managed policy missing: ${path}`);
  };
  if (targetHarness === "custom") checkMd(join(projectRoot, profile.hostManifest.instructionsFile));
  else if (targetHarness === "cursor") checkMd(join(projectRoot || harness, ".cursor", "rules", "00-workflow.mdc"));
  else checkMd(join(harness, targetHarness === "claude" ? "CLAUDE.md" : "AGENTS.md"));
  if (targetHarness === "opencode") {
    for (const dir of new Set([harness, profile.hostHome])) {
      for (const name of ["opencode.json", "opencode.jsonc"]) {
        const path = join(dir, name);
        if (existsSync(path)) try { preflightJsoncConfig(path); } catch (error) { errors.push(error.message); }
      }
    }
  }
  if (targetHarness === "openclaw") {
    const path = join(harness, "openclaw.json");
    try {
      if (!preflightJson5Config(path)?.agents?.entries?.workflow?.workspace) errors.push("OpenClaw workflow workspace missing");
    } catch (error) { errors.push(error.message); }
  }
  if (targetHarness === "hermes") {
    try {
      const path = join(profile.hostHome, "config.yaml");
      const settings = loadYaml().parse(preflightYamlConfig(path) || "{}") || {};
      const manual = Object.hasOwn(env, "HERMES_EPHEMERAL_SYSTEM_PROMPT") || /^(1|true|yes|on)$/i.test(String(env.HERMES_IGNORE_RULES || "").trim());
      if (!manual) {
        const original = existsSync(path) ? readFileSync(path, "utf8") : null;
        const policy = getMarkdownAdapter(harness.replace(/\\/g, "/"), "Hermes Agent NULLFORM WORKFLOW Adapter", profile);
        if (updateHermesConfigYaml(path, original, policy, { validateOnly: true }) !== original) errors.push("Hermes agent.system_prompt managed policy is missing; legacy skills.auto_load is not a native loader.");
      }
      checks.push({
        id: "policy-loading", status: "warn",
        detail: manual
          ? "HERMES_EPHEMERAL_SYSTEM_PROMPT is present or HERMES_IGNORE_RULES is selected: manual project instructions required; existing configuration preserved."
          : "Native agent.system_prompt checked as configuration only; active-session/model execution and delegated-child inheritance remain unverified.",
      });
      if (Object.hasOwn(settings, "skills") || existsSync(join(profile.hostHome, "skills"))) checks.push({ id: "legacy-skills", status: "warn", detail: "Existing skills/skills.auto_load preserved; auto_load is not consumed by this native client. Resolve legacy loading manually." });
      if (settings.mcp_servers && Object.keys(settings.mcp_servers).length) checks.push({ id: "legacy-extras", status: "warn", detail: "Existing MCP registrations preserved; legacy servers may remain active." });
    } catch (error) { errors.push(error.message); }
  }
  checks.push({ id: "harness-integration", status: errors.length ? "fail" : "pass", detail: errors.length ? errors.join("; ") : `${targetHarness}: installed policy/configuration checked; native consumption remains unverified.` });
  checks.push({ id: "skills", status: "skip", detail: "No bulk native-home skill catalogue required by adaptive profiles." });
  return checks;
}


function providerOfModel(model) {
  if (!model || !model.includes("/")) return null;
  return model.slice(0, model.indexOf("/"));
}

/**
 * Роли модели из config.yml: секция `modelRoles:` и `task.agentModelOverrides:`.
 * @returns {Array<{role: string, section: string, model: string}>}
 */

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

export function checkNode(ctx) {
  const { checks } = ctx;
  {
    const id = "node";
    const majorVersion = parseInt(process.versions.node.split(".")[0], 10);
    checks.push({
      id,
      status: majorVersion >= 18 ? "pass" : "fail",
      detail: majorVersion >= 18
        ? `Node.js v${process.versions.node} (>= 18)`
        : `Node.js v${process.versions.node} устарел (требуется >= 18)`,
    });
  }

}

export function checkHarnessFiles(ctx) {
  const { checks, harness, targetHarness } = ctx;
  {
    const id = "harness-files";
    const missing = [];

    const agentsMd = join(harness, "agent", "AGENTS.md");
    if (!existsSync(agentsMd)) missing.push("agent/AGENTS.md");

    const agentsDir = join(harness, "agent", "agents");
    const roleNames = roleNamesIn(agentsDir);
    if (targetHarness === "omp") {
      for (const role of missingRequiredRoles(roleNames)) {
        missing.push(`agent/agents/${role}.md (обязательная роль)`);
      }
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

    checks.push({
      id,
      status: missing.length === 0 ? "pass" : "fail",
      detail: missing.length === 0
        ? `Все обязательные файлы и директории харнесса присутствуют (обязательные роли: ${REQUIRED_ROLES.length}, всего определений: ${roleNames.length})`
        : `Отсутствуют обязательные файлы харнесса: ${missing.join(", ")}`,
    });
  }

}

export function checkToolsSyntax(ctx) {
  const { checks, harness } = ctx;
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
      const mjsFiles = [];
      const walkTools = (dir, prefix) => {
        let entries = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
          syntaxErrors.push(`${prefix || "tools/"} (directory could not be enumerated: ${error.code || error.message})`);
          return;
        }
        for (const entry of entries) {
          if (entry.name === "tests" || entry.name === "node_modules") continue;
          const rel = `${prefix}${entry.name}`;
          // Never follow an untrusted link to certify syntax outside the installation.
          if (entry.isSymbolicLink()) {
            syntaxErrors.push(`${rel} (symlink not inspected)`);
            continue;
          }
          if (entry.isDirectory()) {
            walkTools(join(dir, entry.name), `${rel}/`);
          } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
            mjsFiles.push(rel);
          }
        }
      };
      walkTools(toolsDir, "");

      let syntaxChecker = null;
      try {
        syntaxChecker = resolveSyntaxChecker();
      } catch (error) {
        syntaxErrors.push(`real Node unavailable (${error.message})`);
      }
      for (const mjs of syntaxChecker ? mjsFiles : []) {
        const fullPath = join(toolsDir, mjs);
        const res = spawnSync(syntaxChecker, ["--check", fullPath], {
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
      if (missingCore.length > 0) details.push(`отсутствуют обязательные инструменты: ${missingCore.join(", ")}`);
      if (syntaxErrors.length > 0) details.push(`синтаксические ошибки в: ${syntaxErrors.join(", ")}`);
      checks.push({ id, status: "fail", detail: details.join("; ") });
    } else {
      checks.push({ id, status: "pass", detail: "Все инструменты ядра присутствуют, синтаксис проверен (node --check)" });
    }
  }

}

export function checkToolsSmoke(ctx) {
  const { checks, harness } = ctx;
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

    checks.push({
      id,
      status: smokeErrors.length > 0 ? "fail" : "pass",
      detail: smokeErrors.length > 0
        ? smokeErrors.join("; ")
        : "Smoke-тесты пройдены: prompt-lint fingerprint и debt-ledger scan успешны",
    });
  }
}

export function checkAgentWiring(ctx) {
  const { checks, harness, agentDir, mode, hasHarnessRoot, harnessRootMatches, harnessRootTarget } = ctx;
  {
    const id = "agent-wiring";
    if (mode === "repo") {
      const note = !hasHarnessRoot
        ? "Режим repo: агентская директория не настроена (.harness-root отсутствует)"
        : `Режим repo: агентская директория привязана к другому харнессу (${harnessRootTarget})`;
      checks.push({ id, status: "warn", detail: note });
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

      checks.push({
        id,
        status: wiringErrors.length > 0 ? "fail" : "pass",
        detail: wiringErrors.length > 0
          ? wiringErrors.join("; ")
          : "Проводка агента корректна (.harness-root и AGENTS.md проверены)",
      });
    }
  }
}

export function checkPluginPatches(ctx) {
  const { checks, harness, agentsHome } = ctx;
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
      checks.push({
        id,
        status: guarded ? "pass" : "warn",
        detail: guarded
          ? "патчи плагинов применены (pi-lens: EPIPE-глушитель)"
          : "pi-lens БЕЗ патча: обновление плагина сняло правки — запустите `node tools/fix-plugin-windows.cjs`",
      });
    }
  }

}

export function checkSkills(ctx) {
  const { checks, harness, agentsHome } = ctx;
  {
    const id = "skills";
    const skillsDoctorPath = join(harness, "tools", "skills-doctor.mjs");
    const installedSkills = join(agentsHome, "skills");

    if (!existsSync(skillsDoctorPath)) {
      checks.push({ id, status: "fail", detail: "tools/skills-doctor.mjs не найден" });
    } else {
      const detail = existsSync(installedSkills)
        ? `Обнаружен независимый каталог навыков (${installedSkills}): портативные навыки доступны в ${harness}/skills (аудит: tools/skills-doctor.mjs)`
        : `Каталог глобальных навыков отсутствует (${installedSkills}): портативные навыки доступны в ${harness}/skills`;
      checks.push({ id, status: "skip", detail });
    }
  }

}

export function checkPromptBaseline(ctx) {
  const { checks, harness } = ctx;
  {
    const id = "prompt-baseline";
    const baselineFile = join(harness, ".prompt-lint", "baseline.json");
    if (!existsSync(baselineFile)) {
      checks.push({ id, status: "warn", detail: "Файл .prompt-lint/baseline.json отсутствует (рекомендуется создать через baseline)" });
    } else {
      const promptLintPath = join(harness, "tools", "prompt-lint.mjs");
      if (!existsSync(promptLintPath)) {
        checks.push({ id, status: "fail", detail: "tools/prompt-lint.mjs не найден для проверки baseline" });
      } else {
        const res = spawnSync(process.execPath, [promptLintPath, "check", "--root", harness], { encoding: "utf8", windowsHide: true });
        checks.push({
          id,
          status: res.status === 0 ? "pass" : "warn",
          detail: res.status === 0
            ? "Бейзлайн промптов актуален (дрейф не обнаружен)"
            : `Обнаружен дрейф поверхностей промптов от бейзлайна (код ${res.status})`,
        });
      }
    }
  }

}

export function checkConfigs(ctx) {
  const { checks, agentDir, explicitTargetHarness } = ctx;
  {
    const id = "configs";
    const reported = [];
    let configError = null;

    const mcpJson = join(agentDir, "mcp.json");
    if (existsSync(mcpJson)) {
      try {
        const parsed = JSON.parse(stripBom(readFileSync(mcpJson, "utf8")));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          configError = "mcp.json не является валидным JSON-объектом";
        } else {
          reported.push("mcp.json (валидный JSON)");
        }
      } catch (err) {
        configError = `mcp.json не является валидным JSON: ${safeJsonErrorMessage(err)}`;
      }
    }
    const modelsYml = join(agentDir, "models.yml");
    if (existsSync(modelsYml)) {
      try {
        preflightYamlConfig(modelsYml);
        reported.push("models.yml (присутствует)");
      } catch (err) {
        if (!configError) configError = `models.yml некорректен: ${err.message}`;
      }
    }
    const configYml = join(agentDir, "config.yml");
    if (existsSync(configYml)) {
      try {
        preflightYamlConfig(configYml);
        reported.push("config.yml (присутствует)");
      } catch (err) {
        if (!configError) configError = `config.yml некорректен: ${err.message}`;
      }
    }
    if (configError) {
      checks.push({ id, status: "fail", detail: configError });
    } else if (explicitTargetHarness && (!existsSync(modelsYml) || !existsSync(configYml))) {
      checks.push({
        id,
        status: "warn",
        detail: `[SETUP] Модели/провайдеры OMP (models.yml / config.yml) ещё не настроены${reported.length > 0 ? `; проверено: ${reported.join(", ")}` : ""}`,
      });
    } else if (reported.length > 0) {
      checks.push({ id, status: "pass", detail: `Конфигурационные файлы: ${reported.join(", ")}` });
    } else {
      checks.push({ id, status: "skip", detail: "Конфигурационные файлы в agent-dir отсутствуют (не настроены)" });
    }
  }

}

export function checkPlugins(ctx) {
  const { checks, harness, options } = ctx;
  // Аудит плагинов выполняется только при явном опт-ине `--require-plugins`.
  {
    const id = "plugins";
    const skippedMarker = join(harness, "agent", "plugins.skipped");
    if (options.skipPluginCheck) {
      checks.push({ id, status: "skip", detail: "Проверка плагинов пропущена (--skip-plugin-check)" });
    } else if (existsSync(skippedMarker)) {
      checks.push({ id, status: "skip", detail: "плагины пропущены при установке (-SkipPlugins); установите и повторите" });
    } else if (!options.requirePlugins) {
      checks.push({ id, status: "skip", detail: "Проверка плагинов пропущена (включить строгий аудит: --require-plugins)" });
    } else {
      const manifestPath = join(harness, "agent", "plugins.json");
      const omp = options.runOmp || runOmp;
      let declared = null, manifestError = null;
      if (!existsSync(manifestPath)) {
        checks.push({ id, status: "fail", detail: "Манифест плагинов отсутствует (agent/plugins.json): требуемые плагины не определены" });
      } else {
        try { declared = readPluginsManifest(manifestPath); } catch (err) { manifestError = err.message; }
        if (manifestError) {
          checks.push({ id, status: "fail", detail: `Манифест плагинов не прочитан (${manifestPath}): ${manifestError}` });
        } else if (declared.length === 0) {
          checks.push({ id, status: "pass", detail: "Манифест плагинов пуст: устанавливать нечего" });
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

          if (missingRequired.length > 0 || mismatchedRequired.length > 0 || missingOptional.length > 0 || mismatchedOptional.length > 0) {
            status = "fail";
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

}

export function checkOrphanFiles(ctx) {
  const { checks, harness } = ctx;
  // tools/ → FAIL (инструмент вне дистрибутива ломает установку у других),
  // прочие каталоги → WARN. Область обхода общая с `sync.ps1 -Prune` (sync-prune.mjs).
  {
    const id = "orphan-files";
    if (isRepoTree(harness)) {
      checks.push({ id, status: "skip", detail: "Харнесс является дистрибутивным репозиторием: файлов вне репозитория быть не может" });
    } else {
      const repoClone = discoverRepoClone(harness);
      if (!repoClone) {
        checks.push({ id, status: "skip", detail: `Клон репозитория не обнаружен (${join(harness, "workflow-repo")}): сравнение не выполняется` });
      } else {
        let orphans = [], readError = null;
        try {
          orphans = findPruneCandidates({ harness, repo: repoClone }).filter((rel) => rel !== "agent/plugins.skipped");
        } catch (err) { readError = err.message; }
        if (readError) {
          checks.push({ id, status: "warn", detail: `Не удалось сравнить харнесс с репозиторием: ${readError}` });
        } else if (orphans.length === 0) {
          checks.push({ id, status: "pass", detail: `Все файлы каталогов манифеста присутствуют в репозитории (${repoClone})` });
        } else {
          const toolOrphans = orphans.filter((rel) => rel.startsWith("tools/"));
          const otherOrphans = orphans.filter((rel) => !rel.startsWith("tools/"));
          const parts = [];
          if (toolOrphans.length > 0) parts.push(`tools/ (${toolOrphans.length}): ${summarizeList(toolOrphans)}`);
          if (otherOrphans.length > 0) parts.push(`прочие (${otherOrphans.length}): ${summarizeList(otherOrphans)}`);
          checks.push({
            id,
            status: toolOrphans.length > 0 ? "fail" : "warn",
            detail: `${orphans.length} файл(ов) харнесса отсутствуют в репозитории — ${parts.join("; ")}`,
          });
        }
      }
    }
  }

}

export function checkAgentsDrift(ctx) {
  const { checks, harness, agentDir, mode, options } = ctx;
  // Нет встроенного с таким именем → fork (наш собственный агент, часть pass);
  // имя есть, содержимое разошлось → drift (WARN, имена перечисляются);
  // тексты совпали → ок. Никогда не FAIL: расхождение бывает намеренным (форки,
  // сужающие встроенную роль), а сам `omp` может отсутствовать.
  {
    const id = "agents-drift";
    const agentsDir = mode === "installed" ? (agentDir ? join(agentDir, "agents") : null) : join(harness, "agent", "agents");
    const roleNames = agentsDir ? roleNamesIn(agentsDir) : [];

    let builtinDir = null;
    let tempDir = null;
    let skipReason = null;

    if (roleNames.length === 0) {
      skipReason = mode === "installed"
        ? "в агентской директории нет установленных ролей: проверка дрейфа пропущена"
        : `сравнивать нечего: каталог ${agentsDir} пуст или отсутствует`;
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

        checks.push({
          id,
          status: drift.length > 0 ? "warn" : "pass",
          detail: drift.length > 0
            ? `Дрейф от встроенных агентов OMP (${drift.length}): ${summarizeList(drift)} — наш файл перекрывает встроенного (first-wins)${forkNote}`
            : `Определения ролей не разошлись со встроенными OMP (совпало: ${matched.length}, форков: ${forks.length})${forkNote}`,
        });
      }
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

}

export function checkLogsHygiene(ctx) {
  const { checks, agentsHome, options } = ctx;
  {
    const id = "logs-hygiene";
    const logsHome = dirname(agentsHome);
    const logsDir = join(logsHome, ".omp", "logs");
    if (!existsSync(logsDir)) {
      checks.push({ id, status: "pass", detail: "Каталог логов отсутствует (~/.omp/logs): чисто" });
    } else {
      let files = [];
      try { files = readdirSync(logsDir); } catch {}
      let totalBytes = 0;
      const staleFiles = [];
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
        checks.push({ id, status: "pass", detail: `Очищено ${pruned} лог-файлов старше 14 дней. Осталось: ${files.length - pruned}` });
      } else {
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        const noisy = files.length > 1000 || totalBytes > 50 * 1024 * 1024;
        checks.push({
          id,
          status: noisy ? "warn" : "pass",
          detail: noisy
            ? `${files.length} файлов логов (${mb} МБ), ${staleFiles.length} старше 14 дней. Очистить: node tools/doctor.mjs --prune-logs`
            : `${files.length} файлов логов (${mb} МБ) в норме`,
        });
      }
    }
  }

}

export function checkProviderReachability(ctx) {
  const { checks, agentDir, probeResults } = ctx;
  if (probeResults) {
    const id = "provider-reachability";
    const configYml = join(agentDir, "config.yml");
    const providerNames = Object.keys(probeResults.providers);
    const unreachable = providerNames.filter((n) => probeResults.providers[n].reachable === false);

    if (!existsSync(configYml)) {
      checks.push({ id, status: "skip", detail: `config.yml не найден (${configYml}): роли не сопоставлялись с провайдерами` });
    } else {
      let roles = [];
      try {
        roles = parseRoleModels(readFileSync(configYml, "utf8"));
      } catch (err) {
        checks.push({ id, status: "warn", detail: `config.yml не прочитан (${err.message}): роли не сопоставлялись с провайдерами` });
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
        const unreachableDetail = unreachable.map((n) => `${n} (${probeResults.providers[n].error})`).join("; ");
        const rolesDetail = blockedRoles.length > 0 ? blockedRoles.map((r) => `${r.role} [${r.model}]`).join(", ") : "нет";
        checks.push({
          id,
          status: "warn",
          detail: `Недостижимые провайдеры: ${unreachableDetail}. Роли, указывающие на их модели: ${rolesDetail}${unprobedNote(unprobedRoles, probeResults.notes)}`,
        });
      }
    }
  }
}

export function checkReleaseDrift(ctx) {
  const { checks, harness, options } = ctx;
  // WARN при отставании (никогда FAIL), SKIP при offline/отсутствии VERSION.
  {
    const id = "release-drift";
    const versionPath = join(harness, "VERSION");
    if (!existsSync(versionPath)) {
      checks.push({ id, status: "skip", detail: `файл VERSION не найден (${versionPath}): проверка пропущена` });
    } else {
      let localVersion = "";
      try {
        localVersion = readFileSync(versionPath, "utf8").trim();
      } catch (err) {
        checks.push({ id, status: "skip", detail: `не удалось прочитать VERSION (${err.message}): проверка пропущена` });
      }
      if (localVersion) {
        const releaseInfo = options.releaseInfo;
        if (!releaseInfo) {
          checks.push({ id, status: "skip", detail: "проверка релизов не выполнена (офлайн или локальный режим)" });
        } else if (releaseInfo.offline || releaseInfo.error) {
          checks.push({ id, status: "skip", detail: `офлайн: не удалось получить данные о релизе (${releaseInfo.error || "сеть недоступна"})` });
        } else if (releaseInfo.status === "drift") {
          const latest = releaseInfo.latest || "релиза";
          checks.push({ id, status: "warn", detail: `Локальная версия v${localVersion} отстает от релиза v${latest}. Запустите 'nullform update'` });
        } else if (releaseInfo.status === "clean") {
          checks.push({ id, status: "pass", detail: `Версия v${localVersion} актуальна (релиз ${releaseInfo.latest || localVersion})` });
        } else {
          checks.push({ id, status: "skip", detail: `проверка релизов: ${releaseInfo.detail || "пропущена"}` });
        }
      }
    }
  }
}

export function checkVersionHarness(ctx) {
  const { checks, harness, userHome, profile, targetHarness, options } = ctx;
  checks.push(checkVersionAlignment({ harness, userHome, activePid: options.activePid }));
  checks.push(targetHarness === "omp" ? checkHarnessCapabilities(targetHarness) : {
    id: "harness-capabilities", status: "warn", detail: profile.runtimeReady.reason,
  });
}

export function checkNonOmp(ctx) {
  const { checks, harness, targetHarness, projectRoot, profile, env } = ctx;
  checks.push(...checkNonOmpHarness({ harness, targetHarness, projectRoot, profile, env }));
}
