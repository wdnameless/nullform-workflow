import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createTempDir } from "./test-helpers.mjs";
import { installPack, getPackReceiptPath } from "../pack-install.mjs";
import { runPackCommand } from "../../bin/nullform.mjs";

function createPack({
  name = "test-pack",
  version = "1.0.0",
  targets = ["claude"],
  files = { "worker.mjs": "export function work() { return 123; }\n" },
  tests = "tests/verify.mjs",
  testsContent = "process.exit(0);\n",
  doctor = undefined,
} = {}) {
  const dir = createTempDir("pack-src-");
  const modulesDir = join(dir, "modules");
  mkdirSync(modulesDir, { recursive: true });

  const manifestFiles = [];
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(modulesDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    const sha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    manifestFiles.push({ path: relPath, sha256 });
  }

  if (tests) {
    const fullTest = join(dir, tests);
    mkdirSync(dirname(fullTest), { recursive: true });
    writeFileSync(fullTest, testsContent, "utf8");
  }

  const manifest = {
    name,
    version,
    targets,
    files: manifestFiles,
    tests,
    ...(doctor ? { doctor } : {}),
  };

  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest };
}

test("installPack: happy-path install copies files, applies adapter, and writes receipt", async () => {
  const { dir: packDir } = createPack({
    name: "happy-pack",
    version: "1.0.0",
    targets: ["claude"],
    files: {
      "worker.mjs": "export const worked = true;\n",
      "config/app.json": "{\"mode\": \"test\"}\n",
    },
    tests: "tests/check.mjs",
    testsContent: "import assert from 'node:assert'; assert.ok(true);\n",
  });
  const targetRoot = createTempDir("target-root-");
  const userHome = createTempDir("user-home-");

  try {
    const receipt = await installPack({
      packDir,
      harness: "claude",
      root: targetRoot,
      userHome,
    });

    assert.equal(receipt.status, "installed");
    assert.equal(receipt.name, "happy-pack");
    assert.equal(receipt.version, "1.0.0");
    assert.equal(receipt.harness, "claude");

    // Allow-listed files copied
    assert.equal(readFileSync(join(targetRoot, "worker.mjs"), "utf8"), "export const worked = true;\n");
    assert.equal(readFileSync(join(targetRoot, "config", "app.json"), "utf8"), "{\"mode\": \"test\"}\n");

    // Claude adapter was applied
    assert.ok(existsSync(join(targetRoot, "CLAUDE.md")));

    // Receipt was recorded
    const receiptPath = getPackReceiptPath(targetRoot, "happy-pack");
    assert.ok(existsSync(receiptPath));
    const saved = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(saved.name, "happy-pack");
    assert.equal(saved.version, "1.0.0");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: idempotent reinstall reports already installed and writes nothing", async () => {
  const { dir: packDir } = createPack({
    name: "idem-pack",
    version: "2.1.0",
    targets: ["opencode"],
    files: { "pkg.mjs": "export const x = 1;\n" },
  });
  const targetRoot = createTempDir("target-idem-");
  const userHome = createTempDir("user-home-idem-");

  try {
    const first = await installPack({
      packDir,
      harness: "opencode",
      root: targetRoot,
      userHome,
    });
    assert.equal(first.status, "installed");

    const second = await installPack({
      packDir,
      harness: "opencode",
      root: targetRoot,
      userHome,
    });
    assert.equal(second.status, "already installed");
    assert.equal(second.name, "idem-pack");
    assert.equal(second.version, "2.1.0");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: unlisted-file refusal before any write", async () => {
  const { dir: packDir } = createPack({
    name: "unlisted-pack",
    targets: ["claude"],
    files: { "safe.mjs": "ok\n" },
  });
  const targetRoot = createTempDir("target-unlisted-");
  const userHome = createTempDir("user-home-unlisted-");

  try {
    writeFileSync(join(packDir, "modules", "backdoor.mjs"), "evil();\n", "utf8");

    await assert.rejects(
      () => installPack({ packDir, harness: "claude", root: targetRoot, userHome }),
      /workflow pack: unlisted file in modules\/: backdoor\.mjs/
    );

    // Target root should have had nothing written
    assert.equal(existsSync(join(targetRoot, "safe.mjs")), false);
    assert.equal(existsSync(join(targetRoot, "CLAUDE.md")), false);
    assert.equal(existsSync(join(targetRoot, ".nullform")), false);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: corrupt manifest refusal before any write", async () => {
  const packDir = createTempDir("pack-corrupt-");
  const targetRoot = createTempDir("target-corrupt-");
  const userHome = createTempDir("user-home-corrupt-");

  try {
    writeFileSync(join(packDir, "pack.json"), "{ invalid", "utf8");
    await assert.rejects(
      () => installPack({ packDir, harness: "claude", root: targetRoot, userHome }),
      /workflow pack: invalid pack\.json/
    );
    assert.equal(existsSync(join(targetRoot, ".nullform")), false);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: failing pack test blocks completion and rolls back writes", async () => {
  const { dir: packDir } = createPack({
    name: "failing-test-pack",
    targets: ["claude"],
    files: { "mod.mjs": "export const a = 1;\n" },
    tests: "tests/fail.mjs",
    testsContent: "console.error('Test check exploded'); process.exit(1);\n",
  });
  const targetRoot = createTempDir("target-failing-");
  const userHome = createTempDir("user-home-failing-");

  try {
    await assert.rejects(
      () => installPack({ packDir, harness: "claude", root: targetRoot, userHome }),
      /workflow pack: post-install test failed with exit code 1/
    );

    // Verify completion was NOT marked and changes were rolled back
    assert.equal(existsSync(join(targetRoot, "mod.mjs")), false);
    const receiptPath = getPackReceiptPath(targetRoot, "failing-test-pack");
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: junction-escape equivalent path is refused before write", async () => {
  const targetRoot = createTempDir("target-junction-");
  const outsideDir = createTempDir("outside-dir-");
  const userHome = createTempDir("user-home-junction-");

  // Create a subfolder in targetRoot that symlinks outside
  const linkPath = join(targetRoot, "junction-link");
  try {
    symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // If symlinks not permitted in unprivileged environment, continue to test path traversal
  }

  const { dir: packDir } = createPack({
    name: "escape-pack",
    targets: ["claude"],
    files: { "junction-link/escape.txt": "escaped\n" },
  });

  try {
    if (existsSync(linkPath)) {
      await assert.rejects(
        () => installPack({ packDir, harness: "claude", root: targetRoot, userHome }),
        /workflow pack: file path .* resolves outside target root/
      );
      assert.equal(existsSync(join(outsideDir, "escape.txt")), false);
    }
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: unknown harness and unsupported harness are refused", async () => {
  const { dir: packDir } = createPack({
    name: "target-test-pack",
    targets: ["claude"],
    files: { "a.mjs": "1;\n" },
  });
  const targetRoot = createTempDir("target-harness-");
  const userHome = createTempDir("user-home-harness-");

  try {
    await assert.rejects(
      () => installPack({ packDir, harness: "unknown-harness", root: targetRoot, userHome }),
      /workflow pack: unknown harness 'unknown-harness'/
    );

    await assert.rejects(
      () => installPack({ packDir, harness: "codex", root: targetRoot, userHome }),
      /workflow pack: harness 'codex' not supported by pack 'target-test-pack'/
    );
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("installPack: dryRun previews installation without modifying target root", async () => {
  const { dir: packDir } = createPack({
    name: "dry-pack",
    targets: ["claude"],
    files: { "dry.mjs": "content;\n" },
  });
  const targetRoot = createTempDir("target-dry-");
  const userHome = createTempDir("user-home-dry-");

  try {
    const res = await installPack({
      packDir,
      harness: "claude",
      root: targetRoot,
      userHome,
      dryRun: true,
    });
    assert.equal(res.dryRun, true);
    assert.equal(res.status, "dry-run");
    assert.equal(existsSync(join(targetRoot, "dry.mjs")), false);
    assert.equal(existsSync(join(targetRoot, ".nullform")), false);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("runPackCommand: CLI pack install wires correctly with JSON and text output", async () => {
  const { dir: packDir } = createPack({
    name: "cli-pack",
    version: "1.0.0",
    targets: ["claude"],
    files: { "cli.mjs": "console.log(1);\n" },
  });
  const targetRoot = createTempDir("target-cli-");
  const userHome = createTempDir("user-home-cli-");

  let outText = "";
  let errText = "";
  const stdout = { write: (s) => { outText += s; } };
  const stderr = { write: (s) => { errText += s; } };

  try {
    // Missing arguments return exit code 2
    const codeMissing = await runPackCommand(["install"], { stdout, stderr });
    assert.equal(codeMissing, 2);

    // Valid install with --json returns exit code 0
    outText = "";
    errText = "";
    const code = await runPackCommand([
      "install",
      packDir,
      "--harness",
      "claude",
      "--root",
      targetRoot,
      "--user-home",
      userHome,
      "--json",
    ], { stdout, stderr });

    assert.equal(code, 0, `Command failed: ${errText}`);
    const receipt = JSON.parse(outText);
    assert.equal(receipt.name, "cli-pack");
    assert.equal(receipt.status, "installed");

    // Second run is idempotent
    outText = "";
    const code2 = await runPackCommand([
      "install",
      packDir,
      "--harness",
      "claude",
      "--root",
      targetRoot,
      "--user-home",
      userHome,
    ], { stdout, stderr });
    assert.equal(code2, 0);
    assert.match(outText, /already installed/i);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});
