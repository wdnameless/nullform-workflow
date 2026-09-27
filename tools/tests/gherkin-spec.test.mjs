/**
 * tools/tests/gherkin-spec.test.mjs — Тесты для парсера и линтера BDD/Gherkin спецификаций.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseGherkin,
  lintGherkin,
  extractGherkinFromMarkdown,
  parseArgs,
} from "../gherkin-spec.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../gherkin-spec.mjs", import.meta.url)));
import { createTempDir } from "./test-helpers.mjs";


test("parseGherkin: парсит Feature, Scenario, теги и шаги", () => {
  const gherkinText = `
    @smoke @auth
    Feature: User Authentication
      Users must be able to log in with valid credentials.

      @happy-path
      Scenario: Successful login
        Given user has an active account
        When user enters valid password
        Then user is redirected to dashboard
        And user sees welcome message
  `;

  const parsed = parseGherkin(gherkinText);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.features.length, 1);

  const feature = parsed.features[0];
  assert.equal(feature.title, "User Authentication");
  assert.ok(feature.tags.includes("@smoke"));
  assert.ok(feature.tags.includes("@auth"));
  assert.equal(feature.scenarios.length, 1);

  const scenario = feature.scenarios[0];
  assert.equal(scenario.title, "Successful login");
  assert.ok(scenario.tags.includes("@happy-path"));
  assert.equal(scenario.steps.length, 4);
  assert.equal(scenario.steps[0].keyword, "given");
  assert.equal(scenario.steps[1].keyword, "when");
  assert.equal(scenario.steps[2].keyword, "then");
  assert.equal(scenario.steps[3].keyword, "and");
});

test("lintGherkin: выявляет отсутствие Then и висячие And/But", () => {
  // 1. Отсутствие Then
  const noThen = parseGherkin(`
    Feature: Incomplete
      Scenario: No outcome
        Given something exists
        When action happens
  `);
  const lint1 = lintGherkin(noThen);
  assert.equal(lint1.valid, false);
  assert.ok(lint1.errors.some((e) => e.includes("отсутствует ожидаемый результат (Then)")));

  // 2. Висячий And в начале
  const danglingAnd = parseGherkin(`
    Feature: Broken Steps
      Scenario: Starts with And
        And unexpected continuation
        Then something
  `);
  const lint2 = lintGherkin(danglingAnd);
  assert.equal(lint2.valid, false);
  assert.ok(lint2.errors.some((e) => e.includes("не может начинаться с And/But")));
});

test("extractGherkinFromMarkdown: находит блоки gherkin/feature/bdd в Markdown", () => {
  const md = `
# Specification for Task 42

Here is the specification in BDD format:

\`\`\`gherkin
Feature: Cache Validation
  Scenario: Cold boot cache miss
    Given empty cache
    When first prompt arrives
    Then provider computes full prompt
\`\`\`

And another BDD scenario:

\`\`\`bdd
Feature: Cache Warm Hit
  Scenario: Warm hit
    Given primed cache
    When same prompt arrives
    Then cache read equals total tokens
\`\`\`
  `;

  const blocks = extractGherkinFromMarkdown(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lang, "gherkin");
  assert.ok(blocks[0].content.includes("Feature: Cache Validation"));
  assert.equal(blocks[1].lang, "bdd");
  assert.ok(blocks[1].content.includes("Feature: Cache Warm Hit"));
});

test("parseArgs: разбирает команды, пути и флаги", () => {
  const args = parseArgs(["lint", "specs/", "--strict", "--json"]);
  assert.equal(args.command, "lint");
  assert.ok(args.paths.includes("specs/"));
  assert.equal(args.strict, true);
  assert.equal(args.json, true);
  assert.equal(args.errors.length, 0);

  const unknown = parseArgs(["--bad-option"]);
  assert.ok(unknown.errors.some((e) => e.includes("неизвестный параметр")));
});

test("CLI: lint валидного .feature файла возвращает exit code 0", () => {
  const tmp = createTempDir();
  try {
    const featPath = join(tmp, "login.feature");
    writeFileSync(
      featPath,
      `
Feature: Login
  Scenario: Valid login
    Given registered user
    When submits credentials
    Then granted access
      `.trim(),
      "utf8"
    );

    const proc = spawnSync(process.execPath, [CLI_PATH, "lint", featPath, "--json"], {
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.totalFiles, 1);
    assert.equal(parsed.results[0].valid, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: extract извлекает блоки из Markdown", () => {
  const tmp = createTempDir();
  try {
    const mdPath = join(tmp, "tasks.md");
    writeFileSync(
      mdPath,
      `
# Task Plan
\`\`\`gherkin
Feature: Deployment
  Scenario: Clean install
    Given fresh PC
    When install.ps1 runs
    Then exit code is 0
\`\`\`
      `.trim(),
      "utf8"
    );

    const proc = spawnSync(process.execPath, [CLI_PATH, "extract", mdPath, "--json"], {
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].blocks.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
