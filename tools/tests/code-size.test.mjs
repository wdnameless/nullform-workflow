/**
 * tools/tests/code-size.test.mjs — тесты для инструмента code-size.
 *
 * Покрывает:
 *   - Чистое дерево проходит проверку (exit 0)
 *   - Новый файл > 700 строк вызывает отказ (exit 1)
 *   - Новая функция > 120 строк вызывает отказ (exit 1)
 *   - Зафиксированный в baseline нарушитель того же размера проходит (exit 0)
 *   - Рост файла сверх baseline вызывает отказ (exit 1)
 *   - Рост функции сверх baseline вызывает отказ (exit 1)
 *   - defer: в заголовке файла освобождает от падения (exit 0)
 *   - // code-size:allow на строке функции освобождает от падения (exit 0)
 *   - Структура вывода --json
 *   - Временные каталоги гарантированно удаляются
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THRESHOLDS,
  DEFAULT_SCOPE,
  globToRegex,
  hasHeaderDeferMarker,
  scanFunctions,
  scanFile,
  buildBaseline,
  checkCodeSize,
  main,
} from "../code-size.mjs";

const CLI_PATH = fileURLToPath(new URL("../code-size.mjs", import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "code-size-test-"));
  try {
    fn(dir);
  } finally {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test("DEFAULT_THRESHOLDS has maxLines 700 and maxFunctionLines 120", () => {
  assert.equal(DEFAULT_THRESHOLDS.maxLines, 700);
  assert.equal(DEFAULT_THRESHOLDS.maxFunctionLines, 120);
});

test("class and object-literal methods count toward the function limit", () => {
  // Regression: a 409-line file holding two 200-line methods reported zero offenders,
  // because the matcher knew only `function`, `const x = function`, and arrows.
  const src = [
    "class Big {",
    "  handle() {",
    ...Array.from({ length: 200 }, (_, i) => `    const v${i} = ${i};`),
    "  }",
    "}",
    "const obj = {",
    "  run() {",
    ...Array.from({ length: 200 }, (_, i) => `    const w${i} = ${i};`),
    "  },",
    "};",
  ].join("\n");
  const fns = scanFunctions(src);
  const names = fns.map((f) => f.name);
  assert.ok(names.includes("handle"), `expected class method, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("run"), `expected object method, got ${JSON.stringify(names)}`);
  for (const n of ["handle", "run"]) {
    const fn = fns.find((f) => f.name === n);
    assert.ok(fn.lines > 120, `${n} should be over 120 lines, got ${fn.lines}`);
  }
});

test("control-flow blocks are not mistaken for methods", () => {
  // Regression: `for (const x of y) {` matched the method pattern and was reported
  // as a 157-line "function" in the real tree.
  const src = [
    "function outer() {",
    "  for (const x of xs) {",
    "    if (x) {",
    "      consume(x);",
    "    }",
    "  }",
    "  while (busy) {",
    "    tick();",
    "  }",
    "}",
  ].join("\n");
  const names = scanFunctions(src).map((f) => f.name);
  for (const kw of ["for", "if", "while"]) {
    assert.ok(!names.includes(kw), `control-flow keyword '${kw}' was matched as a function`);
  }
  assert.ok(names.includes("outer"));
});

test("globToRegex: correctly matches scope patterns", () => {
  const reTools = globToRegex("tools/**/*.mjs");
  assert.equal(reTools.test("tools/dashboard.mjs"), true);
  assert.equal(reTools.test("tools/tests/test.mjs"), true);
  assert.equal(reTools.test("skills/test.mjs"), false);

  const reSkills = globToRegex("skills/*/scripts/*.py");
  assert.equal(reSkills.test("skills/design/scripts/gen.py"), true);
  assert.equal(reSkills.test("skills/design/templates/gen.py"), false);

  const rePs1 = globToRegex("*.ps1");
  assert.equal(rePs1.test("install.ps1"), true);
  assert.equal(rePs1.test("tools/sync.ps1"), true);
});

test("hasHeaderDeferMarker: detects defer comments within first 50 lines", () => {
  const codeWithDefer = [
    "#!/usr/bin/env node",
    "// defer: deliberate simplification | ceiling: 2000 | upgrade: next quarter",
    "export function main() {}",
  ].join("\n");
  assert.equal(hasHeaderDeferMarker(codeWithDefer), true);

  const codeWithoutDefer = [
    "#!/usr/bin/env node",
    "// normal comment",
    "export function main() {}",
  ].join("\n");
  assert.equal(hasHeaderDeferMarker(codeWithoutDefer), false);
});

test("clean tree passes check with exit code 0", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(
      join(dir, "tools", "small.mjs"),
      "export function small() {\n  return 42;\n}\n",
      "utf8"
    );

    const res = checkCodeSize(dir);
    assert.equal(res.ok, true);
    assert.equal(res.failures.length, 0);

    const proc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /PASS/);
  });
});

test("new offender fails: file exceeding 700 lines without baseline", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const content = Array(720).fill("const x = 1;").join("\n");
    writeFileSync(join(dir, "tools", "big.mjs"), content, "utf8");

    const res = checkCodeSize(dir);
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].type, "file_new");
    assert.equal(res.failures[0].file, "tools/big.mjs");

    const proc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /tools\/big\.mjs/);
  });
});

test("new offender fails: function exceeding 120 lines without baseline", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const fnLines = ["export function huge() {"];
    for (let i = 0; i < 130; i++) fnLines.push(`  const v${i} = ${i};`);
    fnLines.push("  return 0;");
    fnLines.push("}");
    writeFileSync(join(dir, "tools", "fn.mjs"), fnLines.join("\n"), "utf8");

    const res = checkCodeSize(dir);
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].type, "function_new");
    assert.match(res.failures[0].message, /huge\(\)/);

    const proc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /huge\(\)/);
  });
});

test("baselined offender at same size passes check", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const content = Array(750).fill("const x = 1;").join("\n");
    writeFileSync(join(dir, "tools", "legacy.mjs"), content, "utf8");

    // Baseline via CLI
    const baseProc = spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });
    assert.equal(baseProc.status, 0);
    assert.equal(existsSync(join(dir, ".code-size.baseline.json")), true);

    // Check should now exit 0
    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(checkProc.status, 0);
    assert.match(checkProc.stdout, /PASS/);

    const res = checkCodeSize(dir);
    assert.equal(res.ok, true);
    assert.equal(res.failures.length, 0);
    assert.equal(res.stats.baselined, 1);
  });
});

test("growth fails: baselined file growing beyond baseline size fails", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const content = Array(750).fill("const x = 1;").join("\n");
    writeFileSync(join(dir, "tools", "growing.mjs"), content, "utf8");

    // Create baseline at 750 lines
    spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });

    // Grow by 40 lines
    const grownContent = content + "\n" + Array(40).fill("const added = 2;").join("\n");
    writeFileSync(join(dir, "tools", "growing.mjs"), grownContent, "utf8");

    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(checkProc.status, 1);
    assert.match(checkProc.stderr, /tools\/growing\.mjs/);
    assert.match(checkProc.stderr, /baseline 750/);

    const res = checkCodeSize(dir);
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].type, "file_growth");
    assert.equal(res.failures[0].file, "tools/growing.mjs");
  });
});

test("growth fails: baselined function growing beyond baseline size fails", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const makeFn = (count) => {
      const lines = ["export function bigFunc() {"];
      for (let i = 0; i < count; i++) lines.push(`  const x${i} = ${i};`);
      lines.push("  return 0;\n}");
      return lines.join("\n");
    };

    writeFileSync(join(dir, "tools", "fn_growth.mjs"), makeFn(130), "utf8");
    spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });

    // Grow function by 20 lines
    writeFileSync(join(dir, "tools", "fn_growth.mjs"), makeFn(150), "utf8");

    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(checkProc.status, 1);
    assert.match(checkProc.stderr, /bigFunc\(\)/);

    const res = checkCodeSize(dir);
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].type, "function_growth");
  });
});

test("defer: marker in header exempts file growth from failure", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const header = [
      "#!/usr/bin/env node",
      "// defer: deliberate monolithic tool | ceiling: 2000 | upgrade: v2 architecture",
      "",
    ].join("\n");
    const content = header + Array(750).fill("const x = 1;").join("\n");
    writeFileSync(join(dir, "tools", "deferred.mjs"), content, "utf8");

    // Baseline
    spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });

    // Grow file by 50 lines
    const grown = content + "\n" + Array(50).fill("const more = 1;").join("\n");
    writeFileSync(join(dir, "tools", "deferred.mjs"), grown, "utf8");

    // Check should pass (exit 0) because of defer exemption
    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(checkProc.status, 0);
    assert.match(checkProc.stdout, /EXEMPT/);

    const res = checkCodeSize(dir);
    assert.equal(res.ok, true);
    assert.equal(res.failures.length, 0);
    assert.equal(res.stats.exempt, 1);
    const rep = res.files.find((f) => f.file === "tools/deferred.mjs");
    assert.ok(rep);
    assert.equal(rep.exempt, true);
    assert.equal(rep.status, "grew_exempt");
  });
});

test("// code-size:allow comment exempts function from failure", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const fnLines = ["export function allowedBig() { // code-size:allow"];
    for (let i = 0; i < 150; i++) fnLines.push(`  const a${i} = ${i};`);
    fnLines.push("  return 0;");
    fnLines.push("}");
    writeFileSync(join(dir, "tools", "allowed.mjs"), fnLines.join("\n"), "utf8");

    // Check without baseline: function exceeds 120 lines, but is exempt
    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir], { encoding: "utf8" });
    assert.equal(checkProc.status, 0);
    assert.match(checkProc.stdout, /EXEMPT/);

    const res = checkCodeSize(dir);
    assert.equal(res.ok, true);
    assert.equal(res.failures.length, 0);
    assert.equal(res.stats.exempt, 1);
  });
});

test("--json shape matches contract", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "sample.mjs"), "export function ok() { return 1; }\n", "utf8");

    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir, "--json"], { encoding: "utf8" });
    assert.equal(checkProc.status, 0);

    const parsed = JSON.parse(checkProc.stdout);
    assert.equal(typeof parsed.ok, "boolean");
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.thresholds.maxLines, "number");
    assert.equal(typeof parsed.thresholds.maxFunctionLines, "number");
    assert.equal(typeof parsed.stats.scannedFiles, "number");
    assert.equal(typeof parsed.stats.scannedFunctions, "number");
    assert.equal(typeof parsed.stats.failures, "number");
    assert.ok(Array.isArray(parsed.failures));
    assert.ok(Array.isArray(parsed.files));
    assert.ok(Array.isArray(parsed.functions));
  });
});

test("temp directories are cleaned up", () => {
  let createdDir = null;
  withTempDir((dir) => {
    createdDir = dir;
    assert.equal(existsSync(dir), true);
  });
  assert.equal(existsSync(createdDir), false);
});

test("R36: multiline method signatures count toward the function limit", () => {
  const src = [
    "class Handler {",
    "  handle(",
    "    req,",
    "    res,",
    "    next",
    "  ) {",
    ...Array.from({ length: 150 }, (_, i) => `    const a${i} = ${i};`),
    "  }",
    "}",
    "const service = {",
    "  process(data)",
    "  {",
    ...Array.from({ length: 150 }, (_, i) => `    const b${i} = ${i};`),
    "  },",
    "};",
    "class AsyncService {",
    "  async dispatch(",
    "    payload",
    "  )",
    "  {",
    ...Array.from({ length: 150 }, (_, i) => `    const c${i} = ${i};`),
    "  }",
    "}",
  ].join("\n");

  const fns = scanFunctions(src);
  const names = fns.map((f) => f.name);
  assert.ok(names.includes("handle"), `expected handle, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("process"), `expected process, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("dispatch"), `expected dispatch, got ${JSON.stringify(names)}`);

  for (const name of ["handle", "process", "dispatch"]) {
    const fn = fns.find((f) => f.name === name);
    assert.ok(fn.lines > 120, `${name} should be over 120 lines, got ${fn.lines}`);
  }
});

test("R37: template literals containing function-syntax text are not measured", () => {
  const src = [
    "const tpl = `",
    "function fakeInTemplate() {",
    ...Array.from({ length: 150 }, (_, i) => `  const x${i} = ${i};`),
    "}",
    "`;",
    "function realFn() {",
    "  return 1;",
    "}",
    "function wrapper() {",
    "  const str = `",
    "    function fakeNestedInTemplate() {",
    "      return 42;",
    "    }",
    "  `;",
    "  return str;",
    "}",
  ].join("\n");

  const fns = scanFunctions(src);
  const names = fns.map((f) => f.name);
  assert.ok(!names.includes("fakeInTemplate"), "fakeInTemplate should NOT be measured");
  assert.ok(!names.includes("fakeNestedInTemplate"), "fakeNestedInTemplate should NOT be measured");
  assert.ok(names.includes("realFn"), "realFn SHOULD be measured");
  assert.ok(names.includes("wrapper"), "wrapper SHOULD be measured");
});

test("R37: block comments containing function-syntax text are not measured", () => {
  const src = [
    "/*",
    "function fakeInBlockComment() {",
    ...Array.from({ length: 150 }, (_, i) => `  const y${i} = ${i};`),
    "}",
    "class Dummy {",
    "  commentedMethod() {",
    "    return true;",
    "  }",
    "}",
    "*/",
    "function realCommentFn() {",
    "  return 2;",
    "}",
  ].join("\n");

  const fns = scanFunctions(src);
  const names = fns.map((f) => f.name);
  assert.ok(!names.includes("fakeInBlockComment"), "fakeInBlockComment should NOT be measured");
  assert.ok(!names.includes("commentedMethod"), "commentedMethod should NOT be measured");
  assert.ok(names.includes("realCommentFn"), "realCommentFn SHOULD be measured");
});

test("R38: two baseline runs produce byte-identical output", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "tools"), { recursive: true });
    const offenderCode = [
      "export function bigHandler() {",
      ...Array.from({ length: 150 }, (_, i) => `  const v${i} = ${i};`),
      "}",
    ].join("\n") + "\n";
    writeFileSync(join(dir, "tools", "offender.mjs"), offenderCode, "utf8");

    const baselinePath = join(dir, ".code-size.baseline.json");

    // First run
    const proc1 = spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });
    assert.equal(proc1.status, 0);
    const content1 = readFileSync(baselinePath, "utf8");

    // Second run
    const proc2 = spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir], { encoding: "utf8" });
    assert.equal(proc2.status, 0);
    const content2 = readFileSync(baselinePath, "utf8");

    assert.equal(content1, content2, "Two baseline runs must produce byte-identical files");
    assert.ok(!content1.includes("generatedAt"), "Baseline output should not contain volatile generatedAt timestamp");

    // Check buildBaseline function directly
    const b1 = buildBaseline(dir);
    const b2 = buildBaseline(dir);
    assert.deepStrictEqual(b1, b2, "buildBaseline calls must produce identical objects");
  });
});
