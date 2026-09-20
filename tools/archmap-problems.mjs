import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scanText } from "./debt-ledger.mjs";

/**
 * Severity ranking weights for sorting
 */
const SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const CATEGORY_RU = {
  structure: "структура",
  optimization: "оптимизация",
  security: "безопасность",
  reliability: "надежность",
  maintainability: "поддерживаемость",
};

export const SEVERITY_RU = {
  critical: "критическая",
  high: "высокая",
  medium: "средняя",
  low: "низкая",
};

/**
 * SHA-256 slice helper
 */
function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Deterministic problem ID generator
 */
export function makeProblemId(category, kind, file, line) {
  return `${category}-${kind}-${sha(`${file}:${line || 1}`)}`;
}

/**
 * Redacts potential secrets, keys, and tokens in code excerpts.
 * Replaces values with [REDACTED].
 */
export function redactSecrets(text) {
  if (!text) return "";
  let redacted = text;

  // Patterns matching assignments: key = "...", token: "...", etc.
  const kvPattern = /((?:api[_-]?key|secret|token|password|passwd|auth|private[_-]?key|bearer)\s*[:=]\s*["'`])([^"'`\r\n]{4,})(["'`])/gi;
  redacted = redacted.replace(kvPattern, "$1[REDACTED]$3");

  // Specific token patterns
  // AWS / AI tokens
  redacted = redacted.replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(gho_[a-zA-Z0-9]{20,})\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(glpat-[a-zA-Z0-9\-_]{20,})\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g, "[REDACTED]");

  return redacted;
}

/**
 * Extracts a bounded excerpt of code around centerLine (<= maxLines lines).
 * Lines are 1-indexed. Secrets are redacted.
 */
export function getBoundedExcerpt(sourceCode, centerLine = 1, maxLines = 30) {
  if (!sourceCode) return "";
  const lines = sourceCode.split(/\r?\n/);
  const total = lines.length;
  if (total === 0) return "";

  const half = Math.floor(maxLines / 2);
  let start = Math.max(1, centerLine - half);
  let end = Math.min(total, start + maxLines - 1);
  if (end - start + 1 < maxLines && start > 1) {
    start = Math.max(1, end - maxLines + 1);
  }

  const excerptLines = [];
  for (let l = start; l <= end; l++) {
    excerptLines.push(`${l}: ${lines[l - 1]}`);
  }

  const text = excerptLines.join("\n");
  return redactSecrets(text);
}

/**
 * Strips string/template literal contents and line comments from a source line
 * so code-pattern rules (eval, innerHTML) never match their own documentation,
 * regex sources, or message strings. Secret rules intentionally keep using the
 * raw line: secrets live inside string literals.
 */
function codeOnlyLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += " "; continue; }
    if (ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

/**
 * Builds a ready AI prompt in Russian.
 * Format:
 * Проблема: ...
 * Категория: ... | Важность: ...
 * Файл: ...:line
 *
 * Почему это важно:
 * ...
 *
 * Как исправить:
 * ...
 *
 * Фрагмент кода:
 * ```
 * ...
 * ```
 */
export function buildPrompt({ title, categoryRu, severityRu, where, why, fix, excerpt, lang = "" }) {
  const whereStr = where.map((w) => `${w.file}${w.line ? `:${w.line}` : ""}`).join(", ");
  const lines = [
    `Проблема: ${title}`,
    `Категория: ${categoryRu} | Важность: ${severityRu}`,
    `Файл: ${whereStr}`,
    "",
    "Почему это важно:",
    why,
    "",
    "Как исправить:",
    fix,
  ];

  if (excerpt && excerpt.trim().length > 0) {
    lines.push("", "Фрагмент кода:", "```" + lang, excerpt, "```");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------- Detectors */

/**
 * Detects structure problems:
 * - cycle: critical if > 4 files, high if 2..4 files
 * - god-module: fanIn >= 8 and complexity >= 30 -> high
 * - orphan: fanIn === 0 && fanOut === 0 (excluding entry files) -> low
 * - wrapper: 1 export, 1 import, loc < 20, complexity <= 2 -> low
 */
function detectStructureProblems(state, sourceGetter) {
  const out = [];

  // 1. Cycles
  for (const cyc of state.cycles || []) {
    const len = cyc.length;
    const severity = len > 4 ? "critical" : "high";
    const where = cyc.map((f) => ({ file: f, line: 1 }));
    const firstFile = cyc[0];
    const fileSource = sourceGetter(firstFile);
    const excerpt = getBoundedExcerpt(fileSource, 1, 20);

    const title = `Циклическая зависимость: ${len} модулей в цикле`;
    const why = "Модули жестко сцеплены между собой, что препятствует изолированному тестированию, повторному использованию и увеличивает риск циклических ошибок при инициализации.";
    const fix = "Разорвите цикл: выделите общий интерфейс или разделяемые типы в отдельный модуль нижнего уровня либо примените внедрение зависимостей (DI).";
    const prompt = buildPrompt({
      title,
      categoryRu: CATEGORY_RU.structure,
      severityRu: SEVERITY_RU[severity],
      where,
      why,
      fix,
      excerpt,
    });

    out.push({
      id: makeProblemId("structure", "cycle", cyc.join(","), len),
      severity,
      category: "structure",
      kind: "cycle",
      title,
      why,
      fix,
      where,
      prompt,
      heuristic: true,
      rawWeight: (severity === "critical" ? 2000 : 1000) + len * 50,
    });
  }

  // 2. God modules, orphans, wrappers
  const files = Object.entries(state.files || {});
  for (const [p, f] of files) {
    // God-module: fanIn >= 8 and complexity >= 30
    if (f.fanIn >= 8 && f.complexity >= 30) {
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 25);
      const title = `Модуль «Божественный объект» (God module): ${f.fanIn} входящих связей, сложность ${f.complexity}`;
      const why = "Модуль аккумулирует слишком много разнородных обязанностей и становится центральной точкой отказа для всей системы.";
      const fix = "Разделите модуль на узкоспециализированные компоненты по принципу единственной ответственности (SRP).";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.structure,
        severityRu: SEVERITY_RU.high,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("structure", "god-module", p, 1),
        severity: "high",
        category: "structure",
        kind: "god-module",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight: f.fanIn * 100 + f.complexity * 5,
      });
    }

    // Wrapper: 1 export, 1 import, loc < 20, complexity <= 2
    if (f.exports === 1 && f.imports === 1 && f.loc < 20 && f.complexity <= 2) {
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 20);
      const title = `Модуль-обертка с минимальной полезной логикой (Shallow wrapper)`;
      const why = "Модуль лишь проксирует вызов единственной зависимости, увеличивая когнитивную нагрузку и глубину стека вызовов без создания абстракции.";
      const fix = "Устраните лишний слой косвенности, импортируя целевой модуль напрямую, либо перенесите в него содержательную логику.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.structure,
        severityRu: SEVERITY_RU.low,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("structure", "wrapper", p, 1),
        severity: "low",
        category: "structure",
        kind: "wrapper",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight: 50,
      });
    }

    // Orphan: fanIn === 0 && fanOut === 0 (excluding potential entrypoints / tests / root configs)
    const isEntryLike = /(?:index|main|app|cli|server|demo|test|spec)\.[a-z]+$/i.test(p);
    if (f.fanIn === 0 && f.fanOut === 0 && !isEntryLike && files.length > 2) {
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 20);
      const title = `Модуль-сирота без входящих и исходящих связей (Orphan)`;
      const why = "Модуль изолирован от остального графа зависимостей проекта и может являться мертвым кодом.";
      const fix = "Проверьте, используется ли модуль во внешней системе или тестах; если нет — удалите его.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.structure,
        severityRu: SEVERITY_RU.low,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("structure", "orphan", p, 1),
        severity: "low",
        category: "structure",
        kind: "orphan",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight: 40,
      });
    }
  }

  return out;
}

/**
 * Detects optimization problems:
 * - giant-file: loc >= 1200 -> high; loc >= 600 -> medium
 * - complexity: complexity >= 60 -> medium
 * - long-function: function / method length >= 80 -> medium
 */
function detectOptimizationProblems(state, sourceGetter) {
  const out = [];
  const LOC_BIG = 600;
  const LOC_HUGE = 1200;
  const CX_BIG = 60;

  for (const [p, f] of Object.entries(state.files || {})) {
    // Giant file
    if (f.loc >= LOC_BIG) {
      const severity = f.loc >= LOC_HUGE ? "high" : "medium";
      const rawWeight = (severity === "high" ? 1000 : 500) + Math.min(500, Math.round(f.loc / 2));
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 25);
      const title = `Слишком большой файл: ${f.loc} строк кода`;
      const why = "Файлы размером свыше 600 строк трудно удерживать в контексте, они провоцируют конфликты слияния и скрывают логические дублирования.";
      const fix = "Декомпозируйте файл на связные модули меньшего размера, сгруппированные по предметной области.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.optimization,
        severityRu: SEVERITY_RU[severity],
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("optimization", "giant-file", p, 1),
        severity,
        category: "optimization",
        kind: "giant-file",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight,
      });
    }

    // Complexity
    if (f.complexity >= CX_BIG) {
      const rawWeight = f.complexity * 10;
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 25);
      const title = `Высокая цикломатическая сложность: ${f.complexity} точек ветвления`;
      const why = "Большое количество ветвлений (if, loops, switch, логические операторы) экспоненциально увеличивает число путей исполнения и вероятность ошибок.";
      const fix = "Декомпозируйте ветвления, примените ранние возвраты (early returns), таблицы диспетчеризации или полиморфизм.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.optimization,
        severityRu: SEVERITY_RU.medium,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("optimization", "complexity", p, 1),
        severity: "medium",
        category: "optimization",
        kind: "complexity",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight,
      });
    }
  }

  // Long functions from symbols (endLine - line + 1 >= 80)
  if (Array.isArray(state.symbols)) {
    for (const sym of state.symbols) {
      if (sym.kind === "function" || sym.kind === "method") {
        const len = (sym.endLine || sym.line) - sym.line + 1;
        if (len >= 80) {
          const rawWeight = len * 5;
          const where = [{ file: sym.file, line: sym.line }];
          const fileSource = sourceGetter(sym.file);
          const excerpt = getBoundedExcerpt(fileSource, sym.line, 30);
          const title = `Слишком длинная функция «${sym.name}»: ${len} строк`;
          const why = "Функция содержит слишком много логики, выполняет несколько обязанностей и трудно поддается всестороннему тестированию.";
          const fix = "Разбейте функцию на короткие вспомогательные методы с ясными именами и единичной ответственностью.";
          const prompt = buildPrompt({
            title,
            categoryRu: CATEGORY_RU.optimization,
            severityRu: SEVERITY_RU.medium,
            where,
            why,
            fix,
            excerpt,
          });

          out.push({
            id: makeProblemId("optimization", "long-function", sym.file, sym.line),
            severity: "medium",
            category: "optimization",
            kind: "long-function",
            title,
            why,
            fix,
            where,
            prompt,
            heuristic: true,
            rawWeight,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Checks if line contains hardcoded secret.
 */
function detectSecretInLine(line) {
  // Explicit fixture opt-out, same convention as prompt-lint:allow.
  if (line.includes('archmap:allow')) return false;
  // Discard comments that only describe keys
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
    return false;
  }

  // Common tokens
  if (/\b(?:AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9a-zA-Z]{10,48})\b/.test(line)) {
    return true;
  }

  // String assignments like: apiKey = "...", secret: '...', password: "..."
  const literalMatch = /(?:api[_-]?key|secret|token|password|passwd|auth[_-]?token)\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/i.exec(line);
  if (literalMatch) {
    const val = literalMatch[1];
    // Exclude obvious templates or placeholders: instruction values
    // ("your-key", "changeme", "<token>", "xxx") are documentation, not leaks.
    if (/^[A-Z0-9_]+$/.test(val) && (val.includes("ENV") || val.includes("EXAMPLE") || val.includes("PLACEHOLDER") || val.includes("TOKEN"))) {
      return false;
    }
    if (/^(?:<[^>]+>|your[-_a-z0-9]*|my[-_a-z0-9]*|change[-_]?me|changeme|placeholder|example|dummy|fake|test[-_a-z0-9]*|x{3,}|\*+|\.{3,})$/i.test(val)) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Detects security problems:
 * - hardcoded-secret: API keys, tokens, passwords in string literals -> critical
 * - eval / new Function -> high
 * - innerHTML assignment -> medium
 */
function detectSecurityProblems(state, sourceGetter) {
  const out = [];

  for (const p of Object.keys(state.files || {})) {
    const src = sourceGetter(p);
    if (!src) continue;
    // File-level opt-out for fixtures that intentionally contain detectable
    // patterns (detector demos, redaction tests). Marker lives in a header
    // comment, so it never propagates into content the file generates.
    if (src.includes('archmap:allow-file')) continue;
    const lines = src.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // 1. Hardcoded secrets
      if (detectSecretInLine(line)) {
        const where = [{ file: p, line: lineNum }];
        const excerpt = getBoundedExcerpt(src, lineNum, 15);
        const title = `Потенциально открытый секрет или ключ доступа в коде`;
        const why = "Хранение ключей API, токенов или паролей в коде открывает их при публикации репозитория или скомпрометированном доступе.";
        const fix = "Вынесите секреты в переменные окружения (.env) или защищенное хранилище секретов (Vault, Secret Manager).";
        const prompt = buildPrompt({
          title,
          categoryRu: CATEGORY_RU.security,
          severityRu: SEVERITY_RU.critical,
          where,
          why,
          fix,
          excerpt,
        });

        out.push({
          id: makeProblemId("security", "hardcoded-secret", p, lineNum),
          severity: "critical",
          category: "security",
          kind: "hardcoded-secret",
          title,
          why,
          fix,
          where,
          prompt,
          heuristic: true,
          rawWeight: 5000,
        });
      }

      // 2. eval() or new Function() -> high (code only, never our own strings/comments)
      if (/\b(?:eval\s*\(|new\s+Function\s*\()/.test(codeOnlyLine(line))) {
        const where = [{ file: p, line: lineNum }];
        const excerpt = getBoundedExcerpt(src, lineNum, 15);
        const title = `Динамическое исполнение кода (eval / new Function)`;
        const why = "Использование eval() или new Function() открывает вектор инъекции произвольного исполняемого кода и отключает оптимизации движка JS.";
        const fix = "Откажитесь от выполнения кода из строк; используйте безопасные парсеры (JSON.parse) или статическую логику.";
        const prompt = buildPrompt({
          title,
          categoryRu: CATEGORY_RU.security,
          severityRu: SEVERITY_RU.high,
          where,
          why,
          fix,
          excerpt,
        });

        out.push({
          id: makeProblemId("security", "eval", p, lineNum),
          severity: "high",
          category: "security",
          kind: "eval",
          title,
          why,
          fix,
          where,
          prompt,
          heuristic: true,
          rawWeight: 2000,
        });
      }

      // 3. innerHTML assignment -> medium (code only)
      if (/\.innerHTML\s*=[^=]/.test(codeOnlyLine(line))) {
        const where = [{ file: p, line: lineNum }];
        const excerpt = getBoundedExcerpt(src, lineNum, 15);
        const title = `Прямое присваивание в innerHTML (риск XSS)`;
        const why = "Прямая вставка разметки через innerHTML без санитизации пользовательского ввода может приводить к межсайтовому скриптингу (XSS).";
        const fix = "Используйте textContent, безопасные методы создания DOM-элементов или библиотеку DOMPurify для очистки HTML.";
        const prompt = buildPrompt({
          title,
          categoryRu: CATEGORY_RU.security,
          severityRu: SEVERITY_RU.medium,
          where,
          why,
          fix,
          excerpt,
        });

        out.push({
          id: makeProblemId("security", "inner-html", p, lineNum),
          severity: "medium",
          category: "security",
          kind: "inner-html",
          title,
          why,
          fix,
          where,
          prompt,
          heuristic: true,
          rawWeight: 800,
        });
      }
    }
  }

  return out;
}

/**
 * Detects reliability problems:
 * - swallowed-error: empty catch or catch that only logs -> medium
 * - todo-density: high number of TODO/FIXME markers in file -> low
 */
function detectReliabilityProblems(state, sourceGetter) {
  const out = [];

  for (const p of Object.keys(state.files || {})) {
    const src = sourceGetter(p);
    if (!src) continue;

    // Detect swallowed catch blocks
    // Matches catch (...) { ... } or catch { ... }
    const catchRegex = /\bcatch(?:\s*\([^)]*\))?\s*\{([^}]*)\}/g;
    let match;
    while ((match = catchRegex.exec(src)) !== null) {
      const body = match[1].trim();
      const upToMatch = src.slice(0, match.index);
      const lineNum = upToMatch.split("\n").length;

      const bodyNoComments = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "")
        .trim();

      const isEmpty = bodyNoComments.length === 0;
      const isOnlyLog = /^(?:console\.(?:log|error|warn|info|debug)\([^)]*\);?\s*)+$/.test(bodyNoComments);

      if (isEmpty || isOnlyLog) {
        const where = [{ file: p, line: lineNum }];
        const excerpt = getBoundedExcerpt(src, lineNum, 15);
        const title = isEmpty
          ? `Пустой блок catch (проглатывание ошибки)`
          : `Блок catch только логирует ошибку без обработки`;
        const why = "Игнорирование или сокрытие исключений маскирует сбои программы и приводит к непредсказуемому поведению системы.";
        const fix = "Обеспечьте осмысленную обработку ошибки, повторный выброс (throw) или корректное восстановление состояния.";
        const prompt = buildPrompt({
          title,
          categoryRu: CATEGORY_RU.reliability,
          severityRu: SEVERITY_RU.medium,
          where,
          why,
          fix,
          excerpt,
        });

        out.push({
          id: makeProblemId("reliability", "swallowed-error", p, lineNum),
          severity: "medium",
          category: "reliability",
          kind: "swallowed-error",
          title,
          why,
          fix,
          where,
          prompt,
          heuristic: true,
          rawWeight: 750,
        });
      }
    }

    // TODO/FIXME density
    const todoMatches = src.match(/\b(?:TODO|FIXME|XXX|HACK)\b/gi);
    if (todoMatches && todoMatches.length >= 4) {
      const where = [{ file: p, line: 1 }];
      const excerpt = getBoundedExcerpt(src, 1, 20);
      const title = `Высокая плотность незавершенного кода: ${todoMatches.length} меток TODO/FIXME`;
      const why = "Большое скопление меток TODO свидетельствует о накопленном техническом долге и незавершенных решениях.";
      const fix = "Проведите аудит заметок TODO/FIXME: закройте выполненные задачи или заведите задачи в трекере.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.reliability,
        severityRu: SEVERITY_RU.low,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("reliability", "todo-density", p, 1),
        severity: "low",
        category: "reliability",
        kind: "todo-density",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight: todoMatches.length * 15,
      });
    }
  }

  return out;
}

/**
 * Detects maintainability problems:
 * - low-mi: MI < 40 -> low
 */
function detectMaintainabilityProblems(state, sourceGetter) {
  const out = [];

  for (const [p, f] of Object.entries(state.files || {})) {
    if (typeof f.mi === "number" && f.mi < 40) {
      const where = [{ file: p, line: 1 }];
      const fileSource = sourceGetter(p);
      const excerpt = getBoundedExcerpt(fileSource, 1, 20);
      const title = `Низкий индекс сопровождаемости (Maintainability Index): ${f.mi}/100`;
      const why = "Код файла обладает высокой сложностью, большим объемом и низким отношением комментариев, что затрудняет его поддержку.";
      const fix = "Упростите структуру модуля, выделите сложные функции в отдельные файлы и сократите объем дублирования.";
      const prompt = buildPrompt({
        title,
        categoryRu: CATEGORY_RU.maintainability,
        severityRu: SEVERITY_RU.low,
        where,
        why,
        fix,
        excerpt,
      });

      out.push({
        id: makeProblemId("maintainability", "low-mi", p, 1),
        severity: "low",
        category: "maintainability",
        kind: "low-mi",
        title,
        why,
        fix,
        where,
        prompt,
        heuristic: true,
        rawWeight: 100 - f.mi,
      });
    }
  }

  return out;
}

/**
 * Detects technical debt problems:
 * - debt-no-trigger: defer: marker without upgrade condition -> low
 */
function detectDebtProblems(state, sourceGetter) {
  const out = [];

  for (const p of Object.keys(state.files || {})) {
    const src = sourceGetter(p);
    if (src === null || src === undefined || src === "") {
      continue;
    }

    const markers = scanText(src, p);
    for (const marker of markers) {
      if (marker.noTrigger === true) {
        const where = [{ file: p, line: marker.line }];
        const excerpt = getBoundedExcerpt(src, marker.line, 5);
        const title = `Отложенное техническое упрощение без триггера пересмотра (строка ${marker.line})`;
        const detailParts = [];
        if (marker.what) {
          detailParts.push(`что упрощено: "${marker.what}"`);
        }
        if (marker.ceiling) {
          detailParts.push(`потолок: "${marker.ceiling}"`);
        }
        const why = `В коде зафиксировано временное упрощение (${detailParts.join(", ") || "маркер defer"}), но не задано условие возврата (upgrade). Без явного триггера долг рискует остаться забытым.`;
        const fix = "Укажите условие возврата в формате `upgrade: <триггер>` или устраните временное упрощение.";
        const prompt = buildPrompt({
          title,
          categoryRu: CATEGORY_RU.maintainability,
          severityRu: SEVERITY_RU.low,
          where,
          why,
          fix,
          excerpt,
        });

        out.push({
          id: makeProblemId("maintainability", "debt-no-trigger", p, marker.line),
          severity: "low",
          category: "maintainability",
          kind: "debt-no-trigger",
          title,
          why,
          fix,
          where,
          prompt,
          heuristic: true,
          rawWeight: 10,
        });
      }
    }
  }

  return out;
}

/**
 * Main problem analysis function.
 * Deterministic sort: critical -> high -> medium -> low, then rawWeight descending, then id.
 *
 * @param {object} state
 * @param {string|((path: string) => string)} rootOrSourceGetter
 * @returns {Array<object>}
 */
export function analyzeProblems(state, rootOrSourceGetter = ".") {
  const sourceGetter =
    typeof rootOrSourceGetter === "function"
      ? rootOrSourceGetter
      : (relPath) => {
          try {
            const full = join(rootOrSourceGetter, relPath);
            if (existsSync(full)) {
              return readFileSync(full, "utf8");
            }
          } catch {
            return "";
          }
          return "";
        };

  const list = [
    ...detectStructureProblems(state, sourceGetter),
    ...detectOptimizationProblems(state, sourceGetter),
    ...detectSecurityProblems(state, sourceGetter),
    ...detectReliabilityProblems(state, sourceGetter),
    ...detectMaintainabilityProblems(state, sourceGetter),
    ...detectDebtProblems(state, sourceGetter),
  ];

  list.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    const wa = a.rawWeight ?? 0;
    const wb = b.rawWeight ?? 0;
    if (wa !== wb) return wb - wa;
    return a.id.localeCompare(b.id);
  });

  return list;
}
