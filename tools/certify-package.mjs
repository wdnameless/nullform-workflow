#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runSmoke } from "./npm-smoke.mjs";
import { sourceDigest } from "./worktree-snapshot.mjs";
import {
  REPO_ROOT,
  getGitCommit,
  getNpmVersion,
  inspectArchiveContents,
  computeFileDigests,
  assertCleanWorkingTree,
} from "./package-archive.mjs";

export { getGitCommit, getNpmVersion, inspectArchiveContents };

export async function certifyPackage(options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
  const tarballPath = options.tarballPath
    ? resolve(options.tarballPath)
    : join(repoRoot, ".tmp", `nullform-workflow-${readFileSync(join(repoRoot, "VERSION"), "utf8").trim()}.tgz`);
  let isClean = true;
  let dirtyReason = null;
  try {
    assertCleanWorkingTree(repoRoot);
  } catch (err) {
    isClean = false;
    dirtyReason = err.message;
  }
  if (!isClean && !options.allowDirty) {
    throw new Error(`Certification refused: uncommitted working tree modifications (${dirtyReason})`);
  }
  assert.ok(existsSync(tarballPath), `Candidate tarball not found at ${tarballPath}`);
  const fileStat = statSync(tarballPath);
  assert.ok(fileStat.size > 1024, `Candidate tarball must be non-empty, got ${fileStat.size} bytes`);
  const digestsBefore = computeFileDigests(tarballPath);
  const archiveMeta = inspectArchiveContents(tarballPath, null, { repoRoot });
  const repoVersion = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
  const repoPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(archiveMeta.version, repoVersion, `Candidate archive version (${archiveMeta.version}) does not match repo VERSION (${repoVersion})`);
  assert.equal(archiveMeta.pkgJson.name, repoPkg.name, `Candidate archive name (${archiveMeta.pkgJson.name}) does not match repo package name (${repoPkg.name})`);

  const gitCommit = getGitCommit(repoRoot);
  const currentSourceDigest = sourceDigest(repoRoot);
  const npmVersion = getNpmVersion(repoRoot);

  const smokeRes = await runSmoke({
    tarballPath,
    keepTemp: options.keepTemp,
    baseTemp: options.baseTemp,
  });

  assert.equal(smokeRes.status, "success", "npm smoke execution did not succeed");

  // Protect against TOCTOU: verify candidate tarball bytes unchanged after smoke run
  const digestsAfter = computeFileDigests(tarballPath);
  assert.equal(digestsAfter.sha256, digestsBefore.sha256, "Candidate tarball modified during certification (TOCTOU violation)");
  assert.equal(digestsAfter.sha512, digestsBefore.sha512, "Candidate tarball SHA-512 changed after smoke");
  const digests = digestsAfter;
  const certStatus = isClean ? "PASS" : "DIAGNOSTIC_DIRTY";
  const certificate = {
    schemaVersion: 1,
    name: "nullform-workflow",
    version: archiveMeta.version,
    gitCommit,
    sourceDigest: currentSourceDigest,
    workingTreeClean: isClean,
    releaseReady: isClean,
    archive: {
      filename: basename(tarballPath),
      sha256: digests.sha256,
      sha512: digests.sha512,
      size: digests.size,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npm: npmVersion,
    },
    outcomes: smokeRes.outcomes,
    evidence: smokeRes.evidence,
    status: certStatus,
    certifiedAt: new Date().toISOString(),
  };

  if (options.output) {
    const outPath = resolve(options.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(certificate, null, 2) + "\n", "utf8");
  }

  return certificate;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let tarballPath = null;
  let outputPath = null;
  const asJson = process.argv.includes("--json");
  const keepTemp = process.argv.includes("--keep-temp");

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--tarball" && process.argv[i + 1]) {
      tarballPath = process.argv[++i];
    } else if (arg.startsWith("--tarball=")) {
      tarballPath = arg.slice("--tarball=".length);
    } else if (arg === "--output" && process.argv[i + 1]) {
      outputPath = process.argv[++i];
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    }
  }

  certifyPackage({ tarballPath, output: outputPath, keepTemp })
    .then((cert) => {
      if (asJson) {
        console.log(JSON.stringify(cert, null, 2));
      } else {
        console.log(`PACKAGE CERTIFIED: ${cert.name}@${cert.version} (${cert.status})`);
        console.log(`  Archive:    ${cert.archive.filename} (${cert.archive.size} bytes)`);
        console.log(`  SHA256:     ${cert.archive.sha256}`);
        console.log(`  Git Commit: ${cert.gitCommit}`);
        console.log(`  Platform:   ${cert.environment.platform} ${cert.environment.arch} (Node ${cert.environment.node}, npm ${cert.environment.npm})`);
        if (outputPath) console.log(`  Certificate saved to ${outputPath}`);
      }
    })
    .catch((err) => {
      console.error("CERTIFICATION FAILED:", err?.stack || err?.message || err);
      process.exitCode = 1;
    });
}
