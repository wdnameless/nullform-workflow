/**
 * tools/quality/parsers.mjs — turn each analyzer's native report into one row shape.
 *
 * Every analyzer in the matrix speaks a different dialect. The only thing the gate
 * needs is: which function, how complex, against what limit. Nothing here computes
 * complexity — it reads what the tool already computed. A parser that cannot find a
 * number returns no row rather than guessing one.
 *
 * Row: { file, line, column, coco, threshold }
 */

/** "@ts-expect-error" style helpers are deliberately absent: a silent default would
 * invent a threshold the tool never reported. */

function num(match, group = 1) {
  return match ? Number(match[group]) : null;
}

/** `from 21 to the 15 allowed` (sonarjs, S3776), `(15/4)` (pylint, clippy),
 * `[12/8]` (RuboCop). One ratio reader for all three notations. */
export function fromRatio(text) {
  const a = text.match(/from\s+(\d+)\s+to\s+the\s+(\d+)/);
  if (a) return { coco: Number(a[1]), threshold: Number(a[2]) };
  const b = text.match(/[([](\d+)\s*\/\s*(\d+)[)\]]/);
  if (b) return { coco: Number(b[1]), threshold: Number(b[2]) };
  return null;
}

/** ESLint `-f json`: one entry per file, messages carry no function name — the
 * gate resolves the name from the source position (see resolveName). */
export function parseEslintJson(stdout) {
  const rows = [];
  for (const entry of JSON.parse(stdout)) {
    for (const msg of entry.messages || []) {
      if (!/cognitive-complexity/.test(msg.ruleId || "")) continue;
      const pair = fromRatio(msg.message || "");
      if (!pair) continue;
      rows.push({ file: entry.filePath, line: msg.line, column: msg.column, ...pair });
    }
  }
  return rows;
}

/** Pylint `--output-format=json` (pylint-cognitive-complexity R7001). Carries `obj`. */
export function parsePylintJson(stdout) {
  const rows = [];
  for (const msg of JSON.parse(stdout)) {
    if (msg["message-id"] !== "R7001") continue;
    const pair = fromRatio(msg.message || "");
    if (!pair) continue;
    rows.push({ file: msg.path, line: msg.line, column: msg.column, fn: msg.obj || null, ...pair });
  }
  return rows;
}

/** Cargo `--message-format json`: newline-delimited compiler messages. */
export function parseCargoJson(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.reason !== "compiler-message") continue;
    const code = entry.message?.code?.code || "";
    if (code !== "clippy::cognitive_complexity") continue;
    const span = entry.message?.spans?.[0];
    const pair = fromRatio(entry.message?.message || "");
    if (!span || !pair) continue;
    rows.push({ file: span.file_name, line: span.line_start, column: span.column_start, ...pair });
  }
  return rows;
}

/** SARIF 2.1 (PMD, detekt). Rule text names the function; the pattern differs per tool. */
export function parseSarif(stdout) {
  const doc = JSON.parse(stdout);
  const rows = [];
  for (const run of doc.runs || []) {
    for (const result of run.results || []) {
      const text = result.message?.text || "";
      const value = num(text.match(/complexity of (\d+)/i)) ??
        num(text.match(/\(complexity:\s*(\d+)\)/i)) ??
        num(text.match(/complexity\s+(\d+)/i));
      if (value === null) continue;
      const limit = num(text.match(/threshold is (?:set to )?'?(\d+)/i)) ??
        num(text.match(/threshold is (\d+)/i));
      const loc = result.locations?.[0]?.physicalLocation;
      const region = loc?.region || {};
      rows.push({
        file: loc?.artifactLocation?.uri || "",
        line: region.startLine || 1,
        column: region.startColumn || 1,
        coco: value,
        threshold: limit,
        fn: (text.match(/'([A-Za-z0-9_$]+)\(?\)?'/) || [])[1] || null,
      });
    }
  }
  return rows;
}

/** `dotnet build` console: `Program.cs(3,25): warning S3776: ... from 21 to the 15 allowed.` */
export function parseDotnetText(stdout) {
  const rows = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s*warning\s+S3776:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(stdout))) !== null) {
    const pair = fromRatio(m[4]);
    if (!pair) continue;
    rows.push({ file: m[1].trim(), line: Number(m[2]), column: Number(m[3]), ...pair });
  }
  return rows;
}

/** golangci-lint JSON with `gocognit` enabled: `cognitive complexity 21 of func \`deep\` is high (> 15)`. */
export function parseGolangciJson(stdout) {
  const rows = [];
  for (const issue of JSON.parse(stdout).Issues || []) {
    if (issue.FromLinter !== "gocognit") continue;
    const text = issue.Text || "";
    const value = num(text.match(/cognitive complexity (\d+)/i));
    const limit = num(text.match(/\(>\s*(\d+)\)/));
    if (value === null) continue;
    rows.push({
      file: issue.Pos?.Filename || "",
      line: issue.Pos?.Line || 1,
      column: issue.Pos?.Column || 1,
      coco: value,
      threshold: limit,
      fn: (text.match(/func `([^`]+)`/) || [])[1] || null,
    });
  }
  return rows;
}

/** PHPStan JSON with TomasVotruba/cognitive-complexity: `... is 34, limit is 8`. */
export function parsePhpstanJson(stdout) {
  const rows = [];
  const doc = JSON.parse(stdout);
  for (const [file, entry] of Object.entries(doc.files || {})) {
    for (const msg of entry.messages || []) {
      const text = msg.message || "";
      const value = num(text.match(/cognitive complexity[^0-9]*(\d+)/i));
      const limit = num(text.match(/limit is (\d+)/i));
      if (value === null) continue;
      rows.push({ file, line: msg.line || 1, column: 1, coco: value, threshold: limit });
    }
  }
  return rows;
}

/** RuboCop JSON, `Metrics/PerceivedComplexity`: `Perceived complexity for deep is too high. [12/8]`.
 * A PERCEIVED score, not Sonar COCO — the adapter labels it `proxy`. */
export function parseRubocopJson(stdout) {
  const rows = [];
  for (const file of JSON.parse(stdout).files || []) {
    for (const off of file.offenses || []) {
      if (!/PerceivedComplexity/.test(off.cop_name || "")) continue;
      const pair = fromRatio(off.message || "");
      if (!pair) continue;
      rows.push({
        file: file.path,
        line: off.location?.line || 1,
        column: off.location?.column || 1,
        fn: (off.message.match(/for ([A-Za-z0-9_$?!]+)/) || [])[1] || null,
        ...pair,
      });
    }
  }
  return rows;
}

/** SwiftLint `--reporter json`, `cyclomatic_complexity`:
 * `Cyclomatic Complexity: 21. Warning Threshold: 10` — cyclomatic, hence `proxy`. */
export function parseSwiftlintJson(stdout) {
  const rows = [];
  for (const file of JSON.parse(stdout)) {
    if (file.rule_id !== "cyclomatic_complexity") continue;
    const value = num(String(file.reason || "").match(/Complexity:\s*(\d+)/));
    const limit = num(String(file.reason || "").match(/Threshold:\s*(\d+)/));
    if (value === null) continue;
    rows.push({ file: file.file, line: file.line || 1, column: file.character || 1, coco: value, threshold: limit });
  }
  return rows;
}

export const PARSERS = {
  "eslint-json": parseEslintJson,
  "pylint-json": parsePylintJson,
  "cargo-json": parseCargoJson,
  sarif: parseSarif,
  "dotnet-text": parseDotnetText,
  "golangci-json": parseGolangciJson,
  "phpstan-json": parsePhpstanJson,
  "rubocop-json": parseRubocopJson,
  "swiftlint-json": parseSwiftlintJson,
};
