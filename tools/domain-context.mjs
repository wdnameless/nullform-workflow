#!/usr/bin/env node
/**
 * domain-context.mjs — сборщик контекста предметной области (Domain Context Collector).
 *
 * Использование:
 *   node tools/domain-context.mjs --domain <name> [--root <dir>] [--json] [--max-files 15] [--no-gh]
 *
 * Собирает:
 *   1) Файлы, путь которых содержит токен домена (без учета регистра), либо файлы из .codemap/state.json
 *      для папки, совпадающей с доменом (предпочтение отдается файлам из src/**, макс 15 с пометкой об усечении).
 *   2) git log --oneline -8 -- <paths> (пропуск, если не репозиторий).
 *   3) Связанные issue через gh issue list --search "<domain>" --limit 5 ТОЛЬКО когда gh существует и есть remote.
 *   4) Секция NOTES (ограничения, пропущенные источники, заметки).
 *
 * Коды возврата:
 *   0 — успех (всегда при наличии --domain, даже если источников нет).
 *   2 — отсутствует обязательный параметр --domain.
 *
 * Требования: Node 18+, без внешних зависимостей, RU текст / --json.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_FILES = 15;

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".archmap",
  ".codemap",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

/**
 * Проверяет, игнорируется ли директория.
 */
function isIgnored(dirName) {
  return IGNORE_DIRS.has(dirName) || (dirName.startsWith(".") && dirName !== ".");
}

/**
 * Рекурсивно собирает все файлы из директории.
 */
function walkFiles(dir, rootDir) {
  const results = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnored(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        const rel = relative(rootDir, fullPath).split(sep).join("/");
        results.push(rel);
      }
    }
  }

  return results;
}

/**
 * Поиск файлов по токену домена и .codemap/state.json.
 */
export function collectDomainFiles(root, domain, maxFiles = DEFAULT_MAX_FILES) {
  const token = domain.toLowerCase();
  const matchedSet = new Set();
  const notes = [];
  let codemapUsed = false;

  // 1. Проверяем наличие .codemap/state.json
  const codemapPath = join(root, ".codemap", "state.json");
  if (existsSync(codemapPath)) {
    try {
      const stateContent = readFileSync(codemapPath, "utf8");
      const state = JSON.parse(stateContent);
      if (state && state.files && typeof state.files === "object") {
        codemapUsed = true;
        for (const filePath of Object.keys(state.files)) {
          const norm = filePath.split("\\").join("/");
          const normLower = norm.toLowerCase();
          // Проверяем совпадение пути файла или папки с токеном домена
          if (normLower.includes(token)) {
            matchedSet.add(norm);
          }
        }
      }
    } catch (err) {
      notes.push(`Не удалось прочитать .codemap/state.json: ${err.message}`);
    }
  }

  // 2. Сканируем файлы в корневом каталоге
  try {
    const allFiles = walkFiles(root, root);
    for (const file of allFiles) {
      const norm = file.split("\\").join("/");
      if (norm.toLowerCase().includes(token)) {
        matchedSet.add(norm);
      }
    }
  } catch (err) {
    notes.push(`Ошибка сканирования файловой системы: ${err.message}`);
  }

  if (codemapUsed) {
    notes.push(`Использован .codemap/state.json для сопоставления папок и файлов домена.`);
  } else if (!existsSync(codemapPath)) {
    notes.push(`.codemap/state.json не найден (использовано прямое сканирование файловой системы).`);
  }

  const allMatched = Array.from(matchedSet);

  // Сортировка: предпочтение файлам из src/**, далее по алфавиту
  allMatched.sort((a, b) => {
    const aSrc = a.startsWith("src/") || a.includes("/src/");
    const bSrc = b.startsWith("src/") || b.includes("/src/");
    if (aSrc && !bSrc) return -1;
    if (!aSrc && bSrc) return 1;
    return a.localeCompare(b);
  });

  const totalFiles = allMatched.length;
  let truncated = false;
  let files = allMatched;

  if (totalFiles > maxFiles) {
    truncated = true;
    files = allMatched.slice(0, maxFiles);
    notes.push(`Найдено ${totalFiles} файлов по домену "${domain}", показаны первые ${maxFiles} (превышен лимит).`);
  } else if (totalFiles === 0) {
    notes.push(`Файлы: не найдено файлов, соответствующих домену "${domain}".`);
  }

  return { files, totalFiles, truncated, notes };
}

/**
 * Проверяет, является ли каталог git-репозиторием.
 */
export function isGitRepo(root) {
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Проверяет, настроен ли у git-репозитория remote.
 */
export function hasGitRemote(root) {
  try {
    const remotes = execSync("git remote", {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });
    return remotes.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Получает последние коммиты через git log --oneline -8 -- <paths>.
 */
export function collectRecentCommits(root, files) {
  const notes = [];
  if (!isGitRepo(root)) {
    notes.push("Git: каталог не является git-репозиторием (история коммитов пропущена).");
    return { commits: [], notes };
  }

  try {
    let cmd = "git log --oneline -8";
    if (files && files.length > 0) {
      // Передаем файлы с относительными путями в git log
      const quotedFiles = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
      cmd += ` -- ${quotedFiles}`;
    }

    const output = execSync(cmd, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });

    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      notes.push("Git: коммитов, затрагивающих найденные файлы, не обнаружено.");
    }

    return { commits: lines, notes };
  } catch (err) {
    notes.push(`Git: не удалось получить журнал коммитов (${err.message}).`);
    return { commits: [], notes };
  }
}

/**
 * Проверяет доступность команды gh в PATH.
 */
export function isGhAvailable() {
  try {
    execSync("gh --version", {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Собирает открытые issue через gh issue list --search "<domain>" --limit 5.
 */
export function collectGhIssues(root, domain, allowGh = true) {
  const notes = [];

  if (!allowGh) {
    notes.push("GitHub: поиск issue отключен (флаг --no-gh).");
    return { issues: [], notes };
  }

  if (!isGhAvailable()) {
    notes.push("GitHub: утилита gh CLI не найдена в PATH (поиск issue пропущен).");
    return { issues: [], notes };
  }

  if (!isGitRepo(root)) {
    notes.push("GitHub: каталог не является git-репозиторием (поиск issue пропущен).");
    return { issues: [], notes };
  }

  if (!hasGitRemote(root)) {
    notes.push("GitHub: удаленный репозиторий (git remote) не настроен (поиск issue пропущен).");
    return { issues: [], notes };
  }

  try {
    const cmd = `gh issue list --search "${domain.replace(/"/g, '\\"')}" --limit 5 --json number,title,state,url`;
    const output = execSync(cmd, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    });

    const data = JSON.parse(output.trim() || "[]");
    if (!Array.isArray(data) || data.length === 0) {
      notes.push(`GitHub: открытых issue по запросу "${domain}" не найдено.`);
      return { issues: [], notes };
    }

    return { issues: data, notes };
  } catch (err) {
    notes.push(`GitHub: не удалось выполнить поиск issue через gh (${err.message}).`);
    return { issues: [], notes };
  }
}
/**
 * Ищет решения по токену домена в docs/adr/**\/*.md и openspec/changes/**\/{proposal,manifest}.md.
 * Ограничение: не более maxRows (по умолчанию 5) строк, первая найденная строка на файл,
 * усечение до 160 символов.
 */
export function collectDecisions(root, domain, maxRows = 5) {
  const decisions = [];
  const notes = [];
  const tokenLower = domain.toLowerCase();

  function scanDirRecursive(dir) {
    const files = [];
    if (!existsSync(dir)) return files;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanDirRecursive(full));
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    } catch {
      // игнорируем ошибки доступа
    }
    return files;
  }

  const candidateFiles = [];
  // 1. docs/adr/**/*.md
  const adrDir = join(root, "docs", "adr");
  if (existsSync(adrDir)) {
    const adrFiles = scanDirRecursive(adrDir).filter((f) => f.endsWith(".md"));
    candidateFiles.push(...adrFiles);
  }

  // 2. openspec/changes/**/{proposal,manifest}.md
  const openspecDir = join(root, "openspec", "changes");
  if (existsSync(openspecDir)) {
    const specFiles = scanDirRecursive(openspecDir).filter((f) => {
      const base = f.split(sep).pop();
      return base === "proposal.md" || base === "manifest.md";
    });
    candidateFiles.push(...specFiles);
  }

  // Сортируем для детерминизма
  candidateFiles.sort();

  for (const filePath of candidateFiles) {
    if (decisions.length >= maxRows) break;
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.toLowerCase().includes(tokenLower)) {
          const relPath = relative(root, filePath).split(sep).join("/");
          const snippet = trimmed.length > 160 ? trimmed.slice(0, 157) + "..." : trimmed;
          decisions.push(`${relPath}: ${snippet}`);
          break; // первая подходящая строка в файле
        }
      }
    } catch {
      // пропуск нечитаемого файла
    }
  }

  return { decisions, notes };
}


/**
 * Главная функция сбора доменного контекста.
 */
export function collectDomainContext({
  root = process.cwd(),
  domain,
  maxFiles = DEFAULT_MAX_FILES,
  allowGh = true,
}) {
  if (!domain || !domain.trim()) {
    throw new Error("Параметр --domain обязателен.");
  }

  const normDomain = domain.trim();
  const allNotes = [];

  // 1. Файлы
  const fileRes = collectDomainFiles(root, normDomain, maxFiles);
  allNotes.push(...fileRes.notes);

  // 2. Коммиты
  const commitRes = collectRecentCommits(root, fileRes.files);
  allNotes.push(...commitRes.notes);

  // 3. Issue
  const issueRes = collectGhIssues(root, normDomain, allowGh);
  allNotes.push(...issueRes.notes);
  // 4. Решения (DECISIONS)
  const decisionRes = collectDecisions(root, normDomain, 5);
  allNotes.push(...decisionRes.notes);

  return {
    domain: normDomain,
    files: fileRes.files,
    totalFiles: fileRes.totalFiles,
    truncated: fileRes.truncated,
    commits: commitRes.commits,
    decisions: decisionRes.decisions,
    issues: issueRes.issues,
    notes: allNotes,
  };
}

/**
 * Форматирует результат в текстовый вид на русском языке.
 */
export function formatRussianOutput(data) {
  const sections = [];

  // FILES
  sections.push("=== FILES ===");
  if (data.files.length === 0) {
    sections.push("(нет подходящих файлов)");
  } else {
    for (const f of data.files) {
      sections.push(`- ${f}`);
    }
  }

  // RECENT COMMITS
  sections.push("\n=== RECENT COMMITS ===");
  if (data.commits.length === 0) {
    sections.push("(нет недавних коммитов)");
  } else {
    for (const c of data.commits) {
      sections.push(`- ${c}`);
    }
  }
  // DECISIONS
  sections.push("\n=== DECISIONS ===");
  if (!data.decisions || data.decisions.length === 0) {
    sections.push("решений по домену не найдено");
  } else {
    for (const d of data.decisions) {
      sections.push(`- ${d}`);
    }
  }


  // ISSUES
  sections.push("\n=== ISSUES ===");
  if (data.issues.length === 0) {
    sections.push("(нет связанных issue)");
  } else {
    for (const issue of data.issues) {
      const num = issue.number ? `#${issue.number} ` : "";
      const state = issue.state ? `[${issue.state}] ` : "";
      const url = issue.url ? ` (${issue.url})` : "";
      sections.push(`- ${num}${state}${issue.title}${url}`);
    }
  }

  // NOTES
  sections.push("\n=== NOTES ===");
  if (data.notes.length === 0) {
    sections.push("(замечаний нет)");
  } else {
    for (const n of data.notes) {
      sections.push(`- ${n}`);
    }
  }

  return sections.join("\n");
}

/**
 * Парсер аргументов командной строки.
 */
export function parseArgs(argv) {
  const args = { _: [], maxFiles: DEFAULT_MAX_FILES, allowGh: true, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--domain" && i + 1 < argv.length) {
      args.domain = argv[++i];
    } else if (a === "--root" && i + 1 < argv.length) {
      args.root = argv[++i];
    } else if (a === "--max-files" || a.startsWith("--max-files=")) {
      // Молчаливое `parseInt(...) || 15` превращало `--max-files 0|abc` в 15,
      // а `--max-files -1` — в slice(0, -1) с потерей последнего файла.
      const raw = a === "--max-files" ? argv[++i] : a.slice("--max-files=".length);
      const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(value) || value < 1) {
        args.errors.push(`--max-files требует целое число >= 1 (получено: ${JSON.stringify(raw)})`);
      } else {
        args.maxFiles = value;
      }
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--no-gh") {
      args.allowGh = false;
    } else if (a.startsWith("--")) {
      args.errors.push(`неизвестный или неполный параметр ${a}`);
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Запуск из командной строки
const isDirectExecution =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("domain-context.mjs"));

if (isDirectExecution) {
  const argv = process.argv.slice(2);
  // --help/-h — запрос справки; без него инструмент требует --domain.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Использование: node tools/domain-context.mjs --domain <name> [--root <dir>] [--json] [--max-files 15] [--no-gh]

Собирает контекст предметной области: файлы, связанные с доменом, последние коммиты,
открытые issue, DECISIONS из docs/adr и openspec, заметки о пробелах (нет codemap/gh).

Флаги: --domain <name> (обязателен), --root <dir>, --max-files <n>, --no-gh, --json, --help`);
    process.exit(0);
  }
  const args = parseArgs(argv);

  const USAGE = "Использование: node tools/domain-context.mjs --domain <name> [--root <dir>] [--json] [--max-files 15] [--no-gh]";

  if (args.errors.length > 0) {
    for (const err of args.errors) {
      console.error(`Ошибка: ${err}.`);
    }
    console.error(USAGE);
    process.exit(2);
  }

  if (!args.domain || !args.domain.trim()) {
    console.error("Ошибка: параметр --domain обязателен.");
    console.error(USAGE);
    process.exit(2);
  }

  try {
    const root = args.root ? resolve(args.root) : process.cwd();
    const data = collectDomainContext({
      root,
      domain: args.domain,
      maxFiles: args.maxFiles,
      allowGh: args.allowGh,
    });

    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatRussianOutput(data));
    }

    process.exit(0);
  } catch (err) {
    console.error(`Ошибка сбора контекста: ${err.message}`);
    process.exit(1);
  }
}
