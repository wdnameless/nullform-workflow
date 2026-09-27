/**
 * debt-ledger.test.mjs — тесты для инструмента debt-ledger.
 *
 * Покрывает:
 *   - Извлечение what/ceiling/upgrade
 *   - Отсутствие upgrade → noTrigger
 *   - Строка без comment-prefix не матчится
 *   - Маркер в .md не найден
 *   - node_modules пропущен
 *   - --check exit 1 при no-trigger и exit 0 иначе
 *   - Форма --json
 *   - --write детерминирован (два прогона байт-идентичны)
 *   - Пустой репозиторий → RU-строка «Чисто…»
 *   - --marker override
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MARKER,
  parseMarkerLine,
  scanText,
  scanRepo,
  formatLedger,
  formatMarkdownLedger,
  parseArgs,
  main,
} from "../debt-ledger.mjs";

const CLI_PATH = fileURLToPath(new URL("../debt-ledger.mjs", import.meta.url));
import { createTempDir } from "./test-helpers.mjs";


test("DEFAULT_MARKER is 'defer'", () => {
  assert.equal(DEFAULT_MARKER, "defer");
});

test("parseMarkerLine: extracts what, ceiling, and upgrade with pipe separators", () => {
  const line = "// defer: in-memory cache | ceiling: 1000 items | upgrade: redis when cluster > 1";
  const res = parseMarkerLine(line);
  assert.notEqual(res, null);
  assert.equal(res.what, "in-memory cache");
  assert.equal(res.ceiling, "1000 items");
  assert.equal(res.upgrade, "redis when cluster > 1");
  assert.equal(res.noTrigger, false);
});

test("parseMarkerLine: extracts what, ceiling, and upgrade without pipes", () => {
  const line = "# defer: single-process lock ceiling: 1 node upgrade: etcd on scale";
  const res = parseMarkerLine(line);
  assert.notEqual(res, null);
  assert.equal(res.what, "single-process lock");
  assert.equal(res.ceiling, "1 node");
  assert.equal(res.upgrade, "etcd on scale");
  assert.equal(res.noTrigger, false);
});

test("parseMarkerLine: trims trailing commas and pipes from what and ceiling", () => {
  const res = parseMarkerLine(
    "// defer: global lock, | ceiling: single-writer throughput, | upgrade: sharding"
  );
  assert.equal(res.what, "global lock");
  assert.equal(res.ceiling, "single-writer throughput");
  assert.equal(res.upgrade, "sharding");
  assert.equal(res.noTrigger, false);

  const resNoPipes = parseMarkerLine(
    "// defer: a, ceiling: b, upgrade: c"
  );
  assert.equal(resNoPipes.what, "a");
  assert.equal(resNoPipes.ceiling, "b");
  assert.equal(resNoPipes.upgrade, "c");
  assert.equal(resNoPipes.noTrigger, false);
});

test("parseMarkerLine: missing upgrade results in noTrigger = true", () => {
  const line = "/* defer: linear search in array | ceiling: 50 items */";
  const res = parseMarkerLine(line);
  assert.notEqual(res, null);
  assert.equal(res.what, "linear search in array");
  assert.equal(res.ceiling, "50 items");
  assert.equal(res.upgrade, "");
  assert.equal(res.noTrigger, true);
});

test("parseMarkerLine: only what provided", () => {
  const line = "-- defer: skip auth checks in test environment";
  const res = parseMarkerLine(line);
  assert.notEqual(res, null);
  assert.equal(res.what, "skip auth checks in test environment");
  assert.equal(res.ceiling, "");
  assert.equal(res.upgrade, "");
  assert.equal(res.noTrigger, true);
});

test("parseMarkerLine: all comment prefixes supported", () => {
  const prefixes = [
    "// defer: item1 | upgrade: u1",
    "# defer: item2 | upgrade: u2",
    "-- defer: item3 | upgrade: u3",
    "; defer: item4 | upgrade: u4",
    "/* defer: item5 | upgrade: u5 */",
    " * defer: item6 | upgrade: u6",
    "<!-- defer: item7 | upgrade: u7 -->",
  ];
  for (const p of prefixes) {
    const res = parseMarkerLine(p);
    assert.notEqual(res, null, `Failed for prefix line: ${p}`);
    assert.equal(res.noTrigger, false);
  }
});

test("parseMarkerLine: line without comment prefix does not match", () => {
  const lines = [
    'const x = "defer: do something | upgrade: later";',
    "defer: simple text without comment prefix",
    "function defer() { return 1; }",
  ];
  for (const l of lines) {
    const res = parseMarkerLine(l);
    assert.equal(res, null, `Should not match non-comment: ${l}`);
  }
});

test("parseMarkerLine: prose and grammar examples inside comments are NOT markers", () => {
  const nonMarkerCommentLines = [
    "// Пример: `defer: <what> | ceiling: <limit> | upgrade: <trigger>`",
    " * - debt-no-trigger: defer: marker without upgrade condition",
    "// Note: we can defer: something later",
    "/* see defer: for details */",
    "# check defer: keyword usage",
  ];
  for (const line of nonMarkerCommentLines) {
    const res = parseMarkerLine(line);
    assert.equal(res, null, `Should not match mid-comment prose: ${line}`);
  }
});

test("parseMarkerLine: comment start variations correctly recognized as markers", () => {
  const validJSDocContinuation = " * defer: jsdoc continuation | upgrade: when x";
  const resJSDoc = parseMarkerLine(validJSDocContinuation);
  assert.notEqual(resJSDoc, null);
  assert.equal(resJSDoc.what, "jsdoc continuation");
  assert.equal(resJSDoc.upgrade, "when x");
  assert.equal(resJSDoc.noTrigger, false);

  const validBlock = "/* defer: block form | upgrade: when y */";
  const resBlock = parseMarkerLine(validBlock);
  assert.notEqual(resBlock, null);
  assert.equal(resBlock.what, "block form");
  assert.equal(resBlock.upgrade, "when y");
  assert.equal(resBlock.noTrigger, false);
});

test("scanText: markers in .md files are skipped", () => {
  const mdContent = "# Documentation\n// defer: documentation example | upgrade: never";
  const markersMd = scanText(mdContent, "README.md");
  assert.equal(markersMd.length, 0);

  const markersCode = scanText(mdContent, "src/index.js");
  assert.equal(markersCode.length, 1);
  assert.equal(markersCode[0].file, "src/index.js");
  assert.equal(markersCode[0].line, 2);
  assert.equal(markersCode[0].what, "documentation example");
});

test("scanRepo: ignores node_modules and other ignore dirs", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    const nmDir = join(tmp, "node_modules", "some-pkg");
    const gitDir = join(tmp, ".git");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(nmDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });

    writeFileSync(join(srcDir, "app.js"), "// defer: keep it simple | upgrade: v2\n", "utf8");
    writeFileSync(join(nmDir, "index.js"), "// defer: ignore me | upgrade: v2\n", "utf8");
    writeFileSync(join(gitDir, "hook.sh"), "# defer: ignore git | upgrade: v2\n", "utf8");

    const res = scanRepo(tmp);
    assert.equal(res.total, 1);
    assert.equal(res.markers[0].file, "src/app.js");
    assert.equal(res.byFile["node_modules/some-pkg/index.js"], undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo: empty repository produces clean report", () => {
  const tmp = createTempDir();
  try {
    const res = scanRepo(tmp);
    assert.equal(res.total, 0);
    assert.equal(res.noTrigger, 0);
    const formatted = formatLedger(res);
    assert.match(formatted, /Чисто: отложенных упрощений нет/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo: respects custom marker override", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "custom.ts"),
      "// shortcut: quick hack | ceiling: local dev | upgrade: staging deploy\n// defer: standard | upgrade: u1\n",
      "utf8"
    );

    const resDefault = scanRepo(tmp);
    assert.equal(resDefault.total, 1);
    assert.equal(resDefault.markers[0].what, "standard");

    const resCustom = scanRepo(tmp, { marker: "shortcut" });
    assert.equal(resCustom.total, 1);
    assert.equal(resCustom.markers[0].what, "quick hack");
    assert.equal(resCustom.markers[0].ceiling, "local dev");
    assert.equal(resCustom.markers[0].upgrade, "staging deploy");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--write is deterministic: two runs produce byte-identical output", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "b.js"),
      "// defer: b task | ceiling: 20 | upgrade: up2\n",
      "utf8"
    );
    writeFileSync(
      join(srcDir, "a.js"),
      "// defer: a task | ceiling: 10 | upgrade: up1\n// defer: a task 2\n",
      "utf8"
    );

    const out1 = join(tmp, "LEDGER1.md");
    const out2 = join(tmp, "LEDGER2.md");

    const p1 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--write", out1], { encoding: "utf8" });
    const p2 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--write", out2], { encoding: "utf8" });
    assert.equal(p1.status, 0);
    assert.equal(p2.status, 0);

    const buf1 = readFileSync(out1);
    const buf2 = readFileSync(out2);
    assert.equal(Buffer.compare(buf1, buf2), 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --json output matches expected schema {root, total, noTrigger, byFile}", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "calc.py"),
      "# defer: dummy algo | ceiling: 100 ops | upgrade: bench > 10ms\n# defer: no trigger here\n",
      "utf8"
    );

    const proc = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--json"], {
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    const data = JSON.parse(proc.stdout);
    assert.equal(typeof data.root, "string");
    assert.equal(data.total, 2);
    assert.equal(data.noTrigger, 1);
    assert.equal(Array.isArray(data.byFile["src/calc.py"]), true);
    assert.equal(data.byFile["src/calc.py"].length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --check: exit 1 on noTrigger, exit 0 when all have upgrade", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });

    // Случай 1: есть маркер с upgrade (валидный)
    writeFileSync(
      join(srcDir, "valid.js"),
      "// defer: naive parser | ceiling: 100 tokens | upgrade: ast parser when grammar expands\n",
      "utf8"
    );

    const procValid = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--check"], {
      encoding: "utf8",
    });
    assert.equal(procValid.status, 0);
    assert.match(procValid.stdout, /1 маркеров, 0 без триггера/);

    // Случай 2: добавляем маркер без upgrade (noTrigger)
    writeFileSync(
      join(srcDir, "invalid.js"),
      "// defer: unvalidated input | ceiling: dev only\n",
      "utf8"
    );

    const procInvalid = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--check"], {
      encoding: "utf8",
    });
    assert.equal(procInvalid.status, 1);
    assert.match(procInvalid.stdout, /\[no-trigger\]/);
    assert.match(procInvalid.stdout, /2 маркеров, 1 без триггера/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --marker override via command line flag", () => {
  const tmp = createTempDir();
  try {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "test.go"),
      "// shortcut: fast path | upgrade: when slow\n",
      "utf8"
    );

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "scan", "--root", tmp, "--marker", "shortcut", "--json"],
      { encoding: "utf8" }
    );
    assert.equal(proc.status, 0);
    const data = JSON.parse(proc.stdout);
    assert.equal(data.total, 1);
    assert.equal(data.markers === undefined, true); // JSON carries {root, total, noTrigger, byFile}
    assert.equal(data.byFile["src/test.go"][0].what, "fast path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseArgs: parses various flag combinations", () => {
  const args = parseArgs([
    "scan",
    "--root=/tmp/repo",
    "--json",
    "--check",
    "--write=OUT.md",
    "--marker=custom",
  ]);
  assert.equal(args._[0], "scan");
  assert.equal(args.root, "/tmp/repo");
  assert.equal(args.json, true);
  assert.equal(args.check, true);
  assert.equal(args.write, "OUT.md");
  assert.equal(args.marker, "custom");
});

test("CLI: missing or non-directory --root outputs RU error to stderr and exits with code 2", () => {
  const nonExistent = join(tmpdir(), `non-existent-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // scan without --check
  const p1 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", nonExistent], { encoding: "utf8" });
  assert.equal(p1.status, 2);
  assert.match(p1.stderr, /Каталог не найден:/);

  // scan with --check
  const p2 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", nonExistent, "--check"], { encoding: "utf8" });
  assert.equal(p2.status, 2);
  assert.match(p2.stderr, /Каталог не найден:/);

  // scan with --json
  const p3 = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", nonExistent, "--json"], { encoding: "utf8" });
  assert.equal(p3.status, 2);
  assert.match(p3.stderr, /Каталог не найден:/);
});

test("CLI: --write в каталог завершается кодом 2 и RU-ошибкой без стектрейса", () => {
  const tmp = createTempDir();
  try {
    writeFileSync(join(tmp, "a.js"), "// defer: x | ceiling: 1 | upgrade: 2\n", "utf8");
    const targetDir = join(tmp, "out");
    mkdirSync(targetDir, { recursive: true });

    const p = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--write", targetDir], {
      encoding: "utf8",
    });

    assert.equal(p.status, 2);
    assert.match(p.stderr, /не удалось записать реестр/i);
    assert.doesNotMatch(p.stderr, /at main|node:fs/, `ожидалась чистая ошибка, получено: ${p.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: опечатанный флаг не превращает гейт в ложный зелёный (exit 2)", () => {
  const tmp = createTempDir();
  try {
    writeFileSync(join(tmp, "a.js"), "// TODO: not a defer marker\n", "utf8");

    // `--markr TODO` до фикса молча игнорировался и давал «Чисто» + exit 0
    const typo = spawnSync(process.execPath, [CLI_PATH, "scan", "--check", "--markr", "TODO"], {
      encoding: "utf8",
    });
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /неизвестный флаг --markr/);
    assert.doesNotMatch(typo.stdout, /Чисто/);

    // Контроль: тот же прогон с корректным флагом реально проверяет маркер
    const proper = spawnSync(process.execPath, [CLI_PATH, "scan", "--check", "--marker", "TODO"], {
      encoding: "utf8",
    });
    assert.equal(proper.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: флаг без значения — ошибка (exit 2), а не молчаливый cwd/дефолт", () => {
  const tmp = createTempDir();
  try {
    writeFileSync(join(tmp, "a.js"), "// defer: x\n", "utf8");

    for (const args of [
      ["scan", "--root"],
      ["scan", "--root", tmp, "--marker"],
      ["scan", "--root", tmp, "--write"],
      ["scan", "--root", tmp, "--json=1"],
    ]) {
      const p = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
      assert.equal(p.status, 2, args.join(" "));
      assert.match(p.stderr, /Ошибка:/, args.join(" "));
    }

    // Следующий токен — другой флаг: тоже ошибка, а не «значение --marker»
    const nextFlag = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--marker", "--check"], {
      encoding: "utf8",
    });
    assert.equal(nextFlag.status, 2);
    assert.match(nextFlag.stderr, /--marker требует значение/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --write без пути — ошибка использования (exit 2), а не молчаливый пропуск", () => {
  const tmp = createTempDir();
  try {
    writeFileSync(join(tmp, "a.js"), "// defer: x | ceiling: 1 | upgrade: 2\n", "utf8");

    const p = spawnSync(process.execPath, [CLI_PATH, "scan", "--root", tmp, "--write"], { encoding: "utf8" });

    assert.equal(p.status, 2);
    assert.match(p.stderr, /--write/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
