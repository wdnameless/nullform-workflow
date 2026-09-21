/**
 * context-inbox.test.mjs — тесты для инструмента context-inbox.
 *
 * Проверяет:
 *   - Идемпотентность команды init (создание структуры context/ и сохранение существующих файлов)
 *   - Полный цикл request / list / resolve
 *   - Устойчивость к ручному редактированию таблицы REQUESTS.md (пропуск и отчет о поврежденных строках)
 *   - Коды возврата и поведение команды check (со структурными ошибками, в обычном режиме и в режиме --strict)
 *   - Поддержку JSON вывода
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  initContext,
  requestContext,
  listContext,
  resolveContext,
  checkContext,
  parseRequestsTable,
  CATEGORIES,
} from "../context-inbox.mjs";

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "context-inbox-test-"));
}

test("init idempotency: creates context/ structure once and preserves existing files", () => {
  const tmp = createTempDir();
  try {
    // Первый вызов init: создание директорий и файлов
    const res1 = initContext(tmp);
    assert.equal(res1.readmeCreated, true);
    assert.equal(res1.requestsCreated, true);

    const contextDir = join(tmp, "context");
    assert.equal(existsSync(contextDir), true);
    for (const cat of CATEGORIES) {
      assert.equal(existsSync(join(contextDir, cat)), true);
    }
    assert.equal(existsSync(join(contextDir, "README.md")), true);
    assert.equal(existsSync(join(contextDir, "REQUESTS.md")), true);

    // Модифицируем README.md, чтобы убедиться, что повторный init не перезапишет его
    const customReadme = "# Custom User Content";
    writeFileSync(join(contextDir, "README.md"), customReadme, "utf8");

    // Второй вызов init: ничего не должно быть перезаписано
    const res2 = initContext(tmp);
    assert.equal(res2.readmeCreated, false);
    assert.equal(res2.requestsCreated, false);
    assert.equal(readFileSync(join(contextDir, "README.md"), "utf8"), customReadme);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("request, list, and resolve roundtrip", () => {
  const tmp = createTempDir();
  try {
    initContext(tmp);

    // Добавляем первый запрос c1
    const req1 = requestContext({
      root: tmp,
      category: "design",
      need: "Brand palette tokens",
      why: "Theme setup",
      hint: "Figma shared library",
    });
    assert.equal(req1.id, "c1");
    assert.equal(req1.category, "design");
    assert.equal(req1.dropPath, "context/design/");
    assert.equal(req1.status, "open");

    // Добавляем второй запрос c2
    const req2 = requestContext({
      root: tmp,
      category: "architecture",
      need: "Database schema diagram",
      why: "ORM entity migration",
    });
    assert.equal(req2.id, "c2");
    assert.equal(req2.category, "architecture");
    assert.equal(req2.status, "open");

    // Создаем файл в context/design/
    const assetFile = join(tmp, "context", "design", "tokens.json");
    writeFileSync(assetFile, '{"color": "blue"}', "utf8");

    // Проверяем list: два открытых запроса и наличие файла в inventory
    const list1 = listContext(tmp);
    assert.equal(list1.requests.length, 2);
    assert.equal(list1.requests[0].id, "c1");
    assert.equal(list1.requests[1].id, "c2");
    assert.deepEqual(list1.inventory.design, ["tokens.json"]);
    assert.deepEqual(list1.inventory.architecture, []);

    // Разрешаем запрос c1 с привязкой файла
    const resolved = resolveContext({
      root: tmp,
      id: "c1",
      file: "tokens.json",
    });
    assert.equal(resolved.id, "c1");
    assert.equal(resolved.status, "done");
    assert.match(resolved.why, /\[файл: tokens\.json\]/);

    // После resolve в открытых запросах остается только c2
    const list2 = listContext(tmp);
    assert.equal(list2.requests.length, 1);
    assert.equal(list2.requests[0].id, "c2");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("malformed row reporting: skips invalid rows and keeps valid rows", () => {
  const tmp = createTempDir();
  try {
    initContext(tmp);

    // Добавляем валидный запрос c1
    requestContext({
      root: tmp,
      category: "domain",
      need: "Glossary of financial terms",
      why: "Invoice calculation",
    });

    // Портим таблицу REQUESTS.md ручным добавлением некорректных строк
    const requestsPath = join(tmp, "context", "REQUESTS.md");
    const current = readFileSync(requestsPath, "utf8");
    const corrupted =
      current +
      "\n| broken | row | too few columns |\n" +
      "| c2 | product | PRD | invalid status | pending | 2026-09-20 |\n" +
      "| c3 | ops | Helm chart | k8s deploy | open | 2026-09-20 |\n";
    writeFileSync(requestsPath, corrupted, "utf8");

    // Парсер должен обнаружить 2 некорректные строки и оставить c1 и c3
    const parsed = parseRequestsTable(corrupted);
    assert.equal(parsed.malformed.length, 2);
    assert.match(parsed.malformed[0].reason, /Неверное количество колонок/);
    assert.match(parsed.malformed[1].reason, /Недопустимый статус/);

    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].id, "c1");
    assert.equal(parsed.rows[1].id, "c3");

    // listContext возвращает только валидные открытые запросы c1 и c3
    const listed = listContext(tmp);
    assert.equal(listed.requests.length, 2);
    assert.equal(listed.requests[0].id, "c1");
    assert.equal(listed.requests[1].id, "c3");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("check command exit codes: structural validity vs strict mode", () => {
  const tmp = createTempDir();
  try {
    initContext(tmp);

    // 1. Пустой корректный REQUESTS.md -> валиден (code 0) и в обычном, и в strict
    const checkEmpty = checkContext({ root: tmp, strict: false });
    assert.equal(checkEmpty.valid, true);
    assert.equal(checkEmpty.code, 0);
    assert.equal(checkEmpty.openCount, 0);

    const checkEmptyStrict = checkContext({ root: tmp, strict: true });
    assert.equal(checkEmptyStrict.valid, true);
    assert.equal(checkEmptyStrict.code, 0);

    // 2. Добавляем открытый запрос
    requestContext({
      root: tmp,
      category: "other",
      need: "Sample dataset",
    });

    // Обычный check -> code 0 (advisory count)
    const checkOpenNormal = checkContext({ root: tmp, strict: false });
    assert.equal(checkOpenNormal.valid, true);
    assert.equal(checkOpenNormal.code, 0);
    assert.equal(checkOpenNormal.openCount, 1);

    // Строгий check (--strict) -> code 1 (есть открытые запросы)
    const checkOpenStrict = checkContext({ root: tmp, strict: true });
    assert.equal(checkOpenStrict.valid, false);
    assert.equal(checkOpenStrict.code, 1);
    assert.match(checkOpenStrict.errors[0], /--strict/);

    // 3. Структурное повреждение (дубликат ID) -> code 1 даже без --strict
    const requestsPath = join(tmp, "context", "REQUESTS.md");
    const content = readFileSync(requestsPath, "utf8");
    writeFileSync(
      requestsPath,
      content + "\n| c1 | domain | duplicate id | why | open | 2026-09-20 |\n",
      "utf8"
    );

    const checkCorrupted = checkContext({ root: tmp, strict: false });
    assert.equal(checkCorrupted.valid, false);
    assert.equal(checkCorrupted.code, 1);
    assert.match(checkCorrupted.errors[0], /повторяющиеся ID/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- adversarial (hardening-2) */

test('CRLF в REQUESTS.md сохраняется при request и resolve', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-crlf-'));
  try {
    initContext(tmp);
    const requests = join(tmp, 'context', 'REQUESTS.md');
    const header = [
      '# Context Requests',
      '',
      '| ID | Category | Needed | Why | Status | Added |',
      '|---|---|---|---|---|---|',
      '| c1 | domain | first | - | open | 2026-01-01 |',
      '',
    ].join('\r\n');
    writeFileSync(requests, header, 'utf8');

    requestContext({ root: tmp, category: 'domain', need: 'second' });
    let content = readFileSync(requests, 'utf8');
    assert.ok(content.includes('\r\n'), 'request не должен переписывать файл в LF');
    assert.equal(/[^\r]\n/.test(content), false, 'в файле не должно появиться одиночных LF');

    resolveContext({ root: tmp, id: 'c1' });
    content = readFileSync(requests, 'utf8');
    assert.ok(content.includes('\r\n'), 'resolve не должен переписывать файл в LF');
    assert.equal(/[^\r]\n/.test(content), false, 'в файле не должно появиться одиночных LF');
    assert.match(content, /\| c1 \| domain \| first \| - \| done \| 2026-01-01 \|/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: опечатанный или неполный флаг — exit 2, а не молчаливый пропуск', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-flags-'));
  try {
    initContext(tmp);
    const CLI = join(process.cwd(), 'tools', 'context-inbox.mjs');
    const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    const bogus = run(['list', '--root', tmp, '--bogus']);
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /неизвестный флаг --bogus/);

    const missing = run(['resolve', '--root', tmp, '--id']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--id требует значение/);

    const flagAsValue = run(['list', '--root', tmp, '--file', '--json']);
    assert.equal(flagAsValue.status, 2);
    assert.match(flagAsValue.stderr, /--file требует значение/);

    // Контроль: корректные флаги продолжают работать
    const ok = run(['list', '--root', tmp, '--json']);
    assert.equal(ok.status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
