import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeSourceDigest, computeManifestHash, computeRolePromptHash, computeTestFilesHash, isPositiveOracleVerdict, isNegativeOracleVerdict } from '../review-evidence.mjs';
import { executeProduct } from '../review-native-tools.mjs';
import { cmdCheckCi } from '../workflow.mjs';
import { installHarness } from '../install-harness.mjs';
import { applyManagedSection, getMarkdownAdapter } from '../harness-config.mjs';
import { validateRootPath, validatePathWithinScope } from '../worktree-snapshot.mjs';
import { sanitizeError } from '../installation-state.mjs';
import { checkRelease } from '../self-update.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempDir } from './test-helpers.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../install-harness.mjs', import.meta.url));

// Audit repros already failed against the original implementation.
test('receipt identity ignores text EOL conversion, never binary or real source edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-eol-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init', '-q');
    mkdirSync(join(root, 'tests'), { recursive: true });
    mkdirSync(join(root, 'agent', 'agents'), { recursive: true });
    mkdirSync(join(root, 'openspec', 'changes', 'eol'), { recursive: true });
    writeFileSync(join(root, '.gitattributes'), '* text=auto\n*.bin -text\n');
    const textFiles = ['product.cjs', 'tests/consumer.cjs', 'agent/agents/oracle.md', 'openspec/changes/eol/manifest.md'];
    for (const path of textFiles) writeFileSync(join(root, path), 'first line\nsecond line\n');
    writeFileSync(join(root, 'asset.bin'), Buffer.from('binary\r\nbytes'));
    git('add', '.');
    const identity = () => [computeSourceDigest(root), computeTestFilesHash(root), computeManifestHash(root, 'eol'), computeRolePromptHash(root, 'oracle')];
    const before = identity();
    for (const path of textFiles) writeFileSync(join(root, path), 'first line\r\nsecond line\r\n');
    assert.deepEqual(identity(), before);
    writeFileSync(join(root, 'asset.bin'), Buffer.from('binary\nbytes'));
    assert.notEqual(computeSourceDigest(root), before[0]);
    writeFileSync(join(root, 'asset.bin'), Buffer.from('binary\r\nbytes'));
    writeFileSync(join(root, 'product.cjs'), 'changed line\r\nsecond line\r\n');
    assert.notEqual(computeSourceDigest(root), before[0]);
    writeFileSync(join(root, 'tests', 'consumer.cjs'), 'weakened test\r\n');
    assert.notEqual(computeTestFilesHash(root), before[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oracle prose cannot reverse ACCEPT, but an explicit negative verdict still blocks it', () => {
  for (const explanation of ['No accepted changes were omitted.', 'Never accept unvalidated tokens.', 'Cannot accept connections on closed port.']) {
    const report = `Verdict: ACCEPT\n${explanation}\n`;
    assert.equal(isPositiveOracleVerdict(report), true);
    assert.equal(isNegativeOracleVerdict(report), false);
  }
  for (const verdict of ['Verdict: REJECT boundary checks failed', 'Verdict: NOT ACCEPTED', 'REJECT: boundary checks failed', 'NOT ACCEPTED', '| Verdict | REJECT |']) {
    assert.equal(isNegativeOracleVerdict(`Verdict: ACCEPT\n${verdict}\n`), true);
    assert.equal(isPositiveOracleVerdict(`Verdict: ACCEPT\n${verdict}\n`), false);
  }
});

test('native product runner executes installed npm on Windows without a shell', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'review-npm-'));
  try {
    const result = JSON.parse(executeProduct({ root, productCommand: ['npm', '--version'] }));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('push gate requires reconnaissance for standard changes and refuses heavy changes without acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-push-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'audit', GIT_AUTHOR_EMAIL: 'audit@example.invalid', GIT_COMMITTER_NAME: 'audit', GIT_COMMITTER_EMAIL: 'audit@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    writeFileSync(join(root, 'initial.txt'), 'baseline\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    for (let i = 0; i < 3; i++) writeFileSync(join(root, `source-${i}.js`), 'changed\n');
    git('add', '.'); git('commit', '-qm', 'standard change without evidence');
    assert.equal(cmdCheckCi(root, { push: true, 'base-ref': base }), 1);
    writeFileSync(join(root, 'recon.md'), '# Recon\nFiles touched: source-0.js, source-1.js, source-2.js\nAcceptance check: local product smoke passed.\n');
    git('add', '.'); git('commit', '-qm', 'retain recon');
    assert.equal(cmdCheckCi(root, { push: true, 'base-ref': base }), 0);
    for (let i = 3; i < 10; i++) writeFileSync(join(root, `source-${i}.js`), 'changed\n');
    git('add', '.'); git('commit', '-qm', 'heavy change without acceptance');
    assert.equal(cmdCheckCi(root, { push: true, 'base-ref': base }), 1);
    assert.equal(cmdCheckCi(root, { push: true }), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nested home skill junctions fail preflight before any core copy', (t) => {
  // Adaptive installers no longer bulk-copy into home skills dirs (except OMP/Hermes single skill).
  // The junction-escape guard is preserved on the Hermes native skill path, the one adaptive home-skills write.
  const temp = mkdtempSync(join(tmpdir(), 'home-skill-escape-'));
  const root = join(temp, 'root'), home = join(temp, 'home'), outside = join(temp, 'outside');
  const hostHome = join(home, 'hermes-host');
  const skill = join(hostHome, 'skills', 'nullform-workflow');
  const link = join(skill, 'scripts');
  let linked = false;
  try {
    mkdirSync(skill, { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, 'core.py'), 'HUMAN_EXTERNAL_ASSET\n');
    try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
    assert.throws(() => installHarness({ harness: 'hermes', root, userHome: home, hostHome }), /Preflight failed|escapes/);
    assert.equal(readFileSync(join(outside, 'core.py'), 'utf8'), 'HUMAN_EXTERNAL_ASSET\n');
    assert.equal(existsSync(join(root, 'VERSION')), false);
  } finally { if (linked) unlinkSync(link); rmSync(temp, { recursive: true, force: true }); }
});

test('explicit roots below a system directory alias use canonical confinement', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'root-alias-'));
  const real = join(temp, 'real'), alias = join(temp, 'alias'), outside = join(temp, 'outside');
  let linked = false, escaped = false;
  try {
    mkdirSync(real); mkdirSync(outside);
    try { symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
    const root = join(alias, 'root');
    assert.equal(validateRootPath(root), root);
    assert.equal(validatePathWithinScope(join(root, 'tools', 'workflow.mjs'), root), true);
    mkdirSync(join(real, 'root'));
    assert.equal(validateRootPath(root), root);
    symlinkSync(outside, join(root, 'tools'), process.platform === 'win32' ? 'junction' : 'dir'); escaped = true;
    assert.equal(validatePathWithinScope(join(root, 'tools', 'workflow.mjs'), root), false);
    assert.throws(() => validateRootPath(alias), /symlink\/junction/);
  } finally {
    if (escaped) unlinkSync(join(alias, 'root', 'tools'));
    if (linked) unlinkSync(alias);
    rmSync(temp, { recursive: true, force: true });
  }
});

test('error redaction covers quoted JSON secrets and malformed credential URLs', () => {
  const canary = 'AUDIT_SYNTHETIC_PASSWORD';
  for (const error of [`Invalid JSON: {"password":"${canary}"}`, `Invalid registry: https://user:${canary} with spaces@registry.invalid/`]) {
    assert.equal(sanitizeError(error).includes(canary), false);
  }
});

test('legacy migration replaces exact owned adapters but preserves inserted human instructions', () => {
  const legacy = getMarkdownAdapter('old/root', 'Claude Code NULLFORM WORKFLOW Adapter');
  const migrated = applyManagedSection(legacy + 'KEEP tail\n', 'NEW MANAGED');
  assert.equal(migrated.includes('old/root'), false);
  assert.ok(migrated.includes('KEEP tail'));
  const modified = legacy.replace('\n\n', '\n\nKEEP human policy\n');
  const retained = applyManagedSection(modified + 'KEEP tail\n', 'NEW MANAGED');
  assert.ok(retained.includes('KEEP human policy'));
  assert.ok(retained.includes('KEEP tail'));
  assert.ok(retained.includes('NEW MANAGED'));
});

test('native registry metadata has a hard deadline and never reports a killed process as success', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-deadline-'));
  try {
    const cli = join(root, 'blocked-npm.mjs');
    writeFileSync(cli, 'setInterval(() => {}, 1000);\n');
    const result = await checkRelease({ root, currentVersion: '1.1.0', npmCliJs: cli, timeoutMs: 200, registry: 'http://127.0.0.1:9' });
    assert.equal(result.status, 'setup');
    assert.equal(result.offline, true);
    assert.equal(result.latest, null);
    assert.match(result.error, /ETIMEDOUT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("consumer regression: preflight no-partial-writes on escaped junction destination", () => {
  const temp = createTempDir("preflight-no-partial-");
  const tempRoot = join(temp, "root");
  const tempHome = join(temp, "home");
  const outsideDir = join(temp, "outside");
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(tempHome, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const outsideWorkflow = join(outsideDir, "workflow.mjs");
  writeFileSync(outsideWorkflow, "// ORIGINAL OUTSIDE CONTENT\n", "utf8");

  const junctionTools = join(tempRoot, "tools");
  try {
    symlinkSync(outsideDir, junctionTools, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    if (err.code === "EPERM") return;
    throw err;
  }

  try {
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--harness", "claude", "--root", tempRoot, "--user-home", tempHome, "--json"],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "Installer must fail when destination tools directory is an escaped junction");
    assert.match(res.stderr, /Preflight failed: destination path .* escapes declared root/i);

    assert.equal(readFileSync(outsideWorkflow, "utf8"), "// ORIGINAL OUTSIDE CONTENT\n", "Outside workflow.mjs must not be overwritten");
    assert.equal(existsSync(join(outsideDir, "harness-config.mjs")), false, "Outside harness-config.mjs must not be created");
    assert.equal(existsSync(join(tempRoot, "CLAUDE.md")), false, "No adapter files written to target root on preflight failure");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("consumer regression: preflight rejects escaped root junction and file symlink (Windows conditional)", () => {
  const temp = createTempDir("preflight-escapes-");
  const tempHome = join(temp, "home");
  const outsideDir = join(temp, "outside-root");
  mkdirSync(tempHome, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // 1. Root junction escape
  const linkRoot = join(temp, "link-root");
  let junctionOk = false;
  try {
    symlinkSync(outsideDir, linkRoot, process.platform === "win32" ? "junction" : "dir");
    junctionOk = true;
  } catch (err) {
    if (err.code !== "EPERM") throw err;
  }

  if (junctionOk) {
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--harness", "claude", "--root", linkRoot, "--user-home", tempHome, "--json"],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "Installer must fail when root itself is an escaped symlink/junction");
    assert.match(res.stderr, /Preflight failed: root path .* escapes declared root or is a symlink\/junction/i);
    assert.equal(existsSync(join(outsideDir, "CLAUDE.md")), false, "No writes to outside directory via root junction");
  }

  // 2. File symlink escape
  const normalRoot = join(temp, "normal-root");
  mkdirSync(normalRoot, { recursive: true });
  const outsideFile = join(temp, "outside-claude.md");
  writeFileSync(outsideFile, "# OUTSIDE UNTOUCHED\n", "utf8");
  const targetClaude = join(normalRoot, "CLAUDE.md");
  let fileLinkOk = false;
  try {
    symlinkSync(outsideFile, targetClaude, "file");
    fileLinkOk = true;
  } catch (err) {
    if (err.code !== "EPERM") throw err;
  }

  if (fileLinkOk) {
    const resFile = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--harness", "claude", "--root", normalRoot, "--user-home", tempHome, "--json"],
      { encoding: "utf8" }
    );
    assert.notEqual(resFile.status, 0, "Installer must fail when CLAUDE.md is a symlink pointing outside declared root");
    assert.match(resFile.stderr, /Preflight failed: destination path .* escapes declared root/i);
    assert.equal(readFileSync(outsideFile, "utf8"), "# OUTSIDE UNTOUCHED\n", "Outside file target must not be overwritten");
  }

  rmSync(temp, { recursive: true, force: true });
});

test("consumer regression: applyManagedSection preserves human prefix and tail on unknown ownership input and maintains managed marker idempotence", () => {
  const legacyUnknownInput = [
    "KEEP operator instructions",
    "Полный свод законов и протокол оркестратора: old/root/agent/AGENTS.md",
    "- Возвратный контракт (≤25 строк): STATUS | FILES | TESTS было->стало | CONCERNS.",
    "KEEP tail",
  ].join("\n");

  const newAdapter = "## 1. Запуск задачи\nTest adapter body\n";
  const output = applyManagedSection(legacyUnknownInput, newAdapter);

  assert.ok(output.includes("KEEP operator instructions"), "Human prefix must be preserved");
  assert.ok(output.startsWith("KEEP operator instructions"), "Human prefix must remain at start of document");
  assert.ok(output.includes("KEEP tail"), "Human tail must be preserved");
  assert.ok(output.includes("<!-- BEGIN NULLFORM WORKFLOW -->"), "Managed start marker must be appended");
  assert.ok(output.includes("<!-- END NULLFORM WORKFLOW -->"), "Managed end marker must be appended");
  assert.ok(output.includes("Test adapter body"), "New adapter body must be inside managed block");

  const output2 = applyManagedSection(output, "## 1. Updated task\nUpdated body\n");
  assert.ok(output2.startsWith("KEEP operator instructions"), "Prefix preserved on second run");
  assert.ok(output2.includes("KEEP tail"), "Tail preserved on second run");
  assert.ok(output2.includes("Updated body"), "Managed section updated on second run");
  assert.equal((output2.match(/<!-- BEGIN NULLFORM WORKFLOW -->/g) || []).length, 1, "Delimiters must be exactly 1");
  assert.equal((output2.match(/<!-- END NULLFORM WORKFLOW -->/g) || []).length, 1, "Delimiters must be exactly 1");
});

test("consumer regression: Cursor active root registry preserves edited scripts, binaries, and unowned files across upgrades with lock/disabled support", async () => {
  const tempRoot = createTempDir("cursor-reg-root-");
  const tempHome = createTempDir("cursor-reg-home-");
  try {
    const res1 = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "cursor", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(res1.status, 0, `Cursor initial install failed: ${res1.stderr}`);
    const plan1 = JSON.parse(res1.stdout);

    const rootSkills = join(tempRoot, "skills");
    const corePy = join(rootSkills, "ui-ux-pro-max", "scripts", "core.py");
    const validatePy = join(rootSkills, "ui-ux-pro-max", "scripts", "validate_data.py");
    const fontAsset = join(rootSkills, "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf");

    assert.ok(existsSync(corePy), "core.py must exist in root/skills");
    assert.ok(existsSync(validatePy), "validate_data.py must exist in root/skills");
    assert.ok(existsSync(fontAsset), "Binary font must exist in root/skills");
    assert.ok(plan1.managedFiles[corePy], "Managed hash recorded for root/skills core.py");
    assert.ok(plan1.managedFiles[validatePy], "Managed hash recorded for root/skills validate_data.py");
    assert.ok(plan1.managedFiles[fontAsset], "Managed hash recorded for root/skills binary font");

    const originalCoreHash = plan1.managedFiles[corePy];

    const editedCoreContent = "# User custom edited core.py for Cursor\n";
    writeFileSync(corePy, editedCoreContent, "utf8");

    const unownedFile = join(rootSkills, "ui-ux-pro-max", "scripts", "unowned_script.py");
    writeFileSync(unownedFile, "# User unowned script\n", "utf8");

    writeFileSync(join(tempRoot, ".skill-lock.json"), JSON.stringify({ skills: { "biblicism-extractor": { version: "1.0.0" } } }), "utf8");
    const lockedSkillMd = join(rootSkills, "biblicism-extractor", "SKILL.md");
    if (existsSync(lockedSkillMd)) rmSync(lockedSkillMd, { force: true });

    writeFileSync(join(tempRoot, ".skills-disabled.json"), JSON.stringify({ disabled: ["web-search"] }), "utf8");

    const { installHarness: installV2 } = await import(
      pathToFileURL(join(tempRoot, "tools", "install-harness.mjs")).href
    );
    const plan2 = installV2({
      harness: "cursor",
      root: tempRoot,
      userHome: tempHome,
      managedFiles: plan1.managedFiles,
    });

    assert.equal(readFileSync(corePy, "utf8"), editedCoreContent, "Edited core.py must be preserved across reinstall");
    assert.equal(plan2.managedFiles[corePy], originalCoreHash, "Edited core.py hash must be retained in plan.managedFiles");
    assert.equal(readFileSync(unownedFile, "utf8"), "# User unowned script\n", "Unowned user script must be preserved");
    assert.equal(existsSync(lockedSkillMd), false, "Locked skill must be skipped by installer");
    assert.ok(plan2.managedFiles[fontAsset], "Binary asset ownership hash propagated");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
