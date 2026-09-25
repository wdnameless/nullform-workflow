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
