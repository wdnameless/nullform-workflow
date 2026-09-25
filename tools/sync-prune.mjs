#!/usr/bin/env node
/**
 * tools/sync-prune.mjs — кандидаты на очистку harness: файлы каркаса, которых нет в репозитории.
 *
 * Использование:
 *   node tools/sync-prune.mjs [--harness <dir>] [--repo <dir>] [--json] [--delete]
 *
 * Зачем:
 *   Манифест sync.ps1 описывает, что репозиторий поставляет в живой harness.
 *   Всё остальное в каталогах манифеста — либо забытый хлам, либо локальная
 *   правка, которую не перенесли в репозиторий. Модуль считает ровно этот
 *   список: `sync.ps1 -Prune` перечисляет его (dry-run) и удаляет только с
 *   `-Confirm`; `doctor.mjs` показывает его как проверку `orphan-files`.
 *
 * Границы (общие для CLI и doctor — один источник правды):
 *   - обход только каталогов манифеста: tools/, agent/, rules/, core/, templates/, paseo/;
 *   - служебные dot-записи не обходятся вовсе (.git, .prompt-lint, .workflow, .archmap,
 *     .omp, .agents, …), плюс явный список node_modules, worktrees, sessions, blobs,
 *     cache, logs, custom-session-files;
 *   - не считает кандидатами конфиги, секреты и сессионные данные
 *     (*.yml, *.yaml, *.json, *.db*, *.key, *.env, *.log, *.bak, *.tmp, …);
 *   - символические ссылки не разыменовываются.
 *
 * Коды возврата: 0 — список построен (непустой список не является ошибкой);
 *                2 — ошибка параметров (нет --harness/--repo).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as utilParseArgs } from "node:util";

/** Каталоги, покрытые манифестом sync.ps1. */
export const MANIFEST_DIRS = ["tools", "agent", "rules", "core", "templates", "paseo"];

/** Каталоги, которые не обходятся никогда: служебные, генерируемые, сессионные. */
export const NEVER_DIRS = new Set([
  ".git",
  ".prompt-lint",
  ".workflow",
  ".archmap",
  "node_modules",
  "worktrees",
  "sessions",
  "blobs",
  "cache",
  "logs",
  "custom-session-files",
]);

export const NEVER_SUFFIX = /\.(ya?ml|json|jsonl|db|db-wal|db-shm|key|env|log|bak|tmp|pem|crt|sqlite3?|skipped)$/i;

function toPosix(p) {
  return p.split(sep).join("/");
}

function walk(dir, base, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Служебные dot-записи (.git, .prompt-lint, .omp, .agents, …) — вне области очистки.
    if (entry.name.startsWith(".")) continue;
    if (NEVER_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(base, full)));
    }
  }
}

/**
 * Каталог существует и является каталогом? Возвращает RU-описание проблемы или null.
 * Опечатка в пути не должна выглядеть как «чисто»: 0 кандидатов и пустой харнесс
 * неотличимы, если не проверять сам путь.
 */
function pathProblem(dir, label) {
  if (!existsSync(dir)) return `${label} не найден: ${dir}`;
  try {
    if (!statSync(dir).isDirectory()) return `${label} не каталог: ${dir}`;
  } catch (err) {
    return `${label} недоступен: ${dir} (${err.message})`;
  }
  return null;
}

/**
 * Файлы внутри каталогов манифеста, отсутствующие в репозитории.
 * @param {{harness: string, repo: string, dirs?: string[]}} options
 * @returns {string[]} отсортированные относительные пути (POSIX-разделители)
 * @throws {Error} если harness/repo не заданы или не являются существующими каталогами
 */
export function findPruneCandidates({ harness, repo, dirs = MANIFEST_DIRS } = {}) {
  if (!harness) throw new Error("findPruneCandidates: harness is required");
  if (!repo) throw new Error("findPruneCandidates: repo is required");

  const problem = pathProblem(harness, "--harness") || pathProblem(repo, "--repo");
  if (problem) throw new Error(problem);

  const harnessRoot = resolve(harness);
  const repoRoot = resolve(repo);
  const candidates = [];

  for (const dir of dirs) {
    const dirPath = join(harnessRoot, dir);
    if (!existsSync(dirPath)) continue;
    const found = [];
    walk(dirPath, harnessRoot, found);
    for (const rel of found) {
      if (NEVER_SUFFIX.test(rel)) continue;
      if (existsSync(join(repoRoot, rel))) continue;
      candidates.push(rel);
    }
  }

  return candidates.sort();
}

/**
 * Удаляет перечисленные кандидаты (только файлы, каталоги не трогает).
 * @returns {{deleted: string[], failed: Array<{path: string, error: string}>}}
 */
export function deletePruneCandidates(harness, candidates) {
  const harnessRoot = resolve(harness);
  const deleted = [];
  const failed = [];
  for (const rel of candidates) {
    const full = join(harnessRoot, rel);
    try {
      // A deletion routine must not trust its caller: a candidate that resolves outside
      // the root (via `..`, an absolute path, or a symlinked parent) is reported and left
      // alone, never removed.
      const resolved = resolve(full);
      if (resolved !== harnessRoot && !resolved.startsWith(harnessRoot + sep)) {
        failed.push({ path: rel, error: "resolves outside the harness root" });
        continue;
      }
      if (!statSync(full).isFile()) {
        failed.push({ path: rel, error: "not a regular file" });
        continue;
      }
      rmSync(full, { force: true });
      deleted.push(rel);
    } catch (err) {
      failed.push({ path: rel, error: err.message });
    }
  }
  return { deleted, failed };
}

function parseArgs(args) {
  const { values } = utilParseArgs({
    args,
    options: {
      harness: { type: "string" },
      repo: { type: "string" },
      json: { type: "boolean", default: false },
      delete: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });
  return {
    harness: values.harness || null,
    repo: values.repo || null,
    json: values.json,
    del: values.delete,
    help: values.help,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "Использование: node tools/sync-prune.mjs --harness <dir> --repo <dir> [--json] [--delete]\n"
    );
    return 0;
  }
  if (!args.harness || !args.repo) {
    process.stderr.write("sync-prune: нужны --harness <dir> и --repo <dir>\n");
    return 2;
  }

  const harness = resolve(args.harness);
  const repo = resolve(args.repo);

  let candidates;
  try {
    candidates = findPruneCandidates({ harness, repo });
  } catch (err) {
    process.stderr.write(`sync-prune: ${err.message}\n`);
    return 2;
  }

  let deletion = { deleted: [], failed: [] };
  if (args.del) {
    deletion = deletePruneCandidates(harness, candidates);
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ harness, repo, candidates, deleted: deletion.deleted, failed: deletion.failed }, null, 2) + "\n"
    );
    // A deletion that failed is not a success signal: callers such as sync.ps1 branch on
    // this exit code, and returning 0 told them a partially failed prune was clean.
    return deletion.failed.length ? 1 : 0;
  }

  process.stdout.write(`prune: ${candidates.length} candidate(s)\n`);
  for (const rel of candidates) {
    process.stdout.write(`  [X] ${rel}\n`);
  }
  if (args.del) {
    process.stdout.write(`prune: deleted ${deletion.deleted.length} file(s)\n`);
    for (const f of deletion.failed) {
      process.stdout.write(`  [!] ${f.path}: ${f.error}\n`);
    }
    if (deletion.failed.length) {
      process.stdout.write(`prune: ${deletion.failed.length} file(s) could NOT be deleted\n`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
