import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveHigherVersion } from "../npm-smoke.mjs";
import { inspectArchiveContents, getGitCommit } from "../certify-package.mjs";
import { createArchive } from "../package-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const REQUIRED_FILES = [
  "package.json", "VERSION", "LICENSE", "jev/LICENSE", "README.md", "CONTEXT.md",
  ".code-size.baseline.json", "bin/nullform.mjs", "tools/install-harness.mjs", "tools/harness-config.mjs",
  "tools/installation-state.mjs", "tools/doctor.mjs", "tools/self-update.mjs",
  "tools/workflow.mjs", "tools/verify.mjs", "tools/sync-manifest.json",
  "verify.ps1", "verify.sh",
];

function buildTarballFixture(tempDir, overrides = {}) {
  const stagingDir = join(tempDir, "staging");
  const pkgDir = join(stagingDir, "package");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });

  for (const rel of REQUIRED_FILES) {
    const src = join(REPO_ROOT, rel);
    const dst = join(pkgDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (overrides[rel] !== undefined) {
      writeFileSync(dst, overrides[rel], "utf8");
    } else if (existsSync(src)) {
      writeFileSync(dst, readFileSync(src));
    }
  }

  const version = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim();
  const tarballPath = join(tempDir, `nullform-workflow-${version}.tgz`);
  createArchive(tarballPath, stagingDir, "package");
  return tarballPath;
}

test("derived higher local test upgrade version is never hardcoded 1.2.0", () => {
  const v120 = deriveHigherVersion("1.2.0", 1);
  assert.equal(v120, "1.3.0", "Derived upgrade from 1.2.0 must be 1.3.0");
  assert.notEqual(v120, "1.2.0", "Upgrade version cannot equal candidate 1.2.0");

  const v120Broken = deriveHigherVersion("1.2.0", 2);
  assert.equal(v120Broken, "1.4.0", "Derived second step from 1.2.0 must be 1.4.0");

  const vCustom = deriveHigherVersion("2.5.4", 1);
  assert.equal(vCustom, "2.6.0", "Derived upgrade from 2.5.4 must be 2.6.0");
});

test("git commit extraction returns 40-character hex commit", () => {
  const commit = getGitCommit(REPO_ROOT);
  assert.match(commit, /^[0-9a-f]{40}$/i, "Git commit must be a 40-character SHA-1 hex string");
});

test("inspectArchiveContents succeeds on valid candidate archive matching repository source", () => {
  const tempDir = join(tmpdir(), `test-valid-archive-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarballPath = buildTarballFixture(tempDir);
    const result = inspectArchiveContents(tarballPath, null, { repoRoot: REPO_ROOT });
    assert.ok(result);
    assert.equal(result.pkgJson.name, "nullform-workflow");
    assert.equal(result.version, readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim());
    assert.ok(Array.isArray(result.packedFiles) && result.packedFiles.length >= REQUIRED_FILES.length);
    for (const req of REQUIRED_FILES) {
      assert.ok(result.packedFiles.includes(req), `Expected ${req} in packedFiles`);
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("inspectArchiveContents rejects candidate with same version but altered payload", () => {
  const tempDir = join(tmpdir(), `test-altered-payload-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarballPath = buildTarballFixture(tempDir, {
      "README.md": "Altered malicious readme payload\n",
    });

    assert.throws(
      () => {
        inspectArchiveContents(tarballPath, null, { repoRoot: REPO_ROOT });
      },
      /byte\/hash mismatch with current repository source/
    );
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});
