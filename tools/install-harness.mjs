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
} from "node:fs";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

export const SUPPORTED_HARNESSES = ["claude", "codex", "opencode", "cursor", "omp", "all", "auto"];

export function isCommandInPath(cmd) {
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

export function detectHarness({ userHome = homedir() } = {}) {
  if (existsSync(join(userHome, ".claude"))) return "claude";
  if (existsSync(join(userHome, ".codex"))) return "codex";
  if (existsSync(join(userHome, ".opencode"))) return "opencode";
  if (existsSync(join(userHome, ".cursor"))) return "cursor";
  if (isCommandInPath("omp")) return "omp";
  return "omp";
}

export function getDefaultRoot(harness, userHome) {
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

export function getMarkdownAdapter(slashRoot, title = "Workflow & Orchestration Adapter") {
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
    `- Верификация/тесты: \`node '${slashRoot}/tools/workflow.mjs' artifact --kind verification --path ...\``,
    "",
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

export function getCursorAdapter(slashRoot) {
  return [
    "---",
    "description: Workflow & Orchestration Rules",
    "alwaysApply: true",
    "---",
    getMarkdownAdapter(slashRoot, "Cursor Workflow Adapter"),
  ].join("\n");
}

export function getOpencodeJson(existingPath) {
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

function copyAndSubstitute(srcPath, destPath, slashRoot) {
  const isText = /\.(md|mjs|js|cjs|json|ya?ml|ps1|sh|txt|env|example)$/i.test(srcPath);
  if (isText) {
    let content = readFileSync(srcPath, "utf8");
    if (content.includes("<HARNESS>")) {
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
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__tmp__") {
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

export function parseCliArgs(argv) {
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

export function installHarness(options = {}) {
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
  const coreDirs = ["agent", "rules", "tools", "core", "templates", "skills"];
  const coreFiles = ["CONTEXT.md", "README.md", "secrets.example.env", "verify.ps1"];

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
        writeAdapter(rootPath, getMarkdownAdapter(slashRoot, "Claude Code Workflow Adapter"));
        if (shouldWriteHome) {
          const homePath = join(userHome, ".claude", "CLAUDE.md");
          writeAdapter(homePath, getMarkdownAdapter(slashRoot, "Claude Code Workflow Adapter"));
        }
        break;
      }
      case "codex": {
        const rootPath = join(targetRoot, "AGENTS.md");
        writeAdapter(rootPath, getMarkdownAdapter(slashRoot, "Codex Workflow Adapter"));
        if (shouldWriteHome) {
          const homePath = join(userHome, ".codex", "AGENTS.md");
          writeAdapter(homePath, getMarkdownAdapter(slashRoot, "Codex Workflow Adapter"));
        }
        break;
      }
      case "opencode": {
        const rootAgents = join(targetRoot, "AGENTS.md");
        const rootJson = join(targetRoot, "opencode.json");
        writeAdapter(rootAgents, getMarkdownAdapter(slashRoot, "OpenCode Workflow Adapter"));
        writeAdapter(rootJson, getOpencodeJson(rootJson));
        if (shouldWriteHome) {
          const homeAgents = join(userHome, ".opencode", "AGENTS.md");
          const homeJson = join(userHome, ".opencode", "opencode.json");
          writeAdapter(homeAgents, getMarkdownAdapter(slashRoot, "OpenCode Workflow Adapter"));
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
        const rootAgents = join(targetRoot, "agent", "AGENTS.md");
        writeAdapter(rootAgents, getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law"));
        if (shouldWriteHome) {
          const homeAgentDir = join(userHome, ".omp", "agent");
          const homeAgents = join(homeAgentDir, "AGENTS.md");
          const harnessRootPtr = join(homeAgentDir, ".harness-root");
          writeAdapter(homeAgents, getMarkdownAdapter(slashRoot, "Oh My Pi Orchestrator Law"));
          writeAdapter(harnessRootPtr, `${targetRoot}\n`);
        }
        break;
      }
    }
  }

  return plan;
}

export function printHelp() {
  console.log(`
Workflow Harness Portable Installer

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

export function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const plan = installHarness(options);

    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      process.exit(0);
    }

    if (options.dryRun) {
      console.log(`[dry-run] Plan for workflow harness installation:`);
      console.log(`  Harness:      ${plan.harness}`);
      console.log(`  Install root: ${plan.root}`);
      console.log(`  Files count:  ${plan.filesToCopy.length}`);
      console.log(`  Adapters:`);
      for (const adapter of plan.adapters) {
        console.log(`    - ${adapter}`);
      }
      process.exit(0);
    }

    console.log(`\n=== Workflow Harness Installer ===`);
    console.log(`  Harness:      ${plan.harness}`);
    console.log(`  Install root: ${plan.root}`);
    console.log(`  Files copied: ${plan.filesToCopy.length}`);
    console.log(`  Adapters:`);
    for (const adapter of plan.adapters) {
      console.log(`    [ok] ${adapter}`);
    }
    console.log(`Installation complete.\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
