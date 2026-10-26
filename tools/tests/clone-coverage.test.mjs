/**
 * tools/tests/clone-coverage.test.mjs — тесты для инструмента clone-coverage.
 *
 * Покрывает:
 *   - DEFAULT_THRESHOLDS содержит minLines 10 и failLines 35
 *   - normalizeLine: удаление комментариев, свёртывание пробелов, сохранение строк
 *   - tokenBlindLine / tokenBlindHash: замена идентификаторов, чисел и строк
 *   - T1 exact: обнаружение точных дубликатов с kind='T1'
 *   - T2 renamed-identifiers: обнаружение дубликатов с переименованными переменными с kind='T2'
 *   - blank/comment windows ignored: окна из пустых строк и комментариев игнорируются
 *   - overlap merge: объединение пересекающихся окон на одной паре файлов в максимальный блок
 *   - baseline growth/new-offender fail: фиксация нарушений при новом нарушителе или росте сверх baseline
 *   - escape hatches: defer: в заголовке и clone:allow освобождают от падения
 *   - coverage: корректный расчёт доли строк без двойного счёта
 *   - JSON shape: валидная структура вывода --json
 *   - Временные каталоги гарантированно удаляются
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THRESHOLDS,
  DEFAULT_SCOPE,
  DEFAULT_BASELINE_FILE,
  normalizeLine,
  tokenBlindLine,
  tokenBlindHash,
  baselineKey,
  coverage,
  scanClones,
  buildBaseline,
  checkClones,
  parseArgs,
} from "../clone-coverage.mjs";

const CLI_PATH = fileURLToPath(new URL("../clone-coverage.mjs", import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "clone-coverage-test-"));
  try {
    fn(dir);
  } finally {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test("DEFAULT_THRESHOLDS has minLines 10 and failLines 35", () => {
  assert.equal(DEFAULT_THRESHOLDS.minLines, 10);
  assert.equal(DEFAULT_THRESHOLDS.failLines, 35);
  assert.equal(DEFAULT_BASELINE_FILE, ".clone-baseline.json");
  assert.ok(Array.isArray(DEFAULT_SCOPE) && DEFAULT_SCOPE.length > 0);
});
test("baselineKey and parseArgs functionality", () => {
  const key = baselineKey({
    occurrences: [
      { file: "b.mjs", line: 40 },
      { file: "a.mjs", line: 10 },
    ],
  });
  assert.equal(key, "a.mjs:10,b.mjs:40");
  assert.equal(baselineKey(null), "");

  const parsed = parseArgs(["check", "--root", "./src", "--json", "--baseline", "custom.json"]);
  assert.equal(parsed._[0], "check");
  assert.equal(parsed.root, "./src");
  assert.equal(parsed.json, true);
  assert.equal(parsed.baseline, "custom.json");
});

test("normalizeLine: strips single-line and block comments, collapses whitespace, preserves quotes", () => {
  assert.equal(normalizeLine("  const   x   =   1;  // set x"), "const x = 1;");
  assert.equal(normalizeLine("    # python style comment"), "");
  assert.equal(normalizeLine("  // just a comment"), "");
  assert.equal(normalizeLine("   "), "");
  assert.equal(normalizeLine("/**"), "");
  assert.equal(normalizeLine(" * JSDoc comment"), "");
  assert.equal(normalizeLine(" */"), "");
  assert.equal(normalizeLine("/* inline comment */ const y = 2;"), "const y = 2;");
  assert.equal(normalizeLine('  const url = "https://example.com#anchor"; // link'), 'const url = "https://example.com#anchor";');
  assert.equal(normalizeLine("  *generatorMethod() {"), "*generatorMethod() {");
});

test("tokenBlindLine and tokenBlindHash: normalize identifiers, numbers, and strings", () => {
  const lineA = "const totalCount = 42;";
  const lineB = "let itemsAmount = 999;";
  assert.equal(tokenBlindLine(lineA), "$ID $ID = $NUM;");
  assert.equal(tokenBlindLine(lineB), "$ID $ID = $NUM;");

  const snippet1 = [
    "function calculateTotal(records) {",
    "  let sum = 0;",
    "  for (const item of records) {",
    "    sum += item.amount;",
    "  }",
    "  return sum;",
    "}",
  ];
  const snippet2 = [
    "function computeAggregate(entries) {",
    "  let accum = 0;",
    "  for (const entry of entries) {",
    "    accum += entry.value;",
    "  }",
    "  return accum;",
    "}",
  ];

  const hash1 = tokenBlindHash(snippet1);
  const hash2 = tokenBlindHash(snippet2);
  assert.equal(hash1, hash2, "snippets with renamed identifiers must produce identical tokenBlindHash");

  const diffSnippet = [
    "class RecordProcessor {",
    "  constructor() {",
    "    this.state = null;",
    "  }",
    "}",
  ];
  const hash3 = tokenBlindHash(diffSnippet);
  assert.notEqual(hash1, hash3, "different structural snippets must produce different tokenBlindHash");
});

test("T1 exact: identical code windows are detected as kind T1", () => {
  withTempDir((dir) => {
    const code = Array.from({ length: 15 }, (_, i) => `const val_${i} = ${i * 10};`).join("\n");
    writeFileSync(join(dir, "fileA.mjs"), `// File A header\n${code}\n`);
    writeFileSync(join(dir, "fileB.mjs"), `// File B header\n${code}\n`);

    const clones = scanClones(dir, { minLines: 10, scope: ["*.mjs"] });
    assert.equal(clones.length, 1);
    assert.equal(clones[0].kind, "T1");
    assert.equal(clones[0].lines, 15);
    assert.equal(clones[0].occurrences.length, 2);
    assert.deepEqual(
      clones[0].occurrences.map((o) => o.file).sort(),
      ["fileA.mjs", "fileB.mjs"]
    );
  });
});

test("T2 renamed-identifiers: renamed variables and literals detected as kind T2", () => {
  withTempDir((dir) => {
    const codeA = [
      "function runTaskA(inputItems) {",
      "  let firstResult = 100;",
      "  const limitVal = 500;",
      "  for (const it of inputItems) {",
      "    if (it.score > limitVal) {",
      "      firstResult += it.score;",
      "    }",
      "  }",
      "  console.log('Result A:', firstResult);",
      "  return firstResult;",
      "}",
    ].join("\n");

    const codeB = [
      "function runTaskB(dataRecords) {",
      "  let secondOutput = 200;",
      "  const capThreshold = 999;",
      "  for (const rec of dataRecords) {",
      "    if (rec.points > capThreshold) {",
      "      secondOutput += rec.points;",
      "    }",
      "  }",
      "  console.log('Result B:', secondOutput);",
      "  return secondOutput;",
      "}",
    ].join("\n");

    writeFileSync(join(dir, "workerA.mjs"), codeA);
    writeFileSync(join(dir, "workerB.mjs"), codeB);

    const clones = scanClones(dir, { minLines: 10, scope: ["*.mjs"] });
    assert.equal(clones.length, 1);
    assert.equal(clones[0].kind, "T2");
    assert.equal(clones[0].lines, 11);
    assert.equal(clones[0].occurrences.length, 2);
  });
});

test("blank/comment windows ignored: files containing only blanks or comments produce no clones", () => {
  withTempDir((dir) => {
    const commentsOnly1 = Array.from({ length: 25 }, (_, i) => `// Comment line ${i}`).join("\n");
    const commentsOnly2 = Array.from({ length: 25 }, (_, i) => `// Different comment ${i}`).join("\n");
    const blanksOnly = Array.from({ length: 25 }, () => "   \t   ").join("\n");

    writeFileSync(join(dir, "commentsA.mjs"), commentsOnly1);
    writeFileSync(join(dir, "commentsB.mjs"), commentsOnly2);
    writeFileSync(join(dir, "blanks.mjs"), blanksOnly);

    const clones = scanClones(dir, { minLines: 10, scope: ["*.mjs"] });
    assert.equal(clones.length, 0, "blank and comment windows must be completely ignored");
  });
});

test("overlap merge: overlapping sliding windows merge into one maximal block", () => {
  withTempDir((dir) => {
    // 14 identical lines. With window size 10, there are 5 overlapping windows of length 10.
    // They must merge into a single clone block of length 14, not 5 separate clone entries.
    const block = Array.from({ length: 14 }, (_, i) => `const itemVar_${i} = compute(${i});`).join("\n");
    writeFileSync(join(dir, "source1.mjs"), block);
    writeFileSync(join(dir, "source2.mjs"), block);

    const clones = scanClones(dir, { minLines: 10, scope: ["*.mjs"] });
    assert.equal(clones.length, 1, "overlapping windows must merge into 1 maximal block");
    assert.equal(clones[0].lines, 14, "merged block lines must equal total consecutive matching lines");
    assert.equal(clones[0].occurrences.length, 2);
  });
});

test("multi-occurrence clones: three matching files produce one clone record with 3 occurrences", () => {
  withTempDir((dir) => {
    const block = Array.from({ length: 12 }, (_, i) => `const syncConst_${i} = "val_${i}";`).join("\n");
    writeFileSync(join(dir, "alpha.mjs"), block);
    writeFileSync(join(dir, "beta.mjs"), block);
    writeFileSync(join(dir, "gamma.mjs"), block);

    const clones = scanClones(dir, { minLines: 10, scope: ["*.mjs"] });
    assert.equal(clones.length, 1);
    assert.equal(clones[0].occurrences.length, 3);
    assert.deepEqual(
      clones[0].occurrences.map((o) => o.file).sort(),
      ["alpha.mjs", "beta.mjs", "gamma.mjs"]
    );
  });
});

test("coverage: correctly calculates unique cloned line ratio", () => {
  const clones = [
    {
      hash: "abc",
      lines: 10,
      occurrences: [
        { file: "a.mjs", line: 1 },
        { file: "b.mjs", line: 1 },
      ],
    },
  ];
  // 10 lines in a.mjs + 10 lines in b.mjs = 20 unique cloned lines. Out of 200 total lines -> 0.10.
  const ratio = coverage(clones, 200);
  assert.equal(ratio, 0.1);

  assert.equal(coverage([], 200), 0);
  assert.equal(coverage(clones, 0), 0);
  assert.equal(coverage(clones, -10), 0);
});

test("baseline growth/new-offender fail: ratchet gate enforces thresholds", () => {
  withTempDir((dir) => {
    // Thresholds: minLines: 10, failLines: 15
    const thresholds = { minLines: 10, failLines: 15 };
    const longBlock = Array.from({ length: 20 }, (_, i) => `const longItem_${i} = ${i};`).join("\n");
    writeFileSync(join(dir, "orig1.mjs"), longBlock);
    writeFileSync(join(dir, "orig2.mjs"), longBlock);

    // 1. Without baseline, long clone >= failLines fails as clone_new
    const initialCheck = checkClones(dir, { thresholds, scope: ["*.mjs"] });
    assert.equal(initialCheck.ok, false);
    assert.equal(initialCheck.failures.length, 1);
    assert.equal(initialCheck.failures[0].type, "clone_new");

    // 2. Build baseline
    const baseData = buildBaseline(dir, { thresholds, scope: ["*.mjs"] });
    assert.equal(baseData.clones.length, 1);
    assert.equal(baseData.clones[0].lines, 20);
    const baseFile = join(dir, ".clone-baseline.json");
    writeFileSync(baseFile, JSON.stringify(baseData, null, 2) + "\n");

    // 3. Check passes with baseline
    const baselinedCheck = checkClones(dir, { thresholds, scope: ["*.mjs"], baselinePath: baseFile });
    assert.equal(baselinedCheck.ok, true);
    assert.equal(baselinedCheck.failures.length, 0);

    // 4. Growth beyond baseline fails
    const extendedBlock = Array.from({ length: 25 }, (_, i) => `const longItem_${i} = ${i};`).join("\n");
    writeFileSync(join(dir, "orig1.mjs"), extendedBlock);
    writeFileSync(join(dir, "orig2.mjs"), extendedBlock);

    const growthCheck = checkClones(dir, { thresholds, scope: ["*.mjs"], baselinePath: baseFile });
    assert.equal(growthCheck.ok, false);
    assert.equal(growthCheck.failures.length, 1);
    assert.equal(growthCheck.failures[0].type, "clone_growth");
    assert.equal(growthCheck.failures[0].diff, 5);

    // 5. Clone under failLines does not fail
    rmSync(join(dir, "orig1.mjs"));
    rmSync(join(dir, "orig2.mjs"));
    const shortBlock = Array.from({ length: 12 }, (_, i) => `const shortItem_${i} = ${i};`).join("\n");
    writeFileSync(join(dir, "short1.mjs"), shortBlock);
    writeFileSync(join(dir, "short2.mjs"), shortBlock);

    const shortCheck = checkClones(dir, { thresholds, scope: ["*.mjs"] });
    assert.equal(shortCheck.ok, true, "clones with lines < failLines must not cause failure");
    assert.equal(shortCheck.clones.length, 1);
  });
});

test("escape hatches: defer header marker and clone:allow exempt offenders from failing", () => {
  withTempDir((dir) => {
    const thresholds = { minLines: 10, failLines: 15 };
    const code = Array.from({ length: 20 }, (_, i) => `const exemptItem_${i} = ${i};`).join("\n");

    // 1. defer: in header exempts file
    writeFileSync(join(dir, "deferFile1.mjs"), `// defer: temporary duplicate | ceiling: 20 lines | upgrade: refactor\n${code}\n`);
    writeFileSync(join(dir, "deferFile2.mjs"), `${code}\n`);

    const deferCheck = checkClones(dir, { thresholds, scope: ["*.mjs"] });
    assert.equal(deferCheck.ok, true);
    assert.equal(deferCheck.stats.exempt, 1);

    rmSync(join(dir, "deferFile1.mjs"));
    rmSync(join(dir, "deferFile2.mjs"));

    // 2. clone:allow on line exempts clone
    writeFileSync(join(dir, "allowFile1.mjs"), `// clone:allow\n${code}\n`);
    writeFileSync(join(dir, "allowFile2.mjs"), `${code}\n`);

    const allowCheck = checkClones(dir, { thresholds, scope: ["*.mjs"] });
    assert.equal(allowCheck.ok, true);
    assert.equal(allowCheck.stats.exempt, 1);
  });
});

test("JSON shape: scan and check produce valid JSON structures", () => {
  withTempDir((dir) => {
    const code = Array.from({ length: 12 }, (_, i) => `const jsonTest_${i} = ${i};`).join("\n");
    writeFileSync(join(dir, "j1.mjs"), code);
    writeFileSync(join(dir, "j2.mjs"), code);

    // scan --json
    const scanProc = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", dir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(scanProc.status, 0);
    const scanJson = JSON.parse(scanProc.stdout);
    assert.equal(scanJson.ok, true);
    assert.ok(Array.isArray(scanJson.clones));
    assert.equal(typeof scanJson.coverage, "number");
    assert.equal(typeof scanJson.totalLines, "number");

    // baseline --json
    const baseProc = spawnSync(process.execPath, [CLI_PATH, "baseline", "--root", dir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(baseProc.status, 0);
    const baseJson = JSON.parse(baseProc.stdout);
    assert.equal(baseJson.ok, true);
    assert.equal(typeof baseJson.clones, "number");

    // check --json
    const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", dir, "--json"], {
      encoding: "utf8",
    });
    assert.equal(checkProc.status, 0);
    const checkJson = JSON.parse(checkProc.stdout);
    assert.equal(checkJson.ok, true);
    assert.ok(checkJson.thresholds);
    assert.ok(checkJson.stats);
    assert.ok(Array.isArray(checkJson.failures));
    assert.ok(Array.isArray(checkJson.clones));
    assert.equal(typeof checkJson.coverage, "number");
  });
});

test("CLI execution on repository: check exits 0 with fresh baseline, scan finds known clones", () => {
  // Test scan on repo root
  const scanProc = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", "."], {
    encoding: "utf8",
  });
  assert.equal(scanProc.status, 0);
  assert.ok(
    scanProc.stdout.includes("tools/install-harness.mjs:600") &&
    scanProc.stdout.includes("tools/install-harness.mjs:627"),
    "scan output must list known install-harness.mjs:600/627 clones"
  );
  assert.ok(
    scanProc.stdout.includes("tools/installation/journal.mjs"),
    "scan output must list known journal.mjs clone"
  );

  // Test check on repo root
  const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", "--root", "."], {
    encoding: "utf8",
  });
  assert.equal(checkProc.status, 0, "check must exit 0 on clean baseline");
});
