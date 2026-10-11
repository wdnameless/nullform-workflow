#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceDigest } from "./worktree-snapshot.mjs";
import { validateReviewEvidence, loadReviewEvidence, isPositiveOracleVerdict, isNegativeOracleVerdict } from "./review-evidence.mjs";
import { sanitizeError } from "./installation-state.mjs";
import {
  REPO_ROOT,
  ALL_8_HARNESSES,
  REQUIRED_MATRIX_CELLS,
  computeFileDigests,
  resolveNpmInvocation,
  inspectArchiveContents,
  getGitCommit,
  loadCertificates,
  assertCleanWorkingTree,
} from "./package-archive.mjs";

export { REQUIRED_MATRIX_CELLS, loadCertificates };
export function checkNpmAuth(root = REPO_ROOT, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  if (options.userConfig) {
    env.npm_config_userconfig = resolve(options.userConfig);
    env.NPM_CONFIG_USERCONFIG = resolve(options.userConfig);
  }

  // Trusted GitHub Actions OIDC context evaluation
  const isGitHubActions = Boolean(env.GITHUB_ACTIONS);
  const trustedRepo = env.GITHUB_REPOSITORY === "wdnameless/nullform-workflow";
  const trustedRef = env.GITHUB_REF === "refs/heads/master" || env.GITHUB_REF === "refs/heads/main" || /^refs\/tags\/v\d/.test(env.GITHUB_REF || "");
  const hasOidcTokens = Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  const isOidcContext = isGitHubActions && trustedRepo && trustedRef && hasOidcTokens;

  try {
    const inv = resolveNpmInvocation(env);
    const args = [...inv.prefixArgs];
    if (options.userConfig) {
      args.push("--userconfig", resolve(options.userConfig));
    }
    args.push("whoami");

    const res = spawnSync(inv.command, args, {
      cwd: root,
      encoding: "utf8",
      env,
      shell: inv.shell || false,
      windowsHide: true,
      timeout: 10_000,
    });

    if (res.status === 0 && res.stdout.trim()) {
      return {
        authenticated: true,
        oidcReady: isOidcContext,
        user: res.stdout.trim(),
        mode: "user-credentials",
        isOidc: false,
      };
    }
    const errText = (res.stderr || res.stdout || "").trim();
    return {
      authenticated: false,
      oidcReady: isOidcContext,
      user: null,
      mode: isOidcContext ? "oidc-trusted-publisher" : "none",
      error: errText.includes("ENEEDAUTH") ? "ENEEDAUTH" : (errText || "ENEEDAUTH"),
      isOidc: isOidcContext,
    };
  } catch (err) {
    return {
      authenticated: false,
      oidcReady: isOidcContext,
      user: null,
      mode: isOidcContext ? "oidc-trusted-publisher" : "none",
      error: err?.message || "ERR_AUTH_CHECK",
      isOidc: isOidcContext,
    };
  }
}


export function verifyReleasePreflight(options = {}) {
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
  const blockers = [];
  const warnings = [];

  const rootVersion = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(rootVersion, rootPkg.version, "VERSION must match package.json");

  // Current source digest and commit (fail-closed if missing/unknown)
  let currentCommit = null;
  try {
    currentCommit = getGitCommit(repoRoot);
  } catch (err) {
    blockers.push(`Git commit failure: ${err.message}`);
  }
  const currentSourceDigest = sourceDigest(repoRoot);

  // 1. Tarball integrity and contents
  const tarballPath = options.tarballPath
    ? resolve(options.tarballPath)
    : join(repoRoot, ".tmp", `nullform-workflow-${rootVersion}.tgz`);

  let digests = { sha256: null, sha512: null, size: 0 };
  let archiveMeta = null;
  if (!existsSync(tarballPath)) {
    blockers.push(`Candidate tarball not found at ${tarballPath}. Build candidate once first.`);
  } else {
    digests = computeFileDigests(tarballPath);
    try {
      archiveMeta = inspectArchiveContents(tarballPath);
      if (archiveMeta.version !== rootVersion) {
        blockers.push(`Candidate tarball version (${archiveMeta.version}) does not match repo VERSION (${rootVersion}).`);
      }
    } catch (err) {
      blockers.push(`Candidate tarball inspection failed: ${err.message}`);
    }
  }

  // Supply-chain third-party license notice verification
  const skillsDir = join(repoRoot, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillName = entry.name;
      const skillMd = join(skillsDir, skillName, "SKILL.md");
      if (existsSync(skillMd)) {
        const mdContent = readFileSync(skillMd, "utf8");
        if (mdContent.includes("Complete terms in LICENSE.txt")) {
          const expectedLicense = join(skillsDir, skillName, "LICENSE.txt");
          if (!existsSync(expectedLicense)) {
            blockers.push(`Supply-chain license defect: Skill '${skillName}' declares terms in LICENSE.txt, but LICENSE.txt is missing from source.`);
          }
        }
      }
    }
  }

  // 2. Certification matrix & certificate verification
  const certificates = loadCertificates(options.certificates);
  if (certificates.length === 0) {
    blockers.push("Missing certification certificates. Publication requires verified candidate certificates.");
  } else {
    for (const cert of certificates) {
      const label = cert._sourceFile || cert.name || "certificate";
      if (!cert.archive || !cert.archive.sha256 || !cert.archive.sha512) {
        blockers.push(`Certificate ${label} is missing required archive digests (sha256/sha512).`);
        continue;
      }
      if (cert.archive.sha256 !== digests.sha256) {
        blockers.push(`Certificate ${label} SHA-256 mismatch (tampered or different artifact): expected ${digests.sha256}, got ${cert.archive.sha256}`);
      }
      if (cert.archive.sha512 !== digests.sha512) {
        blockers.push(`Certificate ${label} SHA-512 mismatch.`);
      }
      if (cert.version !== rootVersion) {
        blockers.push(`Certificate ${label} version mismatch (${cert.version} vs ${rootVersion}).`);
      }
      if (!cert.gitCommit || !/^[0-9a-f]{40}$/i.test(cert.gitCommit) || (currentCommit && cert.gitCommit !== currentCommit)) {
        blockers.push(`Certificate ${label} bound to missing or stale git commit (${cert.gitCommit} vs current ${currentCommit}).`);
      }
      if (!cert.sourceDigest || !/^[0-9a-f]{64}$/i.test(cert.sourceDigest) || cert.sourceDigest !== currentSourceDigest) {
        blockers.push(`Certificate ${label} bound to missing or stale source digest (${cert.sourceDigest} vs current ${currentSourceDigest}).`);
      }
      if (cert.status !== "PASS") {
        blockers.push(`Certificate ${label} has non-passing status: ${cert.status}`);
      }
      const env = cert.environment || {};
      if (!env.platform || !env.arch || !env.node || !env.npm || env.npm === "unknown") {
        blockers.push(`Certificate ${label} has incomplete or unknown platform/node/npm environment.`);
      }
      const outcomes = cert.outcomes || {};
      if (
        outcomes.globalInstall !== "passed" ||
        outcomes.doctor !== "passed" ||
        outcomes.boundaries !== "passed" ||
        outcomes.registryUpgrade !== "passed"
      ) {
        blockers.push(`Certificate ${label} missing verified smoke outcomes (install/doctor/boundaries/upgrade).`);
      }
      const harnesses = Array.isArray(outcomes.harnesses) ? outcomes.harnesses : [];
      for (const h of ALL_8_HARNESSES) {
        if (!harnesses.includes(h)) {
          blockers.push(`Certificate ${label} missing verified harness outcome for '${h}'.`);
        }
      }
    }

    // All 6 OS x Node matrix cells are ALWAYS mandatory for release preflight
    if (!options.diagnosticOnly) {
      for (const cell of REQUIRED_MATRIX_CELLS) {
        const found = certificates.find((c) => {
          const env = c.environment || {};
          const nodeVer = env.node || "";
          const major = parseInt(nodeVer.replace(/^v/, ""), 10);
          const archMatch = env.arch === cell.arch || (cell.altArch && env.arch === cell.altArch);
          return env.platform === cell.platform && archMatch && major === cell.nodeMajor && c.status === "PASS";
        });
        if (!found) {
          blockers.push(`Missing passing certificate for required matrix cell: ${cell.platform} (${cell.arch}) Node ${cell.nodeMajor}`);
        }
      }
    }
  }

  // 3. Oracle acceptance evidence: MUST reuse full canonical validateReviewEvidence on current source
  let oracleResult = null;
  const changeId = options.changeId || "portable-product-release";
  const changeDir = join(repoRoot, "openspec", "changes", changeId);

  if (!existsSync(changeDir)) {
    blockers.push(`OpenSpec change directory missing at ${changeDir}. Publication refused.`);
  } else {
    const reviewValidation = validateReviewEvidence({ root: repoRoot, changeId, tier: "T2" });
    if (!reviewValidation.ok) {
      for (const err of reviewValidation.errors) {
        blockers.push(`Independent candidate review/oracle verification failed: ${err}`);
      }
    }

    const evidenceData = loadReviewEvidence(changeDir);
    if (!evidenceData || !Array.isArray(evidenceData.oracles) || evidenceData.oracles.length === 0) {
      blockers.push("Missing independent candidate oracle acceptance in review evidence. Publication refused.");
    } else {
      const hasNegative = evidenceData.oracles.some((o) => isNegativeOracleVerdict(o.verdict || o.detail || ""));
      if (hasNegative) {
        blockers.push("Independent candidate oracle verdict is REJECT in review evidence. Publication refused.");
      }
      const validPositive = evidenceData.oracles.filter((o) =>
        isPositiveOracleVerdict(o.verdict || o.detail || "") &&
        o.sourceDigest === currentSourceDigest &&
        o.exitCode === 0
      );
      if (validPositive.length === 0) {
        blockers.push("No positive independent candidate oracle verdict bound to current source digest. Publication refused.");
      } else {
        oracleResult = {
          valid: reviewValidation.ok,
          verdict: "ACCEPT",
          commit: currentCommit,
          sessions: validPositive.map((o) => o.sessionId),
        };
      }
    }
  }

  // 4. npm Authentication and Bootstrap prerequisite check
  const auth = checkNpmAuth(repoRoot, options);
  if (!auth.authenticated && !auth.oidcReady) {
    blockers.push(`npm authentication absent (${auth.error}). Initial public bootstrap requires user-controlled npm web authentication for unpublished package 'nullform-workflow'.`);
  }

  // Truthful provenance disclosure
  const provenanceStatus = {
    supported: auth.isOidc,
    reason: auth.isOidc
      ? "GitHub Actions OIDC trusted publishing active."
      : "Initial bootstrap of unpublished package requires user web authorization; GitHub Actions OIDC trusted publishing can be configured after bootstrap for subsequent releases.",
    requirement: "Hosted Node 24 with npm >= 11.5.1 and id-token: write permission.",
    docUrl: "https://docs.npmjs.com/trusted-publishers/",
  };

  const ok = blockers.length === 0;

  const result = {
    ok,
    status: ok ? "READY" : "REFUSED",
    blockers,
    warnings,
    candidate: {
      name: "nullform-workflow",
      version: rootVersion,
      tarballPath,
      sha256: digests.sha256,
      sha512: digests.sha512,
      size: digests.size,
      gitCommit: currentCommit,
      sourceDigest: currentSourceDigest,
    },
    certificates: {
      count: certificates.length,
      valid: certificates.length >= 6 && blockers.every((b) => !b.startsWith("Certificate") && !b.startsWith("Missing passing certificate")),
    },
    oracle: oracleResult || { valid: false, verdict: "REFUSED", commit: null },
    auth: {
      authenticated: auth.authenticated,
      oidcReady: auth.oidcReady,
      user: auth.user || null,
      mode: auth.mode || null,
      error: auth.error || null,
      isOidc: auth.isOidc,
      provenanceStatus,
    },
  };

  if (!options.checkOnly && !ok) {
    const errorMsg = `Release preflight checks refused publication:\n${blockers.map((b) => `  - ${b}`).join("\n")}`;
    const err = new Error(errorMsg);
    err.preflightResult = result;
    throw err;
  }

  return result;
}

export function executePublish(options = {}) {
  const preflight = verifyReleasePreflight({ ...options, checkOnly: false });
  assert.equal(preflight.ok, true, "Publication refused by preflight");

  // Protect against TOCTOU: verify candidate tarball bytes unchanged immediately before publish
  const currentDigests = computeFileDigests(preflight.candidate.tarballPath);
  assert.equal(currentDigests.sha256, preflight.candidate.sha256, "Candidate tarball modified immediately before publish (TOCTOU violation)");
  assert.equal(currentDigests.sha512, preflight.candidate.sha512, "Candidate tarball SHA-512 changed immediately before publish");

  const env = { ...process.env, ...(options.env || {}) };
  if (options.userConfig) {
    env.npm_config_userconfig = resolve(options.userConfig);
    env.NPM_CONFIG_USERCONFIG = resolve(options.userConfig);
  }

  const inv = resolveNpmInvocation(env);
  const publishArgs = [...inv.prefixArgs];
  if (options.userConfig) {
    publishArgs.push("--userconfig", resolve(options.userConfig));
  }
  publishArgs.push("publish", preflight.candidate.tarballPath, "--access", "public");
  if (preflight.auth.mode === "oidc-trusted-publisher") {
    publishArgs.push("--provenance");
  }
  const res = spawnSync(inv.command, publishArgs, {
    cwd: options.repoRoot || REPO_ROOT,
    encoding: "utf8",
    env,
    shell: inv.shell || false,
    windowsHide: true,
  });

  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    published: res.status === 0,
    candidate: preflight.candidate,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let tarballPath = null;
  let certsOption = null;
  let userConfigOption = null;
  const checkOnly = process.argv.includes("--check-only");
  const asJson = process.argv.includes("--json");
  const doPublish = process.argv.includes("--publish");
  const diagnosticOnly = process.argv.includes("--diagnostic-only");

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--tarball" && process.argv[i + 1]) {
      tarballPath = process.argv[++i];
    } else if (arg.startsWith("--tarball=")) {
      tarballPath = arg.slice("--tarball=".length);
    } else if ((arg === "--certificates" || arg === "--certs") && process.argv[i + 1]) {
      certsOption = process.argv[++i];
    } else if (arg.startsWith("--certificates=") || arg.startsWith("--certs=")) {
      certsOption = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--userconfig" && process.argv[i + 1]) {
      userConfigOption = process.argv[++i];
    } else if (arg.startsWith("--userconfig=")) {
      userConfigOption = arg.slice("--userconfig=".length);
    }
  }

  try {
    if (doPublish) {
      const pubRes = executePublish({
        tarballPath,
        certificates: certsOption,
        userConfig: userConfigOption,
      });
      if (asJson) {
        console.log(JSON.stringify(pubRes, null, 2));
      } else {
        console.log(`PUBLISH RESULT: exit ${pubRes.status} (published: ${pubRes.published})`);
        if (pubRes.stdout) {
          const outSnippet = sanitizeError(pubRes.stdout).trim();
          if (outSnippet) console.log(`  [stdout] ${outSnippet.slice(-4000)}`);
        }
        if (pubRes.stderr) {
          const errSnippet = sanitizeError(pubRes.stderr).trim();
          if (errSnippet) console.error(`  [stderr] ${errSnippet.slice(-4000)}`);
        }
      }
      if (!pubRes.published) process.exitCode = 1;
    } else {
      const res = verifyReleasePreflight({
        tarballPath,
        certificates: certsOption,
        userConfig: userConfigOption,
        diagnosticOnly,
        checkOnly: true,
      });

      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`RELEASE PREFLIGHT: ${res.status}`);
        if (res.candidate) {
          console.log(`  Package: ${res.candidate.name}@${res.candidate.version}`);
          console.log(`  Tarball: ${res.candidate.tarballPath} (${res.candidate.sha256})`);
          console.log(`  Commit:  ${res.candidate.gitCommit}`);
        }
        console.log(`  Certificates: ${res.certificates?.count || 0} loaded`);
        console.log(`  Oracle Acceptance: ${res.oracle?.verdict || "NONE"}`);
        console.log(`  npm Auth: ${res.auth?.authenticated ? `OK (${res.auth.user}, mode: ${res.auth.mode})` : (res.auth?.oidcReady ? `OIDC READY (${res.auth.mode})` : `MISSING (${res.auth?.error})`)}`);
        if (res.blockers.length > 0) {
          console.log("\nBlockers preventing publication:");
          for (const b of res.blockers) console.log(`  [REFUSE] ${b}`);
        }
      }
      if (!res.ok) process.exitCode = 1;
    }
  } catch (err) {
    console.error("PREFLIGHT ERROR:", err.message);
    process.exitCode = 1;
  }
}
