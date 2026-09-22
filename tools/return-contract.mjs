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
import { readFileSync, existsSync } from "node:fs";

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

function parseArgs(argv) {
  const out = { _: [], text: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--text") {
      out.text = argv[++i];
    } else if (argv[i] === "--json") {
      out.json = true;
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

/**
 * Validate a return contract text.
 * Returns { valid: boolean, errors: string[], warnings: string[], parsed: object }
 */
export function validateReturnContract(rawText) {
  const errors = [];
  const warnings = [];
  const normalized = (rawText || "").replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  
  // Count non-trailing-empty lines or total lines
  // The rule: max lines 25
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

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("return-contract.mjs");

if (isMain) {
  const argv = process.argv.slice(2);

  // --help/-h — запрос справки, а не файл с таким именем.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Использование: node tools/return-contract.mjs [<file>] [--text "<контракт>"] [--json]

Проверяет контракт возврата субагента: обязательные секции (STATUS/FILES/TESTS/INTERFACES/
REQUIREMENTS/CONCERNS), ≤25 строк, числовой переход в TESTS (было N → стало M).

Флаги: <file> — путь к файлу, --text <строка> — контракт текстом, --json — машинный отчёт, --help`);
    process.exit(0);
  }

  const args = parseArgs(argv);
  let content = "";

  if (args.text !== null) {
    content = args.text;
  } else if (args._[0]) {
    const file = args._[0];
    if (!existsSync(file)) {
      if (args.json) {
        console.log(JSON.stringify({ valid: false, errors: [`Файл контракта не найден: ${file}`] }, null, 2));
      } else {
        console.error(`Ошибка: файл не найден: ${file}`);
      }
      process.exit(1);
    }
    content = readFileSync(file, "utf8");
  } else {
    console.log("return-contract.mjs — валидация контракта возврата субагента\n");
    console.log("  node return-contract.mjs <file> [--json]");
    console.log("  node return-contract.mjs --text \"<content>\" [--json]\n");
    process.exit(0);
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

  process.exit(result.valid ? 0 : 1);
}
