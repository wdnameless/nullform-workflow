#!/usr/bin/env node
/**
 * return-contract.mjs — executable validator for subagent return contracts.
 *
 * Validates:
 *   - max lines 25
 *   - required sections: STATUS, FILES, TESTS, INTERFACES, REQUIREMENTS, CONCERNS
 *   - STATUS is one of: DONE | DONE_WITH_CONCERNS | HANDOFF | BLOCKED | NEEDS_CONTEXT
 *   - FILES: paths or internal URIs only (no prose descriptions)
 *   - TESTS: numeric before→after (e.g. было 10 → стало 12) or exact 'not-run(parent-owned)'
 *
 * Usage:
 *   node return-contract.mjs <file> [--json]
 *   node return-contract.mjs --text "<content>" [--json]
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs as utilParseArgs } from "node:util";

export const ALLOWED_STATUSES = [
  "DONE",
  "DONE_WITH_CONCERNS",
  "HANDOFF",
  "BLOCKED",
  "NEEDS_CONTEXT",
];

export const REQUIRED_SECTIONS = [
  "STATUS",
  "FILES",
  "TESTS",
  "INTERFACES",
  "REQUIREMENTS",
  "CONCERNS",
];

function parseArgs(args) {
  const { values, positionals } = utilParseArgs({
    args,
    options: {
      text: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  return { _: positionals, text: values.text ?? null, json: values.json };
}

/**
 * Validate a return contract text.
 * Returns { valid: boolean, errors: string[], warnings: string[], parsed: object }
 */
export function validateReturnContract(rawText) {
  const errors = [];
  const warnings = [];

  let normalized = "";

  // Support structured JSON yield / tool result shape if passed
  let parsedJson = null;
  if (typeof rawText === "object" && rawText !== null) {
    parsedJson = rawText;
  } else if (typeof rawText === "string") {
    normalized = rawText.replace(/\r\n/g, "\n");
    const trimmed = normalized.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {}
    }
  } else {
    normalized = String(rawText || "");
  }

  if (parsedJson) {
    // If JSON format is used, map standard fields or extract from wrapper
    // Actual task results often wrapper { status: 'success'|'partial'|'failed', summary: 'STATUS: DONE ...', tests_passed: boolean }
    const summary = typeof parsedJson.summary === "string" ? parsedJson.summary : "";
    const testsPassed = parsedJson.tests_passed;
    const rawOuterStatus = typeof parsedJson.status === "string" ? parsedJson.status.trim().toLowerCase() : "";

    // Check if summary itself contains the structured contract (common wrapper)
    const hasStatusInSummary = /(?:^|[·\n])\s*STATUS\b/i.test(summary);
    if (hasStatusInSummary) {
      normalized = summary.replace(/\r\n/g, "\n");
      // Check for contradictory wrapper status vs inner contract
      // E.g. outer status is failed or partial, but inner contract claims DONE
      if (rawOuterStatus === "failed") {
        errors.push(`Противоречивый статус: внешняя обёртка сообщает status: 'failed', но внутренний контракт содержит статус завершения. Задача считается заблокированной.`);
      } else if (rawOuterStatus === "partial") {
        // If outer is partial, inner cannot be pure DONE without concerns
        const innerIsDone = /(?:^|[·\n])\s*STATUS\s*[:\-\(]?\s*DONE\b(?!\s*[_A-Z])/i.test(normalized);
        if (innerIsDone) {
          errors.push(`Противоречивый статус: внешняя обёртка сообщает status: 'partial', что несовместимо со статусом DONE без оговорок (ожидается DONE_WITH_CONCERNS).`);
        }
      }
    } else {
      // Build normalized string from JSON fields
      let status = (parsedJson.status || "").toUpperCase();
      // If wrapper uses status: "success", map to "DONE" unless specified
      if (status === "SUCCESS") status = "DONE";
      else if (status === "PARTIAL") status = "DONE_WITH_CONCERNS";
      else if (status === "FAILED") status = "BLOCKED";

      const files = parsedJson.files_modified || parsedJson.files;
      const requirements = parsedJson.requirements || "";
      const interfaces = parsedJson.interfaces || "";
      const concerns = parsedJson.concerns || "";

      const testsVal = parsedJson.tests || (testsPassed === false ? "failed" : summary);

      const lines = [
        `STATUS: ${status}`,
        `FILES: ${Array.isArray(files) ? files.join(", ") : (files || "none")}`,
        `TESTS: ${testsVal}`,
        `INTERFACES: ${Array.isArray(interfaces) ? interfaces.join(", ") : (interfaces || "none")}`,
        `REQUIREMENTS: ${Array.isArray(requirements) ? requirements.join(", ") : (requirements || "none")}`,
        `CONCERNS: ${concerns || (summary && !hasStatusInSummary ? summary : "none")}`,
      ];
      normalized = lines.join("\n");
    }
    // Rule: tests_passed: true with 'not-run(parent-owned)' must NEVER count as executed test evidence
    // And bare tests_passed: true without command/count evidence is not allowed
    if (testsPassed === true) {
      if (/not-run\(parent-owned\)/i.test(normalized)) {
        errors.push(`tests_passed: true в сочетании с 'not-run(parent-owned)' недопустимо: флаг tests_passed не может быть true, если тесты не запускались.`);
      } else {
        const hasEvidence = /(?:было|before)\s*\:?\s*\d+\s*(?:→|->|to)\s*(?:стало|after)\s*\:?\s*\d+/i.test(normalized) ||
                            /\b\d+\s*(?:→|->)\s*\d+\b/.test(normalized);
        if (!hasEvidence) {
          errors.push(`tests_passed: true без команды и численного перехода (было N → стало M) не является доказательством выполнения.`);
        }
      }
    }
  }

  const rawLines = normalized.split("\n");
  const lines = rawLines;
  if (lines.length > 25) {
    errors.push(`Превышен лимит строк: получено ${lines.length}, максимум 25.`);
  }
  // Parse sections. They can be delimited by " · " or newlines or labels like "STATUS: ..." or "STATUS (DONE)"
  // Let's inspect tokens/sections
  // Standard format in agent instructions:
  // STATUS (DONE | ...) · FILES (paths only) · TESTS (command → было→стало) · INTERFACES · REQUIREMENTS (R## mapping) · CONCERNS/BLOCKERS
  // Sometimes formatted as:
  // STATUS: DONE
  // FILES:
  // - path/to/file
  // TESTS: node test.js -> было 0 -> стало 5
  // or inline:
  // STATUS: DONE · FILES: a.js, b.js · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R01 · CONCERNS: none

  // Let's parse sections by searching for header occurrences or section markers.
  // We look for STATUS, FILES, TESTS, INTERFACES, REQUIREMENTS, CONCERNS (or CONCERNS/BLOCKERS).
  const sectionContent = {};

  // Check if text has sections
  // Regex to match sections:
  // We can look for markers like:
  // /(?:^|[·\n\r])\s*(STATUS|FILES|TESTS|INTERFACES|REQUIREMENTS|CONCERNS(?:[\/_]BLOCKERS)?)\s*[:\-\(]/g
  // or simple section parser:
  const sectionPattern = /(?:^|[·\n])\s*(STATUS|FILES|TESTS|INTERFACES|REQUIREMENTS|CONCERNS(?:[\/_]BLOCKERS)?)\b\s*[:\-\(]?/gi;

  const matches = [];
  let m;
  while ((m = sectionPattern.exec(normalized)) !== null) {
    matches.push({
      name: m[1].toUpperCase(),
      index: m.index,
      matchLen: m[0].length,
    });
  }

  // If regex matches found, extract contents between match boundaries
  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      let key = matches[i].name;
      if (key.startsWith("CONCERNS")) key = "CONCERNS";
      const start = matches[i].index + matches[i].matchLen;
      const end = (i + 1 < matches.length) ? matches[i + 1].index : normalized.length;
      const val = normalized.slice(start, end).trim();
      sectionContent[key] = val;
    }
  }

  // Also check if any required section was missed
  for (const req of REQUIRED_SECTIONS) {
    if (!(req in sectionContent)) {
      // Check if it exists as a keyword in the text at all
      const kwRegex = new RegExp(`\\b${req}\\b`, "i");
      if (!kwRegex.test(normalized)) {
        errors.push(`Отсутствует обязательная секция: ${req}.`);
      } else {
        // Section keyword was found but maybe not parsed by pattern
        // Try fallback extraction
        sectionContent[req] = sectionContent[req] || "";
      }
    }
  }

  // 1. Validate STATUS
  const statusVal = sectionContent["STATUS"] || "";
  // Look for one of ALLOWED_STATUSES in statusVal or anywhere near STATUS
  let foundStatus = null;
  for (const s of ALLOWED_STATUSES) {
    const sRegex = new RegExp(`\\b${s}\\b`);
    if (sRegex.test(statusVal) || sRegex.test(normalized.slice(0, 200))) {
      foundStatus = s;
      break;
    }
  }
  if (!foundStatus) {
    errors.push(`Недопустимый или отсутствующий STATUS. Разрешены только: ${ALLOWED_STATUSES.join(", ")}.`);
  }

  // 2. Validate FILES
  // Paths or internal URIs only (no prose descriptions)
  const filesVal = sectionContent["FILES"] || "";
  if (filesVal) {
    // Extract file tokens (lines or comma/bullet separated)
    const fileItems = filesVal
      .split(/[\n,·]+/)
      .map((s) => s.replace(/^[\s\-\*•\(\)\:]+/, "").replace(/[\s\(\)\:]+$/, "").trim())
      .filter((s) => s.length > 0 && !s.toLowerCase().startsWith("paths only") && !s.toLowerCase().startsWith("none"));

    for (const item of fileItems) {
      // Check if item contains long prose sentences (e.g. more than 6 words without path slashes)
      const isUriOrPath = /^(?:[a-zA-Z0-9_\-\.\/\\]+|[a-z0-9_\-]+:\/\/[^\s]+)$/.test(item);
      const hasSpaces = /\s{2,}/.test(item) || (item.split(" ").length > 3 && !item.includes("/"));
      if (!isUriOrPath && hasSpaces) {
        errors.push(`Секция FILES содержит пояснительный текст вместо пути/URI: "${item}". Разрешены только пути к файлам и внутренние URI.`);
      }
    }
  }

  // 3. Validate TESTS
  // TESTS numeric before→after (было N → стало M) or exact not-run(parent-owned)
  const testsVal = sectionContent["TESTS"] || "";
  const isNotRunParent = /not-run\(parent-owned\)/i.test(testsVal) || /not-run\(parent-owned\)/i.test(normalized);
  // Check for numeric before->after: (было \d+ → стало \d+) or (\d+ -> \d+) or similar
  const hasNumericTransition = /(?:было|before)\s*\:?\s*\d+\s*(?:→|->|to)\s*(?:стало|after)\s*\:?\s*\d+/i.test(testsVal) ||
                               /\b\d+\s*(?:→|->)\s*\d+\b/.test(testsVal);

  // Bare boolean or claim without command/count evidence is explicitly rejected
  if (/tests_passed\s*:\s*true/i.test(testsVal) || /tests_passed\s*:\s*true/i.test(normalized)) {
    if (/not-run\(parent-owned\)/i.test(normalized) || /not-run\(parent-owned\)/i.test(testsVal)) {
      if (!errors.some((e) => e.includes("tests_passed"))) {
        errors.push(`tests_passed: true в сочетании с 'not-run(parent-owned)' недопустимо: тесты не запускались.`);
      }
    } else if (!hasNumericTransition) {
      if (!errors.some((e) => e.includes("tests_passed"))) {
        errors.push(`tests_passed: true без указания команды выполнения и числового перехода (было N → стало M) не является доказательством выполнения.`);
      }
    }
  }

  if (!isNotRunParent && !hasNumericTransition) {
    errors.push(`Секция TESTS должна содержать либо численный переход (например: "было N → стало M"), либо точное значение "not-run(parent-owned)".`);
  }

  const valid = errors.length === 0;

  return {
    valid,
    status: foundStatus,
    errors,
    warnings,
    lineCount: lines.length,
    sections: Object.keys(sectionContent),
  };
}

/* ----------------------------------------------------------------------- main */

const isMain = Boolean(process.argv[1]) && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

export function main(argv = process.argv.slice(2)) {
  // --help/-h — запрос справки, а не файл с таким именем.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Использование: node tools/return-contract.mjs [<file>] [--text "<контракт>"] [--json]

Проверяет контракт возврата субагента: обязательные секции (STATUS/FILES/TESTS/INTERFACES/
REQUIREMENTS/CONCERNS), ≤25 строк, числовой переход в TESTS (было N → стало M).

Флаги: <file> — путь к файлу, --text <строка> — контракт текстом, --json — машинный отчёт, --help`);
    return 0;
  }

  const args = parseArgs(argv);
  let content = "";
  if (args.text !== null) {
    content = args.text;
  } else if (args._[0] && args._[0] !== "-") {
    const file = args._[0];
    if (!existsSync(file)) {
      if (args.json) {
        console.log(JSON.stringify({ valid: false, errors: [`Файл контракта не найден: ${file}`] }, null, 2));
      } else {
        console.error(`Ошибка: файл не найден: ${file}`);
      }
      return 1;
    }
    content = readFileSync(file, "utf8");
  } else {
    // Read from stdin (file descriptor 0 or "-" argument)
    try {
      content = readFileSync(0, "utf8");
    } catch {
      content = "";
    }
    if (!content.trim()) {
      if (process.stdin.isTTY) {
        console.log("return-contract.mjs — валидация контракта возврата субагента\n");
        console.log("  node return-contract.mjs <file> [--json]");
        console.log("  node return-contract.mjs --text \"<content>\" [--json]");
        console.log("  echo \"<content>\" | node return-contract.mjs [--json]\n");
        return 1;
      }
      if (args.json) {
        console.log(JSON.stringify({ valid: false, errors: ["Пустой ввод: контракт возврата не получен на stdin."] }, null, 2));
      } else {
        console.error("ОШИБКА: пустой ввод: контракт возврата не получен на stdin.");
      }
      return 1;
    }
  }
  const result = validateReturnContract(content);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.valid) {
      console.log(`OK: контракт возврата валиден (${result.status}, строк: ${result.lineCount}).`);
    } else {
      console.error(`ОШИБКА: контракт возврата не прошел валидацию (${result.errors.length} ошибок):`);
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
    }
  }

  return result.valid ? 0 : 1;
}

if (isMain) {
  process.exitCode = main();
}
