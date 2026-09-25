/**
 * tools/tests/sync-prune.test.mjs
 *
 * sync-prune.mjs — выбор кандидатов на очистку harness:
 * 1. кандидатом становится только файл внутри каталога манифеста, которого нет в репозитории
 *    (наличие важнее содержимого: файл с другим телом уже отслеживается репо);
 * 2. обход уходит в подкаталоги, но никогда — в служебные (.prompt-lint/.workflow/.archmap,
 *    node_modules, worktrees) и в сессионные каталоги;
 * 3. конфиги, секреты и базы (*.yml, *.json, *.db, *.key, *.env, …) не становятся
 *    кандидатами, даже если их нет в репозитории;
 * 4. каталоги вне манифеста (skills/, tests/, openspec/) не сканируются;
 * 5. --delete удаляет только перечисленные файлы; без --delete не удаляется ничего.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { findPruneCandidates, deletePruneCandidates } from "../sync-prune.mjs";

const PRUNE_PATH = resolve(import.meta.dirname, "../sync-prune.mjs");
const REPO_ROOT = resolve(import.meta.dirname, "../..");

function writeFiles(root, files) {
  for (const rel of files) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `content of ${rel}\n`, "utf8");
  }
}

/** Файлы, которые есть в обоих деревьях, — не кандидаты. */
const SHARED = [
  "tools/keep.mjs",
  "tools/nested/keep-nested.mjs",
  "agent/AGENTS.md",
  "rules/enterprise-directives.md",
  "core/PORTABLE.md",
  "templates/design/DESIGN.md",
  "paseo/setup-paseo.ps1",
];

/** Файлы только в харнессе: кандидаты и запрещённые области. */
const HARNESS_ONLY = [
  // кандидаты
  "tools/extra.mjs",
  "tools/notes.txt",
  "tools/nested/deep/chunk.js",
  "agent/agent-local.md",
  "rules/scratch.md",
  "templates/local/extra.md",
  "paseo/old-setup.ps1",
  // служебные каталоги — вне области
  "tools/node_modules/pkg/index.js",
  "tools/worktrees/wt/old.mjs",
  "tools/.hidden/secret.mjs",
  "tools/.tmp.mjs",
  "tools/.prompt-lint/baseline.json",
  "agent/.workflow/state.json",
  "agent/.archmap/graph.json",
  // конфиги, секреты, сессии — вне области
  "agent/config.yml",
  "agent/models.yml",
  "agent/mcp.json",
  "agent/plugins.skipped",
  "agent/models.db",
  "agent/api.key",
  "secrets.env" /* нет: вне каталогов манифеста */,
  "agent/sessions/session.jsonl",
  "agent/cache/hit.txt",
  // Локальные файлы в каталогах манифеста — НЕ сироты. Prune трогает только те
  // расширения, которые репозиторий реально поставляет (SHIPPED_SUFFIX): .txt в
  // tools/ — это заметка пользователя, и удаление её необратимо.
  "tools/notes.txt",
  // вне каталогов манифеста
  "skills/mock-skill/SKILL.md",
  "tests/portability.ps1",
  "openspec/changes/x/proposal.md",
];

const EXPECTED = [
  "agent/agent-local.md",
  "paseo/old-setup.ps1",
  "rules/scratch.md",
  "templates/local/extra.md",
  "tools/extra.mjs",
  "tools/nested/deep/chunk.js",
];

function makeFixture(baseDir) {
  const harness = join(baseDir, "harness");
  const repo = join(baseDir, "repo");
  writeFiles(harness, [...SHARED, ...HARNESS_ONLY]);
  writeFiles(repo, SHARED);
  return { harness, repo };
}

test("findPruneCandidates: только файлы каталогов манифеста, отсутствующие в репозитории", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-scan-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    assert.deepEqual(findPruneCandidates({ harness, repo }), EXPECTED);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findPruneCandidates: содержимое не сравнивается — отслеживаемый путь не кандидат", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-content-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    // Файл есть в репо, но с другим телом: это дрейф (забота sync -Check), не мусор.
    writeFileSync(join(harness, "tools/keep.mjs"), "different body\n", "utf8");
    assert.ok(!findPruneCandidates({ harness, repo }).includes("tools/keep.mjs"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findPruneCandidates: отсутствующий каталог манифеста не ломает обход", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-missing-"));
  try {
    const harness = join(tmp, "harness");
    const repo = join(tmp, "repo");
    mkdirSync(join(repo), { recursive: true });
    writeFiles(harness, ["tools/only.mjs"]);
    assert.deepEqual(findPruneCandidates({ harness, repo }), ["tools/only.mjs"]);
    // Каталогов core/, rules/, paseo/ в харнессе нет — ошибок быть не должно.
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findPruneCandidates: требует harness и repo", () => {
  assert.throws(() => findPruneCandidates({ repo: REPO_ROOT }), /harness is required/);
  assert.throws(() => findPruneCandidates({ harness: REPO_ROOT }), /repo is required/);
});

test("findPruneCandidates: несуществующий harness/repo — ошибка, а не «0 кандидатов»", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-missing-path-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    const missing = join(tmp, "nope");

    assert.throws(() => findPruneCandidates({ harness: missing, repo }), /--harness не найден/);
    assert.throws(() => findPruneCandidates({ harness, repo: missing }), /--repo не найден/);

    // Файл вместо каталога — та же ошибка, другой текст.
    const filePath = join(tmp, "a-file.txt");
    writeFileSync(filePath, "not a dir\n", "utf8");
    assert.throws(() => findPruneCandidates({ harness: filePath, repo }), /--harness не каталог/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: несуществующий --harness/--repo — RU-сообщение и exit 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-cli-badpath-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    const missing = join(tmp, "nope");

    const badHarness = spawnSync(
      process.execPath,
      [PRUNE_PATH, "--harness", missing, "--repo", repo],
      { encoding: "utf8" }
    );
    assert.equal(badHarness.status, 2);
    assert.match(badHarness.stderr, /--harness не найден/);
    assert.ok(!badHarness.stdout.includes("candidate"), "typo must not be reported as clean");

    const badRepo = spawnSync(
      process.execPath,
      [PRUNE_PATH, "--harness", harness, "--repo", missing, "--delete"],
      { encoding: "utf8" }
    );
    assert.equal(badRepo.status, 2);
    assert.match(badRepo.stderr, /--repo не найден/);
    assert.ok(existsSync(join(harness, "tools/extra.mjs")), "--delete must not run on a bad repo path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deletePruneCandidates: удаляет файлы, каталоги и каталог-кандидат не трогает", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-delete-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    const res = deletePruneCandidates(harness, ["tools/extra.mjs", "tools/nested"]);

    assert.deepEqual(res.deleted, ["tools/extra.mjs"]);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /not a regular file/);
    assert.ok(!existsSync(join(harness, "tools/extra.mjs")), "candidate must be gone");
    assert.ok(existsSync(join(harness, "tools/nested/deep/chunk.js")), "directory must survive");
    assert.ok(existsSync(join(repo, "tools/keep.mjs")), "repo untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: по умолчанию сухой прогон — файлы на месте, exit 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-cli-dry-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    const res = spawnSync(
      process.execPath,
      [PRUNE_PATH, "--harness", harness, "--repo", repo, "--json"],
      { encoding: "utf8" }
    );

    assert.equal(res.status, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.deepEqual(json.candidates, EXPECTED);
    assert.deepEqual(json.deleted, []);
    assert.ok(existsSync(join(harness, "tools/extra.mjs")), "dry run must not delete");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: --delete удаляет кандидатов и сообщает число", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prune-cli-delete-"));
  try {
    const { harness, repo } = makeFixture(tmp);
    const res = spawnSync(
      process.execPath,
      [PRUNE_PATH, "--harness", harness, "--repo", repo, "--delete"],
      { encoding: "utf8" }
    );

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`prune: ${EXPECTED.length} candidate\\(s\\)`));
    assert.match(res.stdout, new RegExp(`prune: deleted ${EXPECTED.length} file\\(s\\)`));
    for (const rel of EXPECTED) {
      assert.ok(!existsSync(join(harness, rel)), `${rel} must be deleted`);
    }
    assert.ok(existsSync(join(harness, "tools/keep.mjs")), "tracked file must survive");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: без --harness/--repo — код 2 и ничего не сканируется", () => {
  const res = spawnSync(process.execPath, [PRUNE_PATH, "--harness", "."], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /нужны --harness/);
});
