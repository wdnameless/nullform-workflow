#!/usr/bin/env node
/**
 * tools/install-harness.mjs — Cross-platform orchestrator installer for any harness.
 *
 * Supported harnesses:
 *   - claude   (Claude Code -> CLAUDE.md)
 *   - codex    (Codex -> AGENTS.md)
 *   - opencode (OpenCode -> AGENTS.md + opencode.json)
 *   - cursor   (Cursor -> .cursor/rules/00-workflow.mdc)
 *   - omp      (Oh My Pi -> ~/.omp/agent/AGENTS.md)
 *   - all      (All adapters)
 *   - auto     (Auto-detect: ~/.claude, ~/.codex, ~/.opencode, ~/.cursor, omp in PATH; fallback: omp)
 *
 * Options:
 *   --harness <name>    Target harness (default: auto)
 *   --root <dir>        Installation root directory (default: harness default directory)
 *   --user-home <dir>   User home directory override
 *   --dry-run           Preview actions without writing to disk
 *   --json              Machine-readable JSON output
 *   --help, -h          Show help
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SUPPORTED_HARNESSES = ["claude", "codex", "opencode", "cursor", "omp", "all", "auto"];

function isCommandInPath(cmd) {
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = pathEnv.split(sep);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = join(dir, cmd + ext);
      try {
        if (existsSync(full)) return true;
      } catch {}
    }
  }
  return false;
}

function detectHarness({ userHome = homedir() } = {}) {
  if (existsSync(join(userHome, ".claude"))) return "claude";
  if (existsSync(join(userHome, ".codex"))) return "codex";
  if (existsSync(join(userHome, ".opencode"))) return "opencode";
  if (existsSync(join(userHome, ".cursor"))) return "cursor";
  if (isCommandInPath("omp")) return "omp";
  return "omp";
}

function getDefaultRoot(harness, userHome) {
  switch (harness) {
    case "claude":
      return join(userHome, ".claude", "workflow");
    case "codex":
      return join(userHome, ".codex", "workflow");
    case "opencode":
      return join(userHome, ".opencode", "workflow");
    case "cursor":
      return join(userHome, ".cursor", "workflow");
    case "omp":
    case "all":
    case "auto":
    default:
      return join(userHome, "omp-workflow");
  }
}

function getMarkdownAdapter(slashRoot, title = "NULLFORM WORKFLOW Adapter") {
  return [
    `# ${title}`,
    "",
    `Полный свод законов и протокол оркестратора: ${slashRoot}/agent/AGENTS.md`,
    "",
    "## 1. Запуск задачи и гейты (T0–T3)",
    "Перед изменением любых файлов определите tier и зафиксируйте задачу:",
    `- \`node '${slashRoot}/tools/workflow.mjs' start --tier <T0|T1|T2|T3> --task "<описание>"\``,
    `- \`node '${slashRoot}/tools/workflow.mjs' check\` (exit 1 при отсутствии обязательных артефактов)`,
    `- \`node '${slashRoot}/tools/workflow.mjs' close\` (фиксирует завершение задачи)`,
    "",
    "Уровни (Lanes):",
    "- `⚡ [T0 FAST]`: 1–2 известных файла, точечные правки, без OpenSpec/интервью/oracle.",
    "- `🔧 [T1 STANDARD]`: 3+ файлов, микро-план в чате, 1–2 специалиста.",
    "- `🚀 [T2 HEAVY]`: архитектура/новые модули. 4-Wave SDD: Wave 0 (интервью) -> манифест (R##) -> OpenSpec -> TDD build -> blind Oracle.",
    "- `🌌 [T3 PROGRAM]`: мульти-фича программа (T2 на каждый слайс).",
    "",
    "## 2. Фиксация артефактов",
    `- Манифест требований: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind manifest --path openspec/changes/<id>/manifest.md\``,
    `- Спецификация/OpenSpec: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind openspec --path openspec/changes/<id>\``,
    `- Границы и интерфейсы: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind interfaces --path openspec/changes/<id>/interfaces.md\``,
    `- Вердикт оракула: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind oracle --detail "ACCEPT: <причина>"\``,
    "## 3. Дашборд наблюдаемости",
    "При `workflow.mjs start` автоматически запускается фоновый дашборд.",
    "- URL хранится в `.workflow/dashboard.json`",
    `- Получить URL: \`node '${slashRoot}/tools/dashboard.mjs' --url\``,
    "",
    "## 4. Базовые законы",
    "- Честность: никаких заявлений о готовности без выполненных проверок.",
    "- Анализ до кода: инвентаризация существующего кода (reuse > extend > create).",
    "- Ladder решений: reuse -> stdlib -> platform -> installed dep -> 1 line -> minimum.",
    "- Возвратный контракт (≤25 строк): STATUS | FILES | TESTS было->стало | CONCERNS.",
    "",
  ].join("\n");
}

function getCursorAdapter(slashRoot) {
  return [
    "---",
    "description: NULLFORM WORKFLOW Rules",
    "alwaysApply: true",
    "---",
    getMarkdownAdapter(slashRoot, "Cursor NULLFORM WORKFLOW Adapter"),
  ].join("\n");
}

function getOpencodeJson(existingPath) {
  let cfg = {};
  if (existingPath && existsSync(existingPath)) {
    try {
      cfg = JSON.parse(readFileSync(existingPath, "utf8"));
    } catch {}
  }
  if (!cfg.instructions) {
    cfg.instructions = ["AGENTS.md"];
  } else if (Array.isArray(cfg.instructions)) {
    if (!cfg.instructions.includes("AGENTS.md")) {
      cfg.instructions.push("AGENTS.md");
    }
  } else if (typeof cfg.instructions === "string") {
    if (cfg.instructions !== "AGENTS.md") {
      cfg.instructions = [cfg.instructions, "AGENTS.md"];
    }
  }
  if (!cfg["$schema"]) {
    cfg["$schema"] = "https://opencode.ai/config.json";
  }
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * `<HARNESS>` is resolved ONLY inside prompt surfaces (agent/, rules/, skills/) —
 * the same scope install.ps1 and tools/sync.* use. Substituting it inside tools/
 * too would (a) make every installed tool differ from its repo template, so
 * `sync` reports permanent drift, and (b) let `sync --promote` write this
 * machine's absolute path back into the repository.
 */
function isPromptSurface(srcPath) {
  const rel = relative(REPO_ROOT, srcPath);
  return /^(agent|rules|skills)[\\/]/.test(rel) || /(?:^|[\\/])(agent|rules|skills)[\\/]/.test(srcPath);
}

function copyAndSubstitute(srcPath, destPath, slashRoot) {
  // Installing over the source tree itself (`--root .` from the clone) must not
  // rewrite the repository's own files: the repo ships prompt surfaces with the
  // <HARNESS> placeholder, and substituting it there would leave a dirty clone
  // and bake this machine's path into the canonical templates.
  if (resolve(srcPath) === resolve(destPath)) return;

  const isText = /\.(md|mjs|js|cjs|json|ya?ml|ps1|sh|txt|env|example)$/i.test(srcPath);
  if (isText) {
    let content = readFileSync(srcPath, "utf8");
    if (content.includes("<HARNESS>") && isPromptSurface(srcPath)) {
      content = content.split("<HARNESS>").join(slashRoot);
    }
    writeFileSync(destPath, content, "utf8");
  } else {
    copyFileSync(srcPath, destPath);
  }
}

function copyDirRecursive(srcDir, destDir, slashRoot, planOnly = false) {
  const copied = [];
  if (!existsSync(srcDir)) return copied;

  function walk(currentSrc, currentDest) {
    const entries = readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__tmp__" ||
          entry.name === "__pycache__" || entry.name === ".tmp") {
        continue;
      }
      const srcPath = join(currentSrc, entry.name);
      const destPath = join(currentDest, entry.name);

      if (entry.isDirectory()) {
        if (!planOnly) {
          mkdirSync(destPath, { recursive: true });
        }
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        copied.push(destPath);
        if (!planOnly) {
          mkdirSync(dirname(destPath), { recursive: true });
          copyAndSubstitute(srcPath, destPath, slashRoot);
        }
      }
    }
  }

  walk(srcDir, destDir);
  return copied;
}

/**
 * Link the role roster into the user home, falling back to a copy when the OS
 * refuses symlinks (Windows without Developer Mode/privilege). A REAL directory
 * at the destination is left untouched — it may hold the user's own agent defs —
 * and an existing link is only ever unlinked (unlink), never recursively
 * deleted, so the harness tree it points at can never be wiped through it.
 */
function installRoleRoster(linkTarget, destDir, slashRoot, planOnly = false) {
  if (planOnly) return [destDir];
  try {
    // lstat, not existsSync: existsSync follows the link and reports `false` for a
    // DANGLING one (harness moved or deleted), after which mkdir on that path
    // fails with ENOENT and the whole install aborts. A dangling link is exactly
    // what a re-install after moving the harness finds, so detect and replace it.
    let stat = null;
    try {
      stat = lstatSync(destDir);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isSymbolicLink()) return []; // a real dir: the user's own defs
      if (existsSync(destDir) &&
          resolve(dirname(destDir), readlinkSync(destDir)) === resolve(linkTarget)) {
        return [];
      }
      unlinkSync(destDir);
    }
    mkdirSync(dirname(destDir), { recursive: true });
    symlinkSync(linkTarget, destDir, process.platform === "win32" ? "junction" : "dir");
    return [destDir];
  } catch {
    return copyDirRecursive(linkTarget, destDir, slashRoot, false);
  }
}

/**
 * Skills registry: ~/.agents/skills is the tree the harness actually loads, so
 * copying into the harness root alone installs nothing. Marketplace-locked
 * skills (installed and recorded in ~/.agents/.skill-lock.json) and skills the
 * operator disabled on purpose are skipped — an install must not desync the
 * lock file or resurrect what was pruned.
 */
function installSkills(srcDir, destDir, slashRoot, agentsHome, planOnly = false) {
  if (!existsSync(srcDir)) return [];
  const skip = new Set();
  try {
    const locked = JSON.parse(readFileSync(join(agentsHome, ".skill-lock.json"), "utf8"));
    for (const name of Object.keys(locked.skills || {})) {
      if (existsSync(join(destDir, name, "SKILL.md"))) skip.add(name);
    }
  } catch {}
  try {
    const disabled = JSON.parse(readFileSync(join(agentsHome, ".skills-disabled.json"), "utf8"));
    for (const name of disabled.disabled || []) {
      if (typeof name === "string") skip.add(name);
    }
  } catch {}

  const out = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    out.push(...copyDirRecursive(join(srcDir, entry.name), join(destDir, entry.name), slashRoot, planOnly));
  }
  return out;
}

export function translateStdioEntry(entry, platform = process.platform) {
  if (!entry || typeof entry !== "object") return entry;
  const isWin = platform === "win32";
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? [...entry.args] : [];

  if (isWin) {
    if (typeof cmd === "string" && cmd.toLowerCase() === "cmd.exe") {
      return { ...entry, command: cmd, args };
    }
    if (cmd) {
      return { ...entry, command: "cmd.exe", args: ["/c", cmd, ...args] };
    }
    return { ...entry, args };
  }
  if (typeof cmd === "string" && (cmd.toLowerCase() === "cmd.exe" || cmd.toLowerCase() === "cmd")) {
    if (args[0] && args[0].toLowerCase() === "/c") {
      return { ...entry, command: args[1] || "", args: args.slice(2) };
    }
  }
  return { ...entry, command: cmd, args };
}

export const translateMcpEntry = translateStdioEntry;

function isStrictlyInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function parseCliArgs(argv) {
  const options = {
    harness: "auto",
    root: "",
    userHome: "",
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--harness") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for --harness");
      }
      options.harness = argv[++i];
    } else if (arg.startsWith("--harness=")) {
      options.harness = arg.slice("--harness=".length);
    } else if (arg === "--root") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for --root");
      }
      options.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--user-home") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for --user-home");
      }
      options.userHome = argv[++i];
    } else if (arg.startsWith("--user-home=")) {
      options.userHome = arg.slice("--user-home=".length);
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }

  return options;
}

function installHarness(options = {}) {
  const userHome = options.userHome
    ? resolve(options.userHome)
    : process.env.USERPROFILE || process.env.HOME || homedir();

  const rawHarness = options.harness || "auto";
  if (!SUPPORTED_HARNESSES.includes(rawHarness)) {
    throw new Error(
      `Unknown harness "${rawHarness}". Supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}.`
    );
  }

  const selectedHarness = rawHarness === "auto" ? detectHarness({ userHome }) : rawHarness;
  const targetRoot = options.root
    ? resolve(options.root)
    : getDefaultRoot(selectedHarness, userHome);
  const slashRoot = targetRoot.replace(/\\/g, "/");

  if (isStrictlyInside(REPO_ROOT, targetRoot)) {
    throw new Error(
      `Cannot install harness into a subdirectory of the repository root ("${targetRoot}"). ` +
      `Use in-place install with "--root ." or specify a destination outside "${REPO_ROOT}".`
    );
  }

  const targetHarnesses =
    selectedHarness === "all"
      ? ["claude", "codex", "opencode", "cursor", "omp"]
      : [selectedHarness];

  const plan = {
    harness: selectedHarness,
    root: targetRoot,
    userHome,
    dryRun: Boolean(options.dryRun),
    filesToCopy: [],
    adapters: [],
  };

  // 1. Identify core files to copy
  const coreDirs = ["agent", "rules", "tools", "core", "templates", "skills", "paseo"];
  // install.ps1/install.sh deliberately stay behind: audit/sync decide whether a
  // tree is a repo clone or an installed harness by looking for install.ps1, so
  // shipping it into the harness would make a standalone install look like a repo.
  const coreFiles = [
    ".code-size.baseline.json",
    "CONTEXT.md",
    "README.md",
    "secrets.example.env",
    "verify.ps1",
    "verify.sh",
  ];

  for (const dir of coreDirs) {
    const srcDir = join(REPO_ROOT, dir);
    const destDir = join(targetRoot, dir);
    if (existsSync(srcDir)) {
      const copied = copyDirRecursive(srcDir, destDir, slashRoot, options.dryRun);
      plan.filesToCopy.push(...copied);
    }
  }

  for (const file of coreFiles) {
    const srcFile = join(REPO_ROOT, file);
    const destFile = join(targetRoot, file);
    if (existsSync(srcFile)) {
      plan.filesToCopy.push(destFile);
      if (!options.dryRun) {
        mkdirSync(dirname(destFile), { recursive: true });
        copyAndSubstitute(srcFile, destFile, slashRoot);
      }
    }
  }

  // 2. Identify & generate adapters
  const writeAdapter = (filePath, content) => {
    plan.adapters.push(filePath);
    if (!options.dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    }
  };

  const shouldWriteHome = Boolean(options.userHome || !options.root);

  for (const h of targetHarnesses) {
    switch (h) {
      case "claude": {
        const rootPath = join(targetRoot, "CLAUDE.md");
        writeAdapter(rootPath, getMarkdownAdapter(slashRoot, "Claude Code NULLFORM WORKFLOW Adapter"));
        if (shouldWriteHome) {
          const homePath = join(userHome, ".claude", "CLAUDE.md");
          writeAdapter(homePath, getMarkdownAdapter(slashRoot, "Claude Code NULLFORM WORKFLOW Adapter"));
        }
        break;
      }
      case "codex": {
        const rootPath = join(targetRoot, "AGENTS.md");
        writeAdapter(rootPath, getMarkdownAdapter(slashRoot, "Codex NULLFORM WORKFLOW Adapter"));
        if (shouldWriteHome) {
          const homePath = join(userHome, ".codex", "AGENTS.md");
          writeAdapter(homePath, getMarkdownAdapter(slashRoot, "Codex NULLFORM WORKFLOW Adapter"));
        }
        break;
      }
      case "opencode": {
        const rootAgents = join(targetRoot, "AGENTS.md");
        const rootJson = join(targetRoot, "opencode.json");
        writeAdapter(rootAgents, getMarkdownAdapter(slashRoot, "OpenCode NULLFORM WORKFLOW Adapter"));
        writeAdapter(rootJson, getOpencodeJson(rootJson));
        if (shouldWriteHome) {
          const homeAgents = join(userHome, ".opencode", "AGENTS.md");
          const homeJson = join(userHome, ".opencode", "opencode.json");
          writeAdapter(homeAgents, getMarkdownAdapter(slashRoot, "OpenCode NULLFORM WORKFLOW Adapter"));
          writeAdapter(homeJson, getOpencodeJson(homeJson));
        }
        break;
      }
      case "cursor": {
        const rootMdc = join(targetRoot, ".cursor", "rules", "00-workflow.mdc");
        writeAdapter(rootMdc, getCursorAdapter(slashRoot));
        if (shouldWriteHome) {
          const homeMdc = join(userHome, ".cursor", "rules", "00-workflow.mdc");
          writeAdapter(homeMdc, getCursorAdapter(slashRoot));
        }
        break;
      }
      case "omp": {
        // agent/AGENTS.md is the FULL orchestrator law (copied above, <HARNESS>
        // resolved). Never overwrite it with the short adapter: that would leave
        // an installed harness whose law file is a stub while the real protocol
        // file is replaced.
        const lawSource = join(REPO_ROOT, "agent", "AGENTS.md");
        const lawPath = join(targetRoot, "agent", "AGENTS.md");
        const law = existsSync(lawSource)
          ? readFileSync(lawSource, "utf8").split("<HARNESS>").join(slashRoot)
          : getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law");
        // In-place install (`--root .` from the clone): the harness root IS the
        // repo, so leave the template's <HARNESS> placeholder alone — writing the
        // resolved law back would dirty the clone and bake this machine's path
        // into the canonical template.
        if (resolve(lawPath) !== resolve(lawSource)) {
          if (!options.dryRun) {
            mkdirSync(dirname(lawPath), { recursive: true });
            writeFileSync(lawPath, law, "utf8");
          }
          plan.adapters.push(lawPath);
        }
        if (shouldWriteHome) {
          const homeAgentDir = join(userHome, ".omp", "agent");
          const agentsHome = join(userHome, ".agents");
          writeAdapter(join(homeAgentDir, "AGENTS.md"), law);
          writeAdapter(join(homeAgentDir, ".harness-root"), `${targetRoot}\n`);
          // Seed mcp.json from the example, as install.ps1 does. Without it the
          // freshly installed harness fails its own verification (`mcp.json parses`
          // and `mandatory MCP servers present`), and `chrome-devtools` — the one
          // server marked mandatory — would never be declared on this path.
          // Placeholder-valued servers are dropped: an absent server is better than
          // one that fails to connect on every session boot.
          const mcpTarget = join(homeAgentDir, "mcp.json");
          if (!existsSync(mcpTarget)) {
            try {
              const cfg = JSON.parse(readFileSync(join(REPO_ROOT, "agent", "mcp.json.example"), "utf8"));
              // Drop any server still carrying an unsubstituted placeholder: there is
              // no secrets.env on this path, so a kept entry would ship a literal
              // `__X__` into mcp.json (which verification then flags) and fail to
              // connect on every session boot.
              for (const [name, entry] of Object.entries(cfg.mcpServers || {})) {
                if (JSON.stringify(entry).includes("__")) {
                  delete cfg.mcpServers[name];
                } else {
                  cfg.mcpServers[name] = translateStdioEntry(entry);
                }
              }
              writeAdapter(mcpTarget, JSON.stringify(cfg, null, 2) + "\n");
            } catch {}
          }
          // Without these the installed harness has no roles, no skills and no
          // rules: OMP cannot start the orchestrator at all.
          plan.filesToCopy.push(
            ...installRoleRoster(
              join(targetRoot, "agent", "agents"),
              join(homeAgentDir, "agents"),
              slashRoot,
              options.dryRun
            )
          );
          for (const dst of [join(homeAgentDir, "rules"), join(agentsHome, "rules")]) {
            plan.filesToCopy.push(...copyDirRecursive(join(targetRoot, "rules"), dst, slashRoot, options.dryRun));
          }
          plan.filesToCopy.push(
            ...installSkills(
              join(targetRoot, "skills"),
              join(agentsHome, "skills"),
              slashRoot,
              agentsHome,
              options.dryRun
            )
          );
          // Native OMP extension for automatic JEV assistance: installed idempotently
          const jevSource = join(REPO_ROOT, "agent", "extensions", "nullform-jev.ts");
          const jevDest = join(homeAgentDir, "extensions", "nullform-jev.ts");
          if (existsSync(jevSource)) {
            if (!options.dryRun) {
              mkdirSync(dirname(jevDest), { recursive: true });
              copyFileSync(jevSource, jevDest);
            }
            plan.filesToCopy.push(jevDest);
          }
        }
        break;
      }
    }
  }

  // 3. Prompt-cache baseline, as install.ps1 does. Without it the first audit on a
  // POSIX install reports `n/a (no baseline)` and later cache-prefix drift — the
  // change that silently re-bills every session at full price — goes unnoticed.
  const promptLint = join(targetRoot, "tools", "prompt-lint.mjs");
  if (!options.dryRun && existsSync(promptLint)) {
    try {
      runPromptLintBaseline(promptLint, targetRoot, userHome);
      plan.baselineRecorded = true;
    } catch {
      plan.baselineRecorded = false;
    }
  }

  return plan;
}

/**
 * `prompt-lint baseline` scans ~/.agents too, so both HOME and USERPROFILE are
 * pointed at the user home being installed into — a sandbox install must not
 * record the operator's real machine, or the first audit reports every skill as
 * added/removed.
 */
function runPromptLintBaseline(promptLint, harnessRoot, userHome) {
  spawnSync(process.execPath, [promptLint, "baseline", "--root", harnessRoot], {
    encoding: "utf8",
    windowsHide: process.platform === "win32",
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
  });
}

function printHelp() {
  console.log(`
NULLFORM WORKFLOW Harness Portable Installer

Usage:
  node tools/install-harness.mjs [options]

Options:
  --harness <name>    Harness to configure: claude, codex, opencode, cursor, omp, all, auto (default: auto)
  --root <dir>        Installation root directory (default: harness default directory)
  --user-home <dir>   User home directory override
  --dry-run           Preview installation plan without writing any files
  --json              Output result as JSON
  --help, -h          Show this help message
`.trim());
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  try {
    const plan = installHarness(options);

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      process.exitCode = 0;
      return;
    }

    if (options.dryRun) {
      console.log(`[dry-run] Plan for NULLFORM WORKFLOW harness installation:`);
      console.log(`  Harness:      ${plan.harness}`);
      console.log(`  Install root: ${plan.root}`);
      console.log(`  Files count:  ${plan.filesToCopy.length}`);
      console.log(`  Adapters:`);
      for (const adapter of plan.adapters) {
        console.log(`    - ${adapter}`);
      }
      process.exitCode = 0;
      return;
    }

    console.log(`\n=== NULLFORM WORKFLOW Installer ===`);
    console.log(`  Harness:      ${plan.harness}`);
    console.log(`  Install root: ${plan.root}`);
    console.log(`  Files copied: ${plan.filesToCopy.length}`);
    console.log(`  Adapters:`);
    for (const adapter of plan.adapters) {
      console.log(`    [ok] ${adapter}`);
    }
    console.log(`Installation complete.\n`);
    process.exitCode = 0;
    return;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
}

if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  main();
}

export { installHarness };
