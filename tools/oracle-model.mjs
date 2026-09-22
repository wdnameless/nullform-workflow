#!/usr/bin/env node
/**
 * tools/oracle-model.mjs
 *
 * Oracle model autoselect tool per interfaces.md.
 * Discovers available models from models.yml (declared + optional discovery probe),
 * resolves the highest-priority model matching oracle-priority list,
 * and updates config.yml (modelRoles.oracle and task.agentModelOverrides.oracle)
 * preserving all other bytes, comments, and line endings.
 *
 * Zero external dependencies. Node 18+.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Резервная модель НЕ прибита к вендору: воркфлоу обязан работать с любым
// провайдером. Приоритеты берутся из oracle-priority.json (его правит оператор),
// а если файла нет — из первой доступной модели провайдера (см. resolveModel).
const FALLBACK_MATCH = "best-reasoning";

export function parseArgs(argv) {
  const args = {
    command: null,
    config: null,
    models: null,
    priority: null,
    probe: false,
    dryRun: false,
    json: false,
    help: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      args.config = argv[++i];
    } else if (arg === "--models") {
      args.models = argv[++i];
    } else if (arg === "--priority") {
      args.priority = argv[++i];
    } else if (arg === "--probe") {
      args.probe = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg.startsWith("--config=")) {
      args.config = arg.slice("--config=".length);
    } else if (arg.startsWith("--models=")) {
      args.models = arg.slice("--models=".length);
    } else if (arg.startsWith("--priority=")) {
      args.priority = arg.slice("--priority=".length);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  args.command = positional[0] || null;
  return args;
}

/**
 * Strip YAML comments and clean string values.
 * Exported: doctor.mjs reuses it for config.yml role values (single convention).
 *
 * Порядок важен: сначала закрывающая кавычка, потом комментарий. Иначе
 * `oracle: "model" # why` вернёт значение вместе с кавычками, а
 * `apiKey: "a#b"` потеряет часть секрета.
 */
export function cleanYamlValue(val) {
  if (val === undefined || val === null) return "";
  const v = String(val).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) {
    const close = v.indexOf(v[0], 1);
    if (close !== -1) return v.slice(1, close);
  }
  const hashIdx = v.indexOf("#");
  if (hashIdx !== -1) return v.slice(0, hashIdx).trim();
  return v;
}

/**
 * Parse models.yml content according to interfaces.md specification:
 * - providers: section has provider keys at 2 spaces indentation
 * - under each provider: baseUrl, apiKey, discovery, declared models
 * - declared models: "- id: <modelId>"
 * - discovery: type (e.g. openai-compatible / openrouter / ollama)
 */
export function parseModelsYaml(content) {
  const providers = {};
  if (!content) return { providers };

  const lines = content.split(/\r?\n/);
  let inProviders = false;
  let currentProvider = null;
  let currentField = null; // for tracking sub-blocks if needed

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Remove trailing comments for structural checks, but keep track of indentation
    const lineWithoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!lineWithoutComment.trim()) continue;

    // Top-level key
    const topMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*$/);
    if (topMatch) {
      inProviders = (topMatch[1] === "providers");
      currentProvider = null;
      continue;
    }

    if (!inProviders) continue;

    // Provider definition: 2 spaces indent
    const provMatch = rawLine.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (provMatch) {
      currentProvider = {
        name: provMatch[1],
        baseUrl: "",
        apiKey: "",
        discovery: null,
        models: [], // string IDs
      };
      providers[provMatch[1]] = currentProvider;
      currentField = null;
      continue;
    }

    if (!currentProvider) continue;

    // Provider fields: 4+ spaces indent
    // Check baseUrl
    const baseMatch = rawLine.match(/^\s{4}baseUrl:\s*(.+)$/);
    if (baseMatch) {
      currentProvider.baseUrl = cleanYamlValue(baseMatch[1]);
      currentField = "baseUrl";
      continue;
    }

    // Check apiKey
    const keyMatch = rawLine.match(/^\s{4}apiKey:\s*(.+)$/);
    if (keyMatch) {
      currentProvider.apiKey = cleanYamlValue(keyMatch[1]);
      currentField = "apiKey";
      continue;
    }

    // Check discovery:
    const discMatch = rawLine.match(/^\s{4}discovery:\s*$/);
    if (discMatch) {
      currentProvider.discovery = {};
      currentField = "discovery";
      continue;
    }

    if (currentField === "discovery" && rawLine.match(/^\s{6}type:\s*(.+)$/)) {
      const typeMatch = rawLine.match(/^\s{6}type:\s*(.+)$/);
      currentProvider.discovery = currentProvider.discovery || {};
      currentProvider.discovery.type = cleanYamlValue(typeMatch[1]);
      continue;
    }

    // Check models list
    const modelsHeader = rawLine.match(/^\s{4}models:\s*$/);
    if (modelsHeader) {
      currentField = "models";
      continue;
    }

    // Declared model item: "- id: <modelId>"
    const modelIdMatch = rawLine.match(/^\s*(?:-\s+id:|\s{6}-\s+id:)\s*(.+)$/);
    if (modelIdMatch) {
      const id = cleanYamlValue(modelIdMatch[1]);
      if (id && !currentProvider.models.includes(id)) {
        currentProvider.models.push(id);
      }
      continue;
    }
  }

  return { providers };
}

/**
 * Resolve priority file location:
 * 1. CLI --priority if provided
 * 2. $HOME/.omp/agent/oracle-priority.json if exists
 * 3. agent/oracle-priority.example.json next to script's repo
 */
export function resolvePriorityFile(cliPriority) {
  if (cliPriority) {
    return resolve(cliPriority);
  }

  const userHome = homedir();
  const homePriority = join(userHome, ".omp", "agent", "oracle-priority.json");
  if (existsSync(homePriority)) {
    return homePriority;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoExample = resolve(scriptDir, "..", "agent", "oracle-priority.example.json");
  return repoExample;
}

/**
 * Read priority file and return array of entries.
 * Ensures the last entry is the neutral fallback marker (FALLBACK_MATCH).
 */
export function loadPriorityList(priorityPath) {
  let list = [];
  if (existsSync(priorityPath)) {
    try {
      const raw = readFileSync(priorityPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed;
      } else if (parsed && Array.isArray(parsed.entries)) {
        list = parsed.entries;
      }
    } catch {
      // ignore parse error, fallback to fallback model
    }
  }

  // Normalize entries: each item { match, why }
  const normalized = [];
  for (const item of list) {
    if (typeof item === "string") {
      normalized.push({ match: item, why: "" });
    } else if (item && typeof item.match === "string") {
      normalized.push({ match: item.match, why: item.why || "" });
    }
  }

  // Ensure last entry is fallback model if not already present
  const hasFallback = normalized.some((e) => e.match.toLowerCase() === FALLBACK_MATCH.toLowerCase());
  if (!hasFallback) {
    normalized.push({ match: FALLBACK_MATCH, why: "Neutral fallback: провайдер сам решает, какая модель «сильнейшая»" });
  }

  return normalized;
}

/**
 * Discover models for a provider using network probe if discovery is configured.
 * 10-second timeout.
 */
export async function probeProvider(provider) {
  if (!provider.baseUrl) {
    return { models: [], error: "Missing baseUrl" };
  }

  let endpoint = provider.baseUrl.replace(/\/+$/, "");
  if (!endpoint.endsWith("/models")) {
    endpoint = `${endpoint}/models`;
  }

  const headers = {};
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { models: [], error: `HTTP ${res.status} ${res.statusText}` };
    }

    const data = await res.json();
    const modelIds = [];
    if (data && Array.isArray(data.data)) {
      for (const m of data.data) {
        if (m && m.id) modelIds.push(String(m.id));
      }
    } else if (data && Array.isArray(data.models)) {
      for (const m of data.models) {
        if (typeof m === "string") modelIds.push(m);
        else if (m && (m.name || m.id)) modelIds.push(String(m.name || m.id));
      }
    }
    return { models: modelIds, error: null };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Timeout after 10s" : err.message;
    return { models: [], error: msg };
  }
}

/**
 * Redact API key material from any text or objects.
 */
export function redactSecrets(text, secretKeys = []) {
  if (!text) return text;
  let out = String(text);
  for (const key of secretKeys) {
    if (key && typeof key === "string" && key.length >= 4) {
      out = out.split(key).join("[REDACTED]");
    }
  }
  return out;
}

/**
 * Resolve available models across all providers.
 * Returns array of objects: { qualified: `${provider}/${model}`, provider, model, source: 'declared'|'discovered' }
 *
 * С `probe=true` опрашивается КАЖДЫЙ провайдер с baseUrl (не только с discovery):
 * недостижимый провайдер — это и есть причина падения спавнов, поэтому его модели
 * исключаются из выбора, а `providers[name].reachable === false` служит доказательством.
 * Без probe поведение прежнее: все объявленные модели доступны, сети нет.
 *
 * @returns {Promise<{available: Array, notes: string[], secrets: string[],
 *   providers: Object<string, {reachable: boolean|null, error: string|null, declared: number, discovered: number}>}>}
 */
export async function collectAvailableModels(modelsYamlPath, probe = false) {
  if (!existsSync(modelsYamlPath)) {
    return {
      available: [],
      notes: [`Файл models.yml не найден: ${modelsYamlPath}`],
      secrets: [],
      providers: {},
    };
  }

  const content = readFileSync(modelsYamlPath, "utf8");
  const parsed = parseModelsYaml(content);
  const available = [];
  const notes = [];
  const secrets = [];
  const providers = {};

  for (const provName of Object.keys(parsed.providers)) {
    const prov = parsed.providers[provName];
    if (prov.apiKey) {
      secrets.push(prov.apiKey);
    }

    let reachable = null;
    let discovered = [];
    let probeError = null;

    if (probe && prov.baseUrl) {
      const probeResult = await probeProvider(prov);
      probeError = probeResult.error;
      reachable = !probeError;
      if (probeError) {
        notes.push(
          `Провайдер ${provName} недостижим (${probeError}): его модели исключены из выбора`
        );
      } else {
        discovered = probeResult.models;
      }
    }

    providers[provName] = {
      reachable,
      error: probeError,
      discovered: discovered.length,
    };

    // Модель провалившего провайдера не выбирается никогда (ни declared, ни discovered).
    if (reachable === false) continue;

    for (const modelId of prov.models) {
      available.push({
        qualified: `${provName}/${modelId}`,
        provider: provName,
        model: modelId,
        source: "declared",
      });
    }

    for (const discoveredId of discovered) {
      if (!prov.models.includes(discoveredId)) {
        available.push({
          qualified: `${provName}/${discoveredId}`,
          provider: provName,
          model: discoveredId,
          source: "discovered",
        });
      }
    }
  }

  return { available, notes, secrets, providers };
}

/**
 * Match priority entries against available models.
 * Case-insensitive substring match.
 * Resolution = first priority entry matching an available <provider>/<model>.
 * If no priority match succeeds among available models, use the neutral fallback marker.
 */
export function resolveOracleModel(priorityEntries, availableModels) {
  for (const entry of priorityEntries) {
    const target = entry.match.toLowerCase();
    for (const avail of availableModels) {
      const qualifiedLower = avail.qualified.toLowerCase();
      const modelLower = avail.model.toLowerCase();
      // Case-insensitive substring match against qualified or model ID
      if (qualifiedLower.includes(target) || modelLower.includes(target)) {
        return {
          resolved: avail.qualified,
          matchedEntry: entry.match,
          isFallback: false,
          source: avail.source,
        };
      }
    }
  }

  // Модель-агностичный резерв: берём первую доступную модель ЛЮБОГО провайдера.
  // Прибитой к вендору модели здесь нет намеренно — воркфлоу не должен ломаться
  // на Ollama, Claude, локальных моделях или любом другом провайдере.
  if (availableModels.length > 0) {
    const first = availableModels[0];
    return {
      resolved: first.qualified,
      matchedEntry: "(first available)",
      isFallback: true,
      source: first.source,
    };
  }

  // Ничего не доступно — модель не выдумываем: вызывающий обязан НЕ писать config.yml.
  return {
    resolved: null,
    matchedEntry: null,
    isFallback: true,
    source: "none",
  };
}

/**
 * Targeted update of config.yml:
 * Replaces ONLY the value after 'oracle:' under:
 * - modelRoles:
 * - task.agentModelOverrides:
 * Preserves every other byte, comments, blank lines, and line endings (CRLF or LF).
 * Idempotent.
 */
export function updateConfigYaml(content, newOracleValue) {
  // Detect line ending
  const isCrlf = content.includes("\r\n");
  const eol = isCrlf ? "\r\n" : "\n";

  const lines = content.split(/\r?\n/);
  let inModelRoles = false;
  let inTask = false;
  let inAgentModelOverrides = false;

  let modified = false;
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check top-level sections (no leading whitespace)
    const topMatch = line.match(/^([a-zA-Z0-9_-]+):\s*$/);
    if (topMatch) {
      const section = topMatch[1];
      inModelRoles = (section === "modelRoles");
      inTask = (section === "task");
      inAgentModelOverrides = false;
      newLines.push(line);
      continue;
    }

    // Check under task: section
    if (inTask) {
      // 2-space indented key under task
      const taskChildMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      if (taskChildMatch) {
        inAgentModelOverrides = (taskChildMatch[1] === "agentModelOverrides");
        newLines.push(line);
        continue;
      }
      // Out of 2-space task section if less indent or different structure
      if (line.match(/^[^\s]/)) {
        inTask = false;
        inAgentModelOverrides = false;
      }
    }

    // Replace oracle under modelRoles
    if (inModelRoles) {
      const oracleMatch = line.match(/^(\s+oracle:\s*)(["']?)([^"'\r\n#]+)(["']?)(.*)$/);
      if (oracleMatch) {
        const prefix = oracleMatch[1];
        const oldVal = oracleMatch[3].trim();
        const suffix = oracleMatch[5]; // trailing comment or space
        if (oldVal !== newOracleValue) {
          line = `${prefix}${newOracleValue}${suffix}`;
          modified = true;
        }
        newLines.push(line);
        continue;
      }
    }

    // Replace oracle under task.agentModelOverrides
    if (inTask && inAgentModelOverrides) {
      const oracleMatch = line.match(/^(\s+oracle:\s*)(["']?)([^"'\r\n#]+)(["']?)(.*)$/);
      if (oracleMatch) {
        const prefix = oracleMatch[1];
        const oldVal = oracleMatch[3].trim();
        const suffix = oracleMatch[5]; // trailing comment or space
        if (oldVal !== newOracleValue) {
          line = `${prefix}${newOracleValue}${suffix}`;
          modified = true;
        }
        newLines.push(line);
        continue;
      }
    }

    newLines.push(line);
  }

  return {
    content: newLines.join(eol),
    modified,
  };
}

/**
 * Main execution logic
 */
export async function run(argv) {
  const opts = parseArgs(argv);

  if (opts.help || !opts.command) {
    const helpText = `Использование: node oracle-model.mjs <command> [options]

Команды:
  list    Показать доступные модели и текущее разрешение oracle
  apply   Записать выбранную модель в config.yml
  ensure  Проверить config.yml и обновить при необходимости (идемпотентно)

Параметры:
  --config <path>    Путь к config.yml (по умолчанию: ~/.omp/agent/config.yml)
  --models <path>    Путь к models.yml (по умолчанию: ~/.omp/agent/models.yml)
  --priority <path>  Путь к oracle-priority.json
  --probe            Опрос GET {baseUrl}/models у всех провайдеров models.yml:
                     недостижимые помечаются, их модели исключаются из выбора
                     (ensure/apply не выберут модель провалившего провайдера)
  --dry-run          Не вносить изменений в config.yml
  --json             Вывод в формате JSON
`;
    process.stdout.write(helpText);
    return 0;
  }

  const userHome = homedir();
  const defaultModelsPath = join(userHome, ".omp", "agent", "models.yml");
  const defaultConfigPath = join(userHome, ".omp", "agent", "config.yml");

  const modelsPath = resolve(opts.models || defaultModelsPath);
  const configPath = resolve(opts.config || defaultConfigPath);
  const priorityPath = resolvePriorityFile(opts.priority);

  const priorityEntries = loadPriorityList(priorityPath);
  const { available, notes, secrets, providers } = await collectAvailableModels(modelsPath, opts.probe);
  const resolution = resolveOracleModel(priorityEntries, available);
  const unreachableProviders = Object.keys(providers).filter((n) => providers[n].reachable === false);

  // Read current config oracle if present
  let currentOracleConfig = null;
  if (existsSync(configPath)) {
    try {
      const cfgContent = readFileSync(configPath, "utf8");
      const m = cfgContent.match(/modelRoles:[\s\S]*?\s+oracle:\s*([^\s#]+)/);
      if (m) currentOracleConfig = m[1];
    } catch {
      // ignore
    }
  }

  if (opts.command === "list") {
    if (opts.json) {
      const outObj = {
        resolved: resolution.resolved,
        isFallback: resolution.isFallback,
        matchedEntry: resolution.matchedEntry,
        currentConfig: currentOracleConfig,
        available: available.map((a) => a.qualified),
        providers,
        unreachableProviders,
        priorityPath,
        modelsPath,
        notes,
      };
      const jsonStr = redactSecrets(JSON.stringify(outObj, null, 2), secrets);
      process.stdout.write(jsonStr + "\n");
      return 0;
    }

    let out = `Oracle Model Resolution:\n`;
    out += `  Выбранная модель : ${resolution.resolved}${resolution.isFallback ? " (fallback)" : ""}\n`;
    out += `  Совпадение       : ${resolution.matchedEntry}\n`;
    out += `  Текущая в config : ${currentOracleConfig || "(не задана)"}\n`;
    out += `  Файл приоритетов : ${priorityPath}\n`;
    out += `  Доступные модели : ${available.length > 0 ? available.map((a) => a.qualified).join(", ") : "(нет доступных моделей)"}\n`;
    if (opts.probe && Object.keys(providers).length > 0) {
      const statuses = Object.keys(providers).map((name) => {
        const p = providers[name];
        if (p.reachable === null) return `${name}: не опрошен`;
        return p.reachable
          ? `${name}: доступен (${p.discovered} моделей по /models)`
          : `${name}: НЕДОСТУПЕН (${p.error})`;
      });
      out += `  Провайдеры       : ${statuses.join(", ")}\n`;
    }
    if (notes.length > 0) {
      out += `  Заметки          :\n` + notes.map((n) => `    - ${n}`).join("\n") + "\n";
    }
    process.stdout.write(redactSecrets(out, secrets));
    return 0;
  }

  if (opts.command === "apply" || opts.command === "ensure") {
    // С --probe модель, чей провайдер провалил опрос, не выбирается: запись её в
    // config.yml — ровно тот сценарий, когда все спавны падают на 429/401.
    const resolvedProvider = resolution.resolved && resolution.resolved.includes("/")
      ? resolution.resolved.slice(0, resolution.resolved.indexOf("/"))
      : null;
    // Модель не выбрана: нет ни приоритетного совпадения, ни доступных моделей.
    // Ничего не пишем — иначе на чужом провайдере в config.yml уехала бы мёртвая модель.
    if (!resolution.resolved) {
      // Если причина — мёртвые провайдеры, называем их: это самая полезная часть отказа.
      const noModel = unreachableProviders.length > 0
        ? `Модель не выбрана: недостижимы провайдеры ${unreachableProviders.join(", ")}. config.yml не изменён.`
        : "Модель не выбрана: ни один приоритет не совпал, доступных моделей нет. config.yml не изменён.";
      if (opts.json) {
        process.stdout.write(
          redactSecrets(
            JSON.stringify({ ok: false, error: noModel, resolved: null, unreachableProviders, providers, notes }, null, 2),
            secrets
          ) + "\n"
        );
      } else {
        process.stderr.write(redactSecrets(`[XX] ${noModel}\n`, secrets));
      }
      return 1;
    }

    const selectedProviderDead = resolvedProvider
      ? providers[resolvedProvider]?.reachable === false
      : false;
    const fallbackWithoutProvider = resolution.source === "none" && unreachableProviders.length > 0;

    if (opts.probe && (selectedProviderDead || fallbackWithoutProvider)) {
      const errMessage = `Модель ${resolution.resolved} не выбрана: недостижимы провайдеры ${unreachableProviders.join(", ")}. config.yml не изменён.`;
      if (opts.json) {
        process.stdout.write(
          redactSecrets(
            JSON.stringify(
              { ok: false, error: errMessage, resolved: resolution.resolved, unreachableProviders, providers, notes },
              null,
              2
            ),
            secrets
          ) + "\n"
        );
      } else {
        process.stderr.write(redactSecrets(`[XX] ${errMessage}\n`, secrets));
      }
      return 1;
    }

    let applied = false;
    let errMessage = null;

    if (!existsSync(configPath)) {
      errMessage = `Файл конфигурации не найден: ${configPath}`;
      if (opts.json) {
        process.stdout.write(redactSecrets(JSON.stringify({ error: errMessage, ok: false }, null, 2), secrets) + "\n");
      } else {
        process.stderr.write(redactSecrets(`[XX] ${errMessage}\n`, secrets));
      }
      return 1;
    }

    try {
      const cfgContent = readFileSync(configPath, "utf8");
      const { content: updatedContent, modified } = updateConfigYaml(cfgContent, resolution.resolved);

      if (modified) {
        if (!opts.dryRun) {
          writeFileSync(configPath, updatedContent, "utf8");
        }
        applied = true;
      }
    } catch (err) {
      errMessage = `Ошибка обновления config.yml: ${err.message}`;
      if (opts.json) {
        process.stdout.write(redactSecrets(JSON.stringify({ error: errMessage, ok: false }, null, 2), secrets) + "\n");
      } else {
        process.stderr.write(redactSecrets(`[XX] ${errMessage}\n`, secrets));
      }
      return 1;
    }

    if (opts.json) {
      const outObj = {
        resolved: resolution.resolved,
        isFallback: resolution.isFallback,
        matchedEntry: resolution.matchedEntry,
        applied: applied && !opts.dryRun,
        dryRun: opts.dryRun,
        unreachableProviders,
        notes,
      };
      process.stdout.write(redactSecrets(JSON.stringify(outObj, null, 2), secrets) + "\n");
      return 0;
    }

    let out = "";
    if (applied) {
      out = opts.dryRun
        ? `[dry-run] Oracle модель будет обновлена на: ${resolution.resolved}\n`
        : `[ok] Oracle модель обновлена на: ${resolution.resolved}\n`;
    } else {
      out = `[ok] Oracle модель уже актуальна: ${resolution.resolved}\n`;
    }
    if (resolution.isFallback) {
      out += `  (Использован fallback: ${FALLBACK_MODEL})\n`;
    }
    if (notes.length > 0) {
      out += notes.map((n) => `  [!] ${n}`).join("\n") + "\n";
    }
    process.stdout.write(redactSecrets(out, secrets));
    return 0;
  }

  process.stderr.write(`Неизвестная команда: ${opts.command}\n`);
  return 1;
}

// CLI entry point
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  run(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err) => {
    process.stderr.write(`Необработанная ошибка: ${err.message}\n`);
    process.exit(1);
  });
}
