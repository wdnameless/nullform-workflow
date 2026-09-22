import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * test-lens.mjs: Test Output Summarizer for AI Agents
 *
 * Strips noisy stack traces, environmental dumps, and passing tests from test runner output.
 * Produces a token-efficient structured JSON summary:
 * {
 *   total: number,
 *   passed: number,
 *   failed: number,
 *   failures: [
 *     { test: string, file?: string, line?: number, message: string }
 *   ],
 *   skipped?: number,          // только если раннер о нём сообщил
 *   signal?: string,           // процесс убит сигналом (exit 1)
 *   spawnError?: string        // команда не запустилась (exit 2)
 * }
 *
 * Поддерживаемые раннеры: node --test (spec reporter), jest/vitest --json, pytest, cargo test.
 * Всё остальное — rawSummary (строки с fail|error|exception).
 *
 * Коды выхода режима `run`: код команды; 2 — spawnError (команда не стартовала);
 * 1 — процесс убит сигналом. Ложный зелёный при несостоявшемся запуске невозможен.
 */

const MAX_OUTPUT = 10 * 1024 * 1024;

/** Строки ANSI-раскраски: раннеры печатают цвета только в TTY, но пайпы их иногда сохраняют. */
function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[\d+m/g, '');
}

/**
 * Найти в тексте первую сбалансированную `{...}`-подстроку, содержащую ключ `key`.
 *
 * Жадный regex `/\{[\s\S]*"key"[\s\S]*\}/` на смешанном выводе (проза + JSON + проза)
 * захватывает хвост после объекта, `JSON.parse` падает, и сводка молча деградирует
 * до rawSummary. Здесь кандидаты сканируются посимвольно со счётом скобок и с учётом
 * строк, поэтому лишний текст не заглатывается.
 *
 * @returns {object|null} разобранный объект или null, если кандидата нет
 */
export function extractJsonObject(text, key) {
  const source = stripAnsi(text);
  const keyAt = source.indexOf(`"${key}"`);
  if (keyAt === -1) return null;

  for (let start = 0; start < keyAt; start++) {
    if (source[start] !== '{') continue;
    const end = findObjectEnd(source, start);
    if (end === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(source.slice(start, end + 1));
    } catch {
      continue; // кандидат оказался не JSON-payload'ом — ищем дальше
    }
    if (parsed && typeof parsed === 'object' && parsed[key] !== undefined) return parsed;
  }
  return null;
}

/** Индекс закрывающей скобки объекта, начавшегося в `start`; -1 — объект не закрыт. */
function findObjectEnd(source, start) {
  let depth = 0;
  let inString = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Сводка из разобранного jest/vitest JSON-отчёта. */
function fromJsonReport(data) {
  const failures = [];
  const total = data.numTotalTests || 0;
  const passed = data.numPassedTests || 0;
  const failed = data.numFailedTests || 0;

  for (const fileResult of data.testResults || []) {
    for (const assertion of fileResult.assertionResults || []) {
      if (assertion.status === 'failed') {
        failures.push({
          file: fileResult.name ? fileResult.name.replace(/\\/g, '/') : '',
          test: assertion.title || assertion.fullName || 'Unknown Test',
          message: (assertion.failureMessages || []).map(m => m.split('\n')[0].replace(/\u001b\[\d+m/g, '')).join('; '),
        });
      }
    }
  }
  return { total, passed, failed, failures };
}

/** Маркер упавшего теста в spec-reporter'е node; строка `✖ failing tests:` — заголовок блока. */
const NODE_FAIL_MARKER = /^(\s*)✖\s+(.+)$/;
const NODE_TEST_LOCATION = /^\s*test at\s+(.+?):(\d+):\d+\s*$/;
const NODE_TEST_DURATION = /\s+\(\d+(?:\.\d+)?(?:ms|s)\)\s*$/;

/**
 * node --test (spec reporter).
 * Счётчики — из ℹ-блока (`ℹ tests N` / `ℹ pass N` / `ℹ fail N`), имена и сообщения —
 * из блока `✖ failing tests:`, где перед каждым маркером стоит `test at <file>:<line>:<col>`.
 *
 * @returns {object|null} null, если ℹ-сводки в выводе нет (прогон убит/обрезан)
 */
export function parseNodeTestOutput(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const counts = {};

  for (const line of lines) {
    const m = line.match(/^ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/);
    if (m) counts[m[1]] = Number(m[2]);
  }
  if (counts.tests === undefined) return null;

  const summary = {
    total: counts.tests,
    passed: counts.pass || 0,
    failed: counts.fail || 0,
    failures: collectNodeFailures(lines),
  };
  if (counts.skipped) summary.skipped = counts.skipped;
  return summary;
}

function collectNodeFailures(lines) {
  const start = lines.findIndex(line => line.trim() === '✖ failing tests:');
  // Без блока «failing tests:» остаются только inline-маркеры прогресса — имён без локаций.
  const body = start === -1 ? lines : lines.slice(start);
  const failures = [];
  let location = null;

  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const loc = line.match(NODE_TEST_LOCATION);
    if (loc) {
      location = { file: loc[1].replace(/\\/g, '/'), line: Number(loc[2]) };
      continue;
    }
    const marker = line.match(NODE_FAIL_MARKER);
    if (!marker || line.trim() === '✖ failing tests:') continue;

    const test = marker[2].replace(NODE_TEST_DURATION, '').trim();
    if (!test) continue;
    const failure = { ...(location || {}), test, message: contextLine(body, i + 1) };
    failures.push(failure);
    location = null;
  }
  return failures;
}

/** Первая содержательная строка после маркера — тип ошибки и её суть без стектрейса. */
function contextLine(lines, from) {
  for (let i = from; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (NODE_FAIL_MARKER.test(text) || NODE_TEST_LOCATION.test(text)) return '';
    return text;
  }
  return '';
}

export function parsePytestOutput(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const failures = [];
  let markerPassed = 0;
  let markerFailed = 0;

  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('FAILED ')) {
      const [test, message] = splitOnce(text.slice(7), ' - ');
      failures.push({ test: test || 'Unknown', message: message || 'Assertion failed' });
      markerFailed++;
    } else if (text.startsWith('PASSED ')) {
      markerPassed++;
    }
  }

  const tail = parsePytestTailLine(lines);
  const passed = tail.passed ?? markerPassed;
  const failed = tail.failed ?? markerFailed;
  const skipped = tail.skipped || 0;
  const result = { total: passed + failed + skipped, passed, failed, failures };
  if (skipped) result.skipped = skipped;
  return result;
}

/**
 * Сводная строка pytest (`=== 1 failed, 2 passed in 0.42s ===`) — единственный источник
 * честного `passed`: в дефолтном выводе строки `PASSED ...` не печатаются вовсе.
 */
function parsePytestTailLine(lines) {
  const tail = /^=+\s+(.*\b(?:passed|failed|error|errors|no tests ran)\b.*?)\s+in\s+[\d.]+s.*=+$/;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(tail);
    if (!m) continue;
    const counts = {};
    for (const token of m[1].matchAll(/(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed|deselected)\b/g)) {
      const key = token[2] === 'errors' ? 'error' : token[2];
      counts[key] = (counts[key] || 0) + Number(token[1]);
    }
    return counts;
  }
  return {};
}

function splitOnce(text, sep) {
  const at = text.indexOf(sep);
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + sep.length)];
}

export function parseCargoTestOutput(output) {
  const clean = stripAnsi(output);
  const failures = [];
  const lines = clean.split('\n');
  let passed = 0, failed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const matchFail = trimmed.match(/^test\s+([^\s]+)\s+\.\.\.\s+FAILED/);
    if (matchFail) {
      failures.push({ test: matchFail[1], message: 'Test failed' });
      failed++;
    } else if (/^test\s+([^\s]+)\s+\.\.\.\s+ok/.test(trimmed)) {
      passed++;
    }
  }
  return { total: passed + failed, passed, failed, failures };
}

export function summarize(rawOutput) {
  const json = extractJsonObject(rawOutput, 'testResults');
  if (json) return fromJsonReport(json);

  const nodeTest = parseNodeTestOutput(rawOutput);
  if (nodeTest) return nodeTest;

  if (rawOutput.includes('pytest') || rawOutput.includes('FAILED ') || rawOutput.includes('PASSED ')) {
    const parsed = parsePytestOutput(rawOutput);
    if (parsed.total > 0) return parsed;
  }

  if (rawOutput.includes('running ') && rawOutput.includes('test result:')) {
    const parsed = parseCargoTestOutput(rawOutput);
    if (parsed.total > 0) return parsed;
  }

  const clean = stripAnsi(rawOutput);
  const lines = clean.split('\n');
  const failureLines = lines
    .filter(l => /fail|error|exception/i.test(l))
    .map(l => l.trim())
    .slice(0, 20);

  return {
    rawSummary: true,
    totalCount: lines.length,
    failures: failureLines.map(line => ({ message: line }))
  };
}

/** Сводка для случая, когда команда вообще не стартовала: нули + пометка, а не пустой зелёный. */
function spawnErrorSummary(message) {
  return { total: 0, passed: 0, failed: 0, failures: [], spawnError: message };
}

/** Оболочка не нашла команду: cmd.exe — «is not recognized…» (status 1), sh — 127. */
const SHELL_NOT_FOUND = /(is not recognized as an internal or external command|is not recognized as the name of a cmdlet|command not found|: not found)/i;

function shellNotFound(status, stderr) {
  if (status === 127 || status === 9009) return true;
  return status === 1 && SHELL_NOT_FOUND.test(stderr);
}

/**
 * Классификация результата spawnSync: сводка + честный код выхода.
 * `error` (ENOENT и прочее) → exit 2; `status === null` (убит сигналом) → exit 1;
 * иначе — код команды. Ни один из этих случаев не должен выглядеть как зелёный прогон.
 */
export function classifyResult(result, cmd) {
  const output = (result.stdout || '') + '\n' + (result.stderr || '');

  if (result.error) {
    const message = `${cmd}: ${result.error.message}`;
    return { summary: spawnErrorSummary(message), exitCode: 2, stderr: `test-lens: spawnError: ${message}` };
  }

  if (result.status === null) {
    const signal = result.signal || 'unknown';
    return {
      summary: { ...summarize(output), signal },
      exitCode: 1,
      stderr: `test-lens: signal: command terminated by ${signal}`,
    };
  }

  if (shellNotFound(result.status, result.stderr || '')) {
    const message = `shell could not find "${cmd}"`;
    return { summary: spawnErrorSummary(message), exitCode: 2, stderr: `test-lens: spawnError: ${message}` };
  }

  return { summary: summarize(output), exitCode: result.status, stderr: null };
}

/** Операторы shell: их нельзя кавычить, иначе они станут аргументом команды. */
const SHELL_OPERATORS = new Set(['|', '||', '&&', ';', '&', '|&', '>', '>>', '<', '2>', '2>&1']);

/** Один argv-элемент как слово shell. */
function quoteArg(token) {
  if (process.platform === 'win32') {
    // cmd + MSVCRT: кавычка внутри аргумента удваивается, слэши перед ней и в конце — тоже.
    return `"${token.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Собрать командную строку для shell.
 *
 * Один токен — готовая shell-строка (`run -- "npm ci && npm test"`). Несколько токенов —
 * это argv, и его нужно кавычить самим: `spawn(..., { shell: true })` конкатенирует
 * аргументы без экранирования (DEP0190), из-за чего `node -e "process.exit(1)"` в cmd
 * ломается на скобках и прогон отчитывается чужим кодом выхода.
 */
function buildShellCommand(testCmd) {
  if (testCmd.length === 1) return testCmd[0];
  return testCmd
    .map((token, i) => (SHELL_OPERATORS.has(token) || (i === 0 && !/[\s"']/.test(token)) ? token : quoteArg(token)))
    .join(' ');
}

export function runCommand(testCmd) {
  const result = spawnSync(buildShellCommand(testCmd), {
    shell: true,
    encoding: 'utf-8',
    maxBuffer: MAX_OUTPUT
  , windowsHide: true});
  return classifyResult(result, testCmd[0]);
}

export function main(args) {
  const cmd = args[0];

  if (cmd === 'run') {
    const testCmd = args.slice(1);
    if (testCmd[0] === '--') testCmd.shift();
    if (testCmd.length === 0) {
      console.error('Usage: node test-lens.mjs run -- <command...>');
      return 1;
    }

    const { summary, exitCode, stderr } = runCommand(testCmd);
    console.log(JSON.stringify(summary, null, 2));
    if (stderr) console.error(stderr);
    return exitCode;
  }

  if (cmd === 'parse') {
    const filePath = args[1];
    const input = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : readFileSync(0, 'utf-8');
    console.log(JSON.stringify(summarize(input), null, 2));
    return 0;
  }

  console.log(`test-lens.mjs — Test Output Noise Filter for AI Agents

Usage:
  node test-lens.mjs run -- <test command>
  node test-lens.mjs parse <file>
  cat test-output.txt | node test-lens.mjs parse
`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
