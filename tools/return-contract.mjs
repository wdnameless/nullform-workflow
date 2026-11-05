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
  "INPUT GAP",
  "INPUT_GAP",
];

const REQUIRED_SECTIONS = [
  "STATUS",
  "FILES",
  "TESTS",
  "INTERFACES",
  "REQUIREMENTS",
  "CONCERNS",
];

function findMissingFields(options, fields) {
  return fields.filter((f) => {
    const val = options[f];
    return !val || (Array.isArray(val) ? val.length === 0 : !String(val).trim());
  });
}

function formatList(val, delim = ", ") {
  return Array.isArray(val) ? val.join(delim) : String(val ?? "").trim();
}

/**
 * Create a complete worker brief ensuring all required inputs are present,
 * explicit INPUT GAP instructions are included, and no third advisor is used.
 */
export function createWorkerBrief(options = {}) {
  const missing = findMissingFields(options, ["task", "files", "requirements", "criteria"]);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "INPUT GAP",
      error: `INPUT GAP: missing required inputs: ${missing.join(", ")}`,
      missingInputs: missing,
      brief: null,
    };
  }

  const filesStr = formatList(options.files);
  const reqsStr = formatList(options.requirements);
  const critStr = formatList(options.criteria, "; ");
  const ifaceStr = options.interfaces ? formatList(options.interfaces) : "none";
  const constrStr = options.constraints ? formatList(options.constraints, "; ") : "none";

  const briefText = [
    `# Target`,
    `Zone: ${filesStr}`,
    `# Task`,
    `${String(options.task).trim()}`,
    `# Requirements`,
    `${reqsStr}`,
    `# Acceptance Criteria`,
    `${critStr}`,
    `# Interfaces`,
    `${ifaceStr}`,
    `# Constraints`,
    `${constrStr}`,
    `# Rules`,
    `- Complete inputs required. If any required input is missing: state INPUT GAP; NEVER invent or assume missing context.`,
    `- No third advisor: direct execution only.`,
    `- Return contract (≤25 lines): STATUS (DONE | DONE_WITH_CONCERNS | HANDOFF | BLOCKED | NEEDS_CONTEXT | INPUT GAP) · FILES · TESTS · INTERFACES · REQUIREMENTS · CONCERNS.`,
  ].join("\n");

  return {
    ok: true,
    status: "OK",
    error: null,
    missingInputs: [],
    brief: briefText,
    task: String(options.task).trim(),
    files: filesStr,
    requirements: reqsStr,
    criteria: critStr,
  };
}

/**
 * Validate a worker brief ensuring complete inputs, explicit INPUT GAP rule,
 * and no third advisor invocation.
 */
export function validateWorkerBrief(brief) {
  const errors = [];
  const missingInputs = [];

  const text = typeof brief === "string" ? brief : (brief?.brief || JSON.stringify(brief || ""));

  const hasTargetOrZone = /#\s*Target\b|Zone\s*:/i.test(text);
  const hasTask = /#\s*Task\b|Task\s*:/i.test(text);
  const hasReqs = /#\s*Requirements\b|Requirements\s*:/i.test(text);
  const hasCriteria = /#\s*Acceptance Criteria\b|Acceptance\s*:/i.test(text);

  if (!hasTargetOrZone) missingInputs.push("files");
  if (!hasTask) missingInputs.push("task");
  if (!hasReqs) missingInputs.push("requirements");
  if (!hasCriteria) missingInputs.push("criteria");

  if (missingInputs.length > 0) {
    errors.push(`INPUT GAP: missing required input sections: ${missingInputs.join(", ")}`);
  }

  if (!/\bINPUT[ _]GAP\b/i.test(text)) {
    errors.push("Worker brief must contain explicit INPUT GAP rule.");
  }

  if (/(?<!\b(?:no|without|prohibit(?:ed)?|never)\s+(?:a\s+)?)(?:third[ _\-]?advisor|consult\s+(?:a\s+)?(?:third\s+)?advisor|advisor[ _\-]?model)/i.test(text)) {
    errors.push("Third advisor prohibited: fresh redispatch must be direct without a third advisor.");
  }

  return {
    valid: errors.length === 0,
    errors,
    missingInputs,
  };
}

/**
 * Create a FIX fresh-redispatch brief carrying failed criterion, complete inputs,
 * explicit INPUT GAP instruction, and strictly no third advisor.
 */
export function createRedispatchBrief(options = {}) {
  if (options.advisor || options.thirdAdvisor || options.useAdvisor) {
    return {
      ok: false,
      status: "ERROR",
      error: "Third advisor prohibited: FIX fresh-redispatch must be direct without third advisor.",
      missingInputs: [],
      brief: null,
      fresh: false,
    };
  }

  const missing = findMissingFields(options, ["failedCriterion", "task", "files", "requirements"]);
  if (missing.length > 0) {
    return {
      ok: false,
      status: "INPUT GAP",
      error: `INPUT GAP: missing ${missing.includes("failedCriterion") ? "failed criterion for FIX fresh-redispatch" : "required inputs: " + missing.join(", ")}`,
      missingInputs: missing,
      brief: null,
      fresh: false,
    };
  }

  const filesStr = formatList(options.files);
  const reqsStr = formatList(options.requirements);
  const failedCrit = String(options.failedCriterion).trim();
  const briefText = [
    `# Target`,
    `Zone: ${filesStr}`,
    `# Task`,
    `${String(options.task).trim()}`,
    `# Requirements`,
    `${reqsStr}`,
    `# FIX FRESH-REDISPATCH`,
    `FAILED CRITERION: ${failedCrit}`,
    `# Rules`,
    `- Complete inputs required. If any required input is missing: state INPUT GAP; NEVER invent or assume missing context.`,
    `- Fresh redispatch: direct fix execution only; no third advisor.`,
    `- Return contract (≤25 lines): STATUS (DONE | DONE_WITH_CONCERNS | HANDOFF | BLOCKED | NEEDS_CONTEXT | INPUT GAP) · FILES · TESTS · INTERFACES · REQUIREMENTS · CONCERNS.`,
  ].join("\n");

  return {
    ok: true,
    status: "OK",
    error: null,
    missingInputs: [],
    brief: briefText,
    fresh: true,
    failedCriterion: failedCrit,
  };
}

/**
 * Validate a FIX fresh-redispatch ensuring it carries failed criterion,
 * explicit INPUT GAP, and strictly no third advisor.
 */
export function validateRedispatch(brief) {
  const errors = [];
  const text = typeof brief === "string" ? brief : (brief?.brief || JSON.stringify(brief || ""));

  if (!/FAILED CRITERION\s*:/i.test(text) && !brief?.failedCriterion) {
    errors.push("FIX redispatch must carry explicit failed criterion.");
  }

  if (!/\bINPUT[ _]GAP\b/i.test(text)) {
    errors.push("Redispatch brief must contain explicit INPUT GAP rule.");
  }

  if (/(?<!\b(?:no|without|prohibit(?:ed)?|never)\s+(?:a\s+)?)(?:third[ _\-]?advisor|consult\s+(?:a\s+)?(?:third\s+)?advisor|advisor[ _\-]?model)/i.test(text) || brief?.advisor) {
    errors.push("Third advisor prohibited: FIX fresh-redispatch must be direct without a third advisor.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

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
      else if (status === "INPUT_GAP") status = "INPUT GAP";

      const files = parsedJson.files_modified || parsedJson.files;
      const requirements = parsedJson.requirements || "";
      const interfaces = parsedJson.interfaces || "";
      const concerns = parsedJson.concerns || "";

      const testsVal = parsedJson.tests || (testsPassed === false ? "failed" : summary);

      normalized = [
        `STATUS: ${status}`,
        `FILES: ${formatList(files, ", ") || "none"}`,
        `TESTS: ${testsVal}`,
        `INTERFACES: ${formatList(interfaces, ", ") || "none"}`,
        `REQUIREMENTS: ${formatList(requirements, ", ") || "none"}`,
        `CONCERNS: ${concerns || (summary && !hasStatusInSummary ? summary : "none")}`,
      ].join("\n");
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

  const lines = normalized.split("\n");
  if (lines.length > 25) {
    errors.push(`Превышен лимит строк: получено ${lines.length}, максимум 25.`);
  }
  const sectionContent = {};
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
    const sRegex = new RegExp(`\\b${s.replace(/\s+/g, "[ _]")}\\b`, "i");
    if (sRegex.test(statusVal) || sRegex.test(normalized.slice(0, 200))) {
      foundStatus = s === "INPUT_GAP" ? "INPUT GAP" : s;
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

  // Contradiction check: DONE vs INPUT GAP reported in CONCERNS
  const concernsVal = sectionContent["CONCERNS"] || "";
  if (foundStatus === "DONE" && /\bINPUT[ _]GAP\b/i.test(concernsVal)) {
    errors.push(`Противоречивый статус: обнаружен INPUT GAP в CONCERNS, но статус заявлен как DONE. Задача требует NEEDS_CONTEXT или INPUT GAP.`);
  }

  // 3. Validate TESTS
  // TESTS numeric before→after (было N → стало M) or exact not-run(parent-owned)
  const testsVal = sectionContent["TESTS"] || "";
  const isInputGapStatus = foundStatus === "INPUT GAP" || foundStatus === "NEEDS_CONTEXT" || foundStatus === "BLOCKED";
  const isNotRunGap = isInputGapStatus && /not-run\((?:input-gap|missing-input|gap)\)|not-run|none/i.test(testsVal);
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

  if (!isNotRunParent && !hasNumericTransition && !isNotRunGap) {
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
    if (process.stdin.isTTY) {
      console.log("return-contract.mjs — валидация контракта возврата субагента\n");
      console.log("  node return-contract.mjs <file> [--json]");
      console.log("  node return-contract.mjs --text \"<content>\" [--json]");
      console.log("  echo \"<content>\" | node return-contract.mjs [--json]\n");
      return 2;
    }
    // Read from stdin (file descriptor 0 or "-" argument)
    try {
      content = readFileSync(0, "utf8");
    } catch {
      content = "";
    }
    if (!content.trim()) {
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
