import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTempDir } from "./test-helpers.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "tools/install-harness.mjs");

test("actual skill asset ownership transition across versions preserves user edits and propagates unchanged scripts and binaries", async () => {
  const tempRoot = createTempDir("harness-asset-transition-root-");
  const tempHome = createTempDir("harness-asset-transition-home-");
  try {
    const res1 = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "opencode", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(res1.status, 0, `Initial install failed: ${res1.stderr}`);
    const plan1 = JSON.parse(res1.stdout);

    const skillsDir = join(tempHome, ".config", "opencode", "skills");
    const pyAsset = join(skillsDir, "ui-ux-pro-max", "scripts", "core.py");
    const userModifiedAsset = join(skillsDir, "ui-ux-pro-max", "scripts", "validate_data.py");
    const binaryAsset = join(skillsDir, "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf");
    const skillMd = join(skillsDir, "ui-ux-pro-max", "SKILL.md");

    assert.ok(existsSync(pyAsset), "Script asset must exist after initial deploy");
    assert.ok(existsSync(userModifiedAsset), "Script asset to be user-modified must exist");
    assert.ok(existsSync(binaryAsset), "Binary font asset must exist after initial deploy");
    assert.ok(existsSync(skillMd), "Markdown skill prompt must exist after initial deploy");

    assert.ok(plan1.managedFiles[pyAsset], "Managed hash must be recorded for .py script");
    assert.ok(plan1.managedFiles[userModifiedAsset], "Managed hash must be recorded for user script");
    assert.ok(plan1.managedFiles[binaryAsset], "Managed hash must be recorded for binary .ttf asset");
    assert.ok(plan1.managedFiles[skillMd], "Managed hash must be recorded for .md prompt");

    const originalPyHash = plan1.managedFiles[pyAsset];
    const originalUserHash = plan1.managedFiles[userModifiedAsset];
    const originalBinaryHash = plan1.managedFiles[binaryAsset];

    const humanCustomNote = "# Human local custom modifications to validate_data.py\n";
    writeFileSync(userModifiedAsset, humanCustomNote, "utf8");

    const unownedFile = join(skillsDir, "ui-ux-pro-max", "scripts", "custom_helper.py");
    writeFileSync(unownedFile, "# Human unowned helper\n", "utf8");

    const newPyContent = "# Upgraded package core.py v2.0.0\n";
    const newValidateContent = "# Upgraded package validate_data.py v2.0.0\n";
    const newBinaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xaa, 0x55]);

    const rootSkillsDir = join(tempRoot, "skills");
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "core.py"), newPyContent, "utf8");
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "validate_data.py"), newValidateContent, "utf8");
    writeFileSync(join(rootSkillsDir, "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf"), newBinaryContent);
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "custom_helper.py"), "# Shipped package helper\n", "utf8");

    const { installHarness: installV2Harness } = await import(
      pathToFileURL(join(tempRoot, "tools", "install-harness.mjs")).href
    );
    const plan2 = installV2Harness({
      harness: "opencode",
      root: tempRoot,
      userHome: tempHome,
      managedFiles: plan1.managedFiles,
    });

    assert.equal(readFileSync(pyAsset, "utf8"), newPyContent, "Unchanged owned .py asset must update from new package");
    assert.notEqual(plan2.managedFiles[pyAsset], originalPyHash, "Managed hash for updated .py asset must change");

    assert.deepEqual(readFileSync(binaryAsset), newBinaryContent, "Unchanged owned binary asset must update from new package");
    assert.notEqual(plan2.managedFiles[binaryAsset], originalBinaryHash, "Managed hash for updated binary asset must change");

    assert.equal(readFileSync(userModifiedAsset, "utf8"), humanCustomNote, "Locally modified user asset must stay untouched");
    assert.equal(plan2.managedFiles[userModifiedAsset], originalUserHash, "Locally modified asset must retain prior hash in managedFiles");

    assert.equal(readFileSync(unownedFile, "utf8"), "# Human unowned helper\n", "Unowned human file must not be overwritten by package");

    const lockDir = join(tempHome, ".agents");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, ".skill-lock.json"), JSON.stringify({ skills: { "ui-ux-pro-max": { version: "1.0.0" } } }), "utf8");
    writeFileSync(join(lockDir, ".skills-disabled.json"), JSON.stringify({ disabled: ["web-search"] }), "utf8");

    const testLockedFile = join(skillsDir, "ui-ux-pro-max", "scripts", "test_core.py");
    if (existsSync(testLockedFile)) rmSync(testLockedFile, { force: true });

    installV2Harness({
      harness: "opencode",
      root: tempRoot,
      userHome: tempHome,
      managedFiles: plan2.managedFiles,
    });
    assert.equal(existsSync(testLockedFile), false, "Locked skill must be skipped by installer");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
