import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deriveHigherVersion } from "../npm-smoke.mjs";
import { inspectArchiveContents, getGitCommit } from "../certify-package.mjs";
import { createArchive, safeExtractArchive } from "../package-archive.mjs";

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
  for (const [rel, content] of Object.entries(overrides)) {
    if (REQUIRED_FILES.includes(rel)) continue;
    const dst = join(pkgDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content, "utf8");
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
    assert.equal(result.pkgJson.name, "nullform-workflow");
    assert.equal(result.version, readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim());
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

const UNICODE_MEMBER = "skills/project-test-safety/prompts/00-диагностика.md";

test("inspectArchiveContents counts an owned Unicode member and succeeds when it matches repository source", () => {
  const tempDir = join(tmpdir(), `test-unicode-owned-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarballPath = buildTarballFixture(tempDir, { [UNICODE_MEMBER]: readFileSync(join(REPO_ROOT, UNICODE_MEMBER), "utf8") });
    const result = inspectArchiveContents(tarballPath, null, { repoRoot: REPO_ROOT });
    assert.ok(result.packedFiles.includes(UNICODE_MEMBER), `Owned Unicode member must appear in packedFiles: ${UNICODE_MEMBER}`);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("inspectArchiveContents rejects a same-version changed owned Unicode payload", () => {
  const tempDir = join(tmpdir(), `test-unicode-changed-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarballPath = buildTarballFixture(tempDir, { [UNICODE_MEMBER]: "# tampered unicode payload\n" });
    assert.throws(
      () => inspectArchiveContents(tarballPath, null, { repoRoot: REPO_ROOT }),
      /byte\/hash mismatch with current repository source/
    );
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("inspectArchiveContents rejects an extra unowned Unicode member", () => {
  const tempDir = join(tmpdir(), `test-unicode-unowned-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const unowned = "skills/project-test-safety/prompts/неизвестный-файл.md";
    const tarballPath = buildTarballFixture(tempDir, { [unowned]: "# unowned unicode payload\n" });
    assert.throws(
      () => inspectArchiveContents(tarballPath, null, { repoRoot: REPO_ROOT }),
      /Unowned extra file in archive not present in repository/
    );
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("inspectArchiveContents reports the exact extracted member identity and its real content", () => {
  const tempDir = join(tmpdir(), `test-identity-${Date.now()}`);
  const referenceDir = join(tempDir, "reference");
  const inspectBase = join(tempDir, "inspect-base");
  mkdirSync(tempDir, { recursive: true });
  try {
    const originalName = "caf\u00e9.md".normalize("NFD");
    const content = "# identity payload\n";
    const tarballPath = buildTarballFixture(tempDir, { [`skills/normalization/${originalName}`]: content });

    // Independently extract to an owned reference tree and read the member name the
    // platform actually produced (NFD on preserving platforms, NFC on normalizing ones).
    safeExtractArchive(tarballPath, referenceDir, { requirePackagePrefix: true });
    const referencePkgDir = join(referenceDir, "package");
    const referenceNames = readdirSync(join(referencePkgDir, "skills", "normalization"));
    assert.equal(referenceNames.length, 1, "Reference tree must hold exactly the one normalization member");
    const actualName = referenceNames[0];
    const actualMember = `skills/normalization/${actualName}`;

    mkdirSync(inspectBase, { recursive: true });
    const result = inspectArchiveContents(tarballPath, inspectBase, { repoRoot: referencePkgDir });

    assert.ok(result.packedFiles.includes(actualMember), `Inventory must report the exact extracted member: ${JSON.stringify(actualMember)}`);
    assert.equal(readFileSync(join(result.pkgDir, actualMember), "utf8"), content, "Returned member must yield the real archived content");

    if (actualName !== originalName) {
      // The platform rewrote the name during packing/extraction: the original staging
      // identity is a genuinely different path, so ownership must refuse, never equate.
      assert.throws(
        () => inspectArchiveContents(tarballPath, join(tempDir, "inspect-base-strict"), { repoRoot: join(tempDir, "staging", "package") }),
        /Unowned extra file in archive not present in repository/
      );
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("createArchive preserves member layout without prepending parent source directory paths", () => {
  const tempDir = join(tmpdir(), `test-layout-${Date.now()}`);
  const nestedSource = join(tempDir, "deep", "nested", "source");
  const pkgDir = join(nestedSource, "package");
  const outDir = join(tempDir, "out");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  try {
    writeFileSync(join(pkgDir, "sample.txt"), "hello world\n", "utf8");
    const tarballPath = join(outDir, "test-fixture.tgz");
    createArchive(tarballPath, nestedSource, "package");

    const unpackDir = join(tempDir, "unpack");
    const entries = safeExtractArchive(tarballPath, unpackDir, { requirePackagePrefix: false });
    const fileEntries = entries.filter((e) => !e.endsWith("/") && e !== "package");
    assert.deepEqual(fileEntries, ["package/sample.txt"]);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});
