import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReleasePreflight, executePublish, REQUIRED_MATRIX_CELLS } from "../publish-release.mjs";
import { getGitCommit } from "../certify-package.mjs";
import { sourceDigest } from "../worktree-snapshot.mjs";
import { computeFileDigests, ALL_8_HARNESSES } from "../package-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

function createValidCandidateTarball(baseDir, name = "nullform-workflow", version = "1.2.0") {
  const stagingDir = join(baseDir, "staging");
  const pkgDir = join(stagingDir, "package");
  const binDir = join(pkgDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const pkgJson = {
    name,
    version,
    bin: { nullform: "bin/nullform.mjs" },
    engines: { node: ">=18.19.0" },
    dependencies: {
      json5: "2.2.3",
      "jsonc-parser": "3.3.1",
      yaml: "2.9.1",
    },
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
  writeFileSync(join(pkgDir, "VERSION"), `${version}\n`, "utf8");
  writeFileSync(join(binDir, "nullform.mjs"), "#!/usr/bin/env node\nconsole.log('nullform');\n", "utf8");

  const tarballPath = join(baseDir, `${name}-${version}.tgz`);
  const res = spawnSync("tar", ["-czf", tarballPath, "package"], {
    cwd: stagingDir,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(res.status, 0, `Failed to build test fixture archive: ${res.stderr || res.stdout}`);
  return tarballPath;
}

test("preflight refuses publication when candidate tarball is missing", () => {
  const result = verifyReleasePreflight({
    repoRoot: REPO_ROOT,
    tarballPath: join(tmpdir(), "nonexistent-tarball-1.2.0.tgz"),
    checkOnly: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "REFUSED");
  assert.ok(result.blockers.some((b) => b.includes("Candidate tarball not found")));
});

test("preflight refuses publication when certification certificates are missing", () => {
  const tempDir = join(tmpdir(), `test-preflight-missing-certs-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const result = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [],
      checkOnly: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "REFUSED");
    assert.ok(result.blockers.length > 0);
    assert.ok(result.blockers.some((b) => b.toLowerCase().includes("certificate")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight refuses publication when certificate digest does not match archive (tamper protection)", () => {
  const tempDir = join(tmpdir(), `test-preflight-tamper-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const fakeCert = {
      name: "nullform-workflow",
      version: "1.2.0",
      gitCommit: getGitCommit(REPO_ROOT),
      sourceDigest: sourceDigest(REPO_ROOT),
      archive: {
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        sha512: "0000000000000000000000000000000000000000000000000000000000000000",
      },
      environment: { platform: "linux", arch: "x64", node: "v22.0.0", npm: "10.0.0" },
      outcomes: {
        globalInstall: "passed",
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
        harnesses: ALL_8_HARNESSES,
      },
      status: "PASS",
    };

    const result = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [fakeCert],
      diagnosticOnly: true,
      checkOnly: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "REFUSED");
    assert.ok(result.blockers.some((b) => b.includes("SHA-256 mismatch")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight refuses publication when certificate is bound to a stale git commit or source digest", () => {
  const tempDir = join(tmpdir(), `test-preflight-stale-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const digests = computeFileDigests(tarball);

    // Stale git commit
    const staleCommitCert = {
      name: "nullform-workflow",
      version: "1.2.0",
      gitCommit: "1111111111111111111111111111111111111111",
      sourceDigest: sourceDigest(REPO_ROOT),
      archive: {
        sha256: digests.sha256,
        sha512: digests.sha512,
      },
      environment: { platform: "linux", arch: "x64", node: "v22.0.0", npm: "10.0.0" },
      outcomes: {
        globalInstall: "passed",
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
        harnesses: ALL_8_HARNESSES,
      },
      status: "PASS",
    };

    const res1 = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [staleCommitCert],
      diagnosticOnly: true,
      checkOnly: true,
    });
    assert.equal(res1.ok, false);
    assert.ok(res1.blockers.some((b) => b.includes("stale git commit")));

    // Stale source digest
    const staleSourceCert = {
      name: "nullform-workflow",
      version: "1.2.0",
      gitCommit: getGitCommit(REPO_ROOT),
      sourceDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      archive: {
        sha256: digests.sha256,
        sha512: digests.sha512,
      },
      environment: { platform: "linux", arch: "x64", node: "v22.0.0", npm: "10.0.0" },
      outcomes: {
        globalInstall: "passed",
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
        harnesses: ALL_8_HARNESSES,
      },
      status: "PASS",
    };

    const res2 = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [staleSourceCert],
      diagnosticOnly: true,
      checkOnly: true,
    });
    assert.equal(res2.ok, false);
    assert.ok(res2.blockers.some((b) => b.includes("stale source digest")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight refuses publication when required 6 OS x Node matrix cells are incomplete", () => {
  const tempDir = join(tmpdir(), `test-preflight-cells-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const digests = computeFileDigests(tarball);
    const commit = getGitCommit(REPO_ROOT);
    const source = sourceDigest(REPO_ROOT);

    // Only 1 cell provided (Ubuntu Node 22)
    const singleCert = {
      name: "nullform-workflow",
      version: "1.2.0",
      gitCommit: commit,
      sourceDigest: source,
      archive: { sha256: digests.sha256, sha512: digests.sha512 },
      environment: { platform: "linux", arch: "x64", node: "v22.0.0", npm: "10.0.0" },
      outcomes: {
        globalInstall: "passed",
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
        harnesses: ALL_8_HARNESSES,
      },
      status: "PASS",
    };

    const res = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [singleCert],
      diagnosticOnly: false,
      checkOnly: true,
    });

    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.includes("Missing passing certificate for required matrix cell")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight refuses publication when certificates omit any of the 8 required harnesses", () => {
  const tempDir = join(tmpdir(), `test-preflight-harnesses-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const digests = computeFileDigests(tarball);
    const commit = getGitCommit(REPO_ROOT);
    const source = sourceDigest(REPO_ROOT);

    // Certificate with only 7 harnesses (omitting openhuman)
    const incompleteCert = {
      name: "nullform-workflow",
      version: "1.2.0",
      gitCommit: commit,
      sourceDigest: source,
      archive: { sha256: digests.sha256, sha512: digests.sha512 },
      environment: { platform: "linux", arch: "x64", node: "v22.0.0", npm: "10.0.0" },
      outcomes: {
        globalInstall: "passed",
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
        harnesses: ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes"],
      },
      status: "PASS",
    };

    const res = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      certificates: [incompleteCert],
      diagnosticOnly: true,
      checkOnly: true,
    });

    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.includes("missing verified harness outcome for 'openhuman'")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight refuses publication when canonical review evidence is missing or change is invalid", () => {
  const tempDir = join(tmpdir(), `test-preflight-review-missing-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const tarball = createValidCandidateTarball(tempDir);
    const res = verifyReleasePreflight({
      repoRoot: REPO_ROOT,
      tarballPath: tarball,
      changeId: "nonexistent-change-id",
      checkOnly: true,
    });

    assert.equal(res.ok, false);
    assert.ok(res.blockers.some((b) => b.includes("OpenSpec change directory missing")));
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("preflight checkOnly returns report, while normal mode throws on blockers", () => {
  assert.throws(
    () => {
      verifyReleasePreflight({
        repoRoot: REPO_ROOT,
        tarballPath: join(tmpdir(), "missing.tgz"),
        checkOnly: false,
      });
    },
    /Release preflight checks refused publication/
  );
});

test("executePublish throws and refuses publication when preflight conditions are not met", () => {
  assert.throws(
    () => {
      executePublish({
        repoRoot: REPO_ROOT,
        tarballPath: join(tmpdir(), "missing.tgz"),
      });
    },
    /Release preflight checks refused publication/
  );
});

