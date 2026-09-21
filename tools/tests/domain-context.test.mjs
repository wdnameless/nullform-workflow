/**
 * domain-context.test.mjs — тесты для сборщика доменного контекста (domain-context.mjs).
 *
 * Проверяет:
 *   - Работу на временном git-репозитории (git init, фиксация файлов, секции FILES и RECENT COMMITS)
 *   - Корректную генерацию секции NOTES при отсутствии gh (или через флаг --no-gh)
 *   - Поиск по токену домена без учета регистра (case-insensitive) и приоритет src/**
 *   - Ограничение max-files (по умолчанию 15) с пометкой об усечении (truncation note)
 *   - Интеграцию с .codemap/state.json при его наличии
 *   - Проверку обязательного параметра --domain (выход с ошибкой при отсутствии)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import {
  isGitRepo,
  collectDomainFiles,
  collectRecentCommits,
  collectGhIssues,
  collectDecisions,
  collectDomainContext,
  formatRussianOutput,
  parseArgs,
} from "../domain-context.mjs";
function createTempDir() {
  return mkdtempSync(join(tmpdir(), "domain-context-test-"));
}

test("collectDomainFiles: case-insensitive matching, src/** priority, and max-files cap", () => {
  const tmp = createTempDir();
  try {
    // Создаем структуру файлов
    mkdirSync(join(tmp, "src", "billing"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });

    writeFileSync(join(tmp, "docs", "BillingGuide.md"), "# Guide", "utf8");
    writeFileSync(join(tmp, "src", "billing", "invoice.ts"), "export const invoice = 1;", "utf8");
    writeFileSync(join(tmp, "src", "billing", "calculator.ts"), "export const calc = 1;", "utf8");
    writeFileSync(join(tmp, "README.md"), "# Project", "utf8");

    // Ищем домен "billing"
    const res = collectDomainFiles(tmp, "billing", 15);
    assert.equal(res.totalFiles, 3);
    assert.equal(res.truncated, false);

    // Файлы из src/ должны быть в начале списка
    assert.match(res.files[0], /^src\//);
    assert.match(res.files[1], /^src\//);
    assert.equal(res.files[2], "docs/BillingGuide.md");

    // Проверяем усечение при maxFiles = 2
    const resTrunc = collectDomainFiles(tmp, "billing", 2);
    assert.equal(resTrunc.files.length, 2);
    assert.equal(resTrunc.truncated, true);
    assert.ok(resTrunc.notes.some((n) => n.includes("превышен лимит")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test(".codemap/state.json integration: picks up files listed in codemap state", () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, ".codemap"), { recursive: true });
    mkdirSync(join(tmp, "auth"), { recursive: true });
    writeFileSync(join(tmp, "auth", "session.ts"), "export const session = true;", "utf8");

    const codemapState = {
      version: 1,
      files: {
        "auth/session.ts": "hash123",
        "utils/helpers.ts": "hash456",
      },
    };
    writeFileSync(
      join(tmp, ".codemap", "state.json"),
      JSON.stringify(codemapState, null, 2),
      "utf8"
    );

    const res = collectDomainFiles(tmp, "auth", 15);
    assert.ok(res.files.includes("auth/session.ts"));
    assert.ok(res.notes.some((n) => n.includes(".codemap/state.json")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("temp git repo fixture: collects FILES, COMMITS and produces graceful NOTES for gh", () => {
  const tmp = createTempDir();
  try {
    // 1. Инициализируем git репозиторий
    execSync("git init", { cwd: tmp, stdio: "pipe" });
    execSync("git config user.name \"TestRunner\"", { cwd: tmp, stdio: "pipe" });
    execSync("git config user.email \"test@example.com\"", { cwd: tmp, stdio: "pipe" });

    // 2. Создаем структуру и коммиты
    mkdirSync(join(tmp, "src", "payment"), { recursive: true });
    writeFileSync(join(tmp, "src", "payment", "gateway.ts"), "export const pay = () => {};", "utf8");

    execSync("git add .", { cwd: tmp, stdio: "pipe" });
    execSync("git commit -m \"feat(payment): add initial payment gateway\"", {
      cwd: tmp,
      stdio: "pipe",
    });

    writeFileSync(join(tmp, "src", "payment", "webhook.ts"), "export const hook = () => {};", "utf8");
    execSync("git add .", { cwd: tmp, stdio: "pipe" });
    execSync("git commit -m \"feat(payment): add webhook handler\"", {
      cwd: tmp,
      stdio: "pipe",
    });

    assert.equal(isGitRepo(tmp), true);

    // 3. Запускаем collectDomainContext с симуляцией отсутствия gh (--no-gh)
    const result = collectDomainContext({
      root: tmp,
      domain: "payment",
      maxFiles: 15,
      allowGh: false,
    });

    // Проверяем FILES
    assert.equal(result.files.length, 2);
    assert.ok(result.files.includes("src/payment/gateway.ts"));
    assert.ok(result.files.includes("src/payment/webhook.ts"));

    // Проверяем RECENT COMMITS
    assert.equal(result.commits.length, 2);
    assert.match(result.commits[0], /webhook handler/);
    assert.match(result.commits[1], /payment gateway/);

    // Проверяем NOTES (graceful degradation для gh / remote)
    assert.ok(result.notes.some((n) => n.includes("GitHub:")));

    // Проверяем форматирование текстового вывода на русском
    const textOutput = formatRussianOutput(result);
    assert.match(textOutput, /=== FILES ===/);
    assert.match(textOutput, /src\/payment\/gateway\.ts/);
    assert.match(textOutput, /=== RECENT COMMITS ===/);
    assert.match(textOutput, /feat\(payment\)/);
    assert.match(textOutput, /=== ISSUES ===/);
    assert.match(textOutput, /=== NOTES ===/);
    assert.match(textOutput, /GitHub:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("graceful handling when directory is not a git repository", () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, "analytics"), { recursive: true });
    writeFileSync(join(tmp, "analytics", "tracker.ts"), "export const track = 1;", "utf8");

    const result = collectDomainContext({
      root: tmp,
      domain: "analytics",
      maxFiles: 15,
      allowGh: true,
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.commits.length, 0);
    assert.ok(result.notes.some((n) => n.includes("не является git-репозиторием")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("domain parameter validation: throws if domain is missing", () => {
  assert.throws(
    () => {
      collectDomainContext({ root: process.cwd(), domain: "" });
    },
    { message: /Параметр --domain обязателен/ }
  );
});

test("DECISIONS section: finds matching lines in docs/adr and openspec/changes, graceful when empty, capped at 5", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "domain-decisions-test-"));
  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Check empty state
  const emptyRes = collectDecisions(tempDir, "auth", 5);
  assert.deepStrictEqual(emptyRes.decisions, []);

  const emptyCtx = collectDomainContext({ root: tempDir, domain: "auth", allowGh: false });
  assert.deepStrictEqual(emptyCtx.decisions, []);
  const emptyText = formatRussianOutput(emptyCtx);
  assert.match(emptyText, /=== DECISIONS ===\r?\nрешений по домену не найдено/);

  // Create docs/adr/ADR-001.md, ADR-002.md
  const adrDir = join(tempDir, "docs", "adr");
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(join(adrDir, "0001-auth-jwt.md"), "# 1. Auth JWT Decision\nWe use JWT tokens for auth service.\nSecond auth mention.");
  writeFileSync(join(adrDir, "0002-billing.md"), "# 2. Billing\nWe use Stripe.");
  writeFileSync(join(adrDir, "0003-auth-session.md"), "# 3. Session Auth\nFallback session auth mechanism.");

  // Create openspec/changes/feature-auth/{proposal,manifest}.md
  const specAuth = join(tempDir, "openspec", "changes", "feature-auth");
  mkdirSync(specAuth, { recursive: true });
  writeFileSync(join(specAuth, "proposal.md"), "# Proposal: auth migration\nMigrate auth tokens.");
  writeFileSync(join(specAuth, "manifest.md"), "# Manifest: auth\nRequirement R-auth.");

  // Create other files that should be ignored or capped
  writeFileSync(join(specAuth, "other.md"), "# Other doc with auth");
  const specBilling = join(tempDir, "openspec", "changes", "feature-billing");
  mkdirSync(specBilling, { recursive: true });
  writeFileSync(join(specBilling, "proposal.md"), "# Proposal: billing\nIncludes auth integration.");
  writeFileSync(join(specBilling, "manifest.md"), "# Manifest: billing\nTouches auth endpoints.");

  const foundRes = collectDecisions(tempDir, "auth", 5);
  // We have 6 candidate files matching:
  // 0001-auth-jwt.md, 0003-auth-session.md, feature-auth/proposal.md, feature-auth/manifest.md, feature-billing/proposal.md, feature-billing/manifest.md
  // But capped at 5!
  assert.strictEqual(foundRes.decisions.length, 5);
  // Check that first line per file was picked
  assert.strictEqual(foundRes.decisions[0], "docs/adr/0001-auth-jwt.md: # 1. Auth JWT Decision");

  const foundCtx = collectDomainContext({ root: tempDir, domain: "auth", allowGh: false });
  assert.strictEqual(foundCtx.decisions.length, 5);
  const foundText = formatRussianOutput(foundCtx);
  assert.match(foundText, /=== DECISIONS ===\r?\n- docs\/adr\/0001-auth-jwt\.md: # 1\. Auth JWT Decision/);
});

/* ------------------------------------------------- adversarial (hardening-2) */

const CLI = join(process.cwd(), 'tools', 'domain-context.mjs');

test('domain-context CLI: --max-files 0/-1/abc отклоняются (exit 2), а не подменяются на 15', () => {
  const tmp = createTempDir();
  try {
    mkdirSync(join(tmp, 'src', 'billing'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'billing', 'a.js'), '// a\n');

    const bad = [
      [['--max-files', '0'], /--max-files/],
      [['--max-files', '-1'], /--max-files/],
      [['--max-files', 'abc'], /--max-files/],
      [['--max-files'], /--max-files/],
      [['--bogus'], /неизвестный или неполный параметр/],
    ];
    for (const [args, re] of bad) {
      const cli = spawnSync(process.execPath, [CLI, '--domain', 'billing', '--root', tmp, '--no-gh', ...args], {
        encoding: 'utf8',
      });
      assert.equal(cli.status, 2, JSON.stringify(args));
      assert.match(cli.stderr, re, JSON.stringify(args));
    }

    // Контроль: валидный --max-files работает и не усекает молча
    const ok = spawnSync(process.execPath, [CLI, '--domain', 'billing', '--root', tmp, '--no-gh', '--max-files', '1', '--json'], {
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0);
    const data = JSON.parse(ok.stdout);
    assert.equal(data.files.length, 1);
    assert.equal(data.truncated, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
