#!/usr/bin/env node
/**
 * tools/workflow-ci.mjs — CI-гейты workflow (check-ci): вынесены из workflow.mjs 1:1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { checkCodeSize, loadConfig as loadCodeSizeConfig } from "./code-size.mjs";
import { scanRepo } from "./debt-ledger.mjs";
import {
  NEGATIVE_VERDICT_RE,
  isPositiveOracleVerdict,
  isNegativeOracleVerdict,
  isAcceptanceArtifactFilename,
  validateReviewEvidence,
  isSupersededOracleArtifact,
} from "./review/evidence.mjs";
import { validateReviewEvidenceAtRevision } from "./review/evidence-history.mjs";
import { isPathInsideRoot, isRealPathInsideRoot, isStructuralExcludedPath } from "./worktree-snapshot.mjs";
import { isWorkflowPath, isInsideGitRepo, getPorcelainEntries, gitIgnoredPaths, lastTouchingRevision } from "./workflow-shared.mjs";

export function resolveChangedFilesAgainstBase(root, baseRef) {
  try {
    let diffOut = "";
    try {
      diffOut = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
      });
    } catch {
      diffOut = execFileSync("git", ["diff", "--name-only", `${baseRef}..HEAD`], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
      });
    }
    const changedFiles = diffOut.split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !isStructuralExcludedPath(f));
    return { ok: true, changedFiles };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
function getBaseDiffFiles(root, baseRef) {
  if (!baseRef) return null;
  const res = resolveChangedFilesAgainstBase(root, baseRef);
  if (!res.ok) {
    console.error(`workflow check-ci: failed to resolve base ref '${baseRef}': ${res.error}`);
    return null;
  }
  return res.changedFiles;
}

function validateCheckCiT1(root, flags, baseRef) {
  const reconFlag = flags.recon ? String(flags.recon).trim() : null;
  if (!reconFlag) {
    console.error("workflow check-ci: tier T1 requires --recon <path> pointing to committed reconnaissance evidence.");
    return 1;
  }
  if (!isPathInsideRoot(root, reconFlag) || !isRealPathInsideRoot(root, reconFlag)) {
    console.error(`workflow check-ci: recon path '${reconFlag}' must be inside project root.`);
    return 1;
  }
  const fullRecon = join(root, reconFlag);
  if (!existsSync(fullRecon) || !statSync(fullRecon).isFile()) {
    console.error(`workflow check-ci: recon file '${reconFlag}' does not exist on disk.`);
    return 1;
  }
  const reconBody = readFileSync(fullRecon, "utf8").trim();
  if (reconBody.length === 0) {
    console.error(`workflow check-ci: recon file '${reconFlag}' is empty.`);
    return 1;
  }
  if (!/(touched files|files touched|files:)/i.test(reconBody) || !/(acceptance check|acceptance criteria|smoke|verified|acceptance:)/i.test(reconBody)) {
    console.error(`workflow check-ci: recon file '${reconFlag}' must name touched files and acceptance check.`);
    return 1;
  }

  if (baseRef) {
    const changedFiles = getBaseDiffFiles(root, baseRef);
    if (!changedFiles) return 1;
    if (changedFiles.length < 3) {
      console.error(`workflow check-ci: tier T1 requires 3–9 changed files; detected ${changedFiles.length} (<=2 belongs in T0).`);
      return 1;
    }
    if (changedFiles.length > 9) {
      console.error(`workflow check-ci: tier T1 allows at most 9 changed files; detected ${changedFiles.length}.\n  upgrade this PR to T2/T3, or reduce scope to fit T1 (3–9 files).`);
      return 1;
    }
  }
  console.log("workflow check-ci: tier T1 passed (lean tier).");
  return 0;
}

export function validateCheckCiGit(root, oracleRelForCommit, baseRef, relChangeScope = null) {
  const hasGit = isInsideGitRepo(root);
  if (!hasGit) {
    console.log("workflow check-ci: non-git repository; skipping git verification.");
    return 0;
  }

  const porcelain = getPorcelainEntries(root);
  if (!porcelain) {
    console.error("workflow check-ci: git error while verifying worktree status: git status failed");
    return 1;
  }
  if (porcelain.length > 0) {
    console.error(`workflow check-ci: uncommitted changes detected in worktree after acceptance:\n  ${porcelain.map((e) => `${e.code} ${e.rel}`).slice(0, 5).join("\n  ")}`);
    return 1;
  }

  try {
    let oracleCommit = "";
    const relNorm = String(oracleRelForCommit || "").replace(/\\/g, "/");
    try {
      oracleCommit = execFileSync("git", ["rev-list", "-1", "HEAD", "--", relNorm], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
    } catch {
      oracleCommit = (execFileSync("git", ["log", "-1", "--oneline", "--", relNorm], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 }).trim().split(/\s+/)[0]) || "";
    }

    if (oracleCommit) {
      const commitFilesRaw = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--relative", oracleCommit], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
      }).trim();
      if (commitFilesRaw) {
        const nonOracle = commitFilesRaw.split("\n")
          .map((f) => f.trim().replace(/\\/g, "/"))
          .filter((f) => f && !isWorkflowPath(f) && !isAcceptanceArtifactFilename(f));
        if (nonOracle.length > 0) {
          console.error(`workflow check-ci: oracle acceptance commit (${oracleCommit.slice(0, 8)}) contains non-oracle changes (mixed commit):\n  ${nonOracle.slice(0, 5).join("\n  ")}`);
          return 1;
        }
      }

      const postOracleDiff = execFileSync("git", ["diff", "--name-only", "--relative", `${oracleCommit}..HEAD`], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000
      }).trim();
      if (postOracleDiff) {
        let changedFiles = postOracleDiff.split("\n")
          .map((f) => f.trim().replace(/\\/g, "/"))
          .filter((f) => f && !isWorkflowPath(f));
        // Only files belonging to THIS change can taint its own acceptance. A later
        // commit touching unrelated changes or sources is a different change's
        // business; comparing against HEAD made archived acceptances permanently red
        // exactly like the evidence hashes did (W01/R03).
        const relScope = String(relChangeScope || "").replace(/\\/g, "/");
        if (relScope) changedFiles = changedFiles.filter((f) => f === relScope || f.startsWith(`${relScope}/`));
        if (baseRef) {
          const res = resolveChangedFilesAgainstBase(root, baseRef);
          if (res.ok) changedFiles = changedFiles.filter((f) => new Set(res.changedFiles).has(f));
        }
        if (changedFiles.length > 0) {
          console.error(`workflow check-ci: files modified in commits after oracle acceptance (${oracleCommit.slice(0, 8)}):\n  ${changedFiles.slice(0, 5).join("\n  ")}`);
          return 1;
        }
      }
    }
  } catch (err) {
    console.error(`workflow check-ci: git error while verifying commit history: ${err.message}`);
    return 1;
  }
  return 0;
}

export function validateCheckCiOracleFiles(root, relChangeDir) {
  const changeDir = join(root, relChangeDir);
  // Consider every retained receipt: any unsuperseded explicit REJECT blocks.
  const oracleEntries = readdirSync(changeDir).filter(isAcceptanceArtifactFilename);
  if (oracleEntries.length === 0) {
    console.error(`workflow check-ci: missing oracle evidence in '${changeDir}' or resolves outside project root.`);
    return { ok: false };
  }
  let hasPositive = false;
  let oracleRelForCommit = null;
  for (const entry of oracleEntries) {
    const oraclePath = join(changeDir, entry);
    const relOracle = join(relChangeDir, entry);
    if (!isRealPathInsideRoot(root, relOracle) || !statSync(oraclePath).isFile()) {
      console.error(`workflow check-ci: oracle file '${entry}' in '${changeDir}' resolves outside project root or is not a file.`);
      return { ok: false };
    }
    const oracleBody = readFileSync(oraclePath, "utf8");
    if ((isNegativeOracleVerdict(oracleBody) || NEGATIVE_VERDICT_RE.test(oracleBody)) && !isSupersededOracleArtifact(changeDir, oraclePath)) {
      console.error(`workflow check-ci: oracle evidence in '${entry}' states an explicit REJECT verdict.`);
      return { ok: false };
    }
    if (isPositiveOracleVerdict(oracleBody)) {
      hasPositive = true;
      if (!oracleRelForCommit) oracleRelForCommit = relOracle;
    }
  }
  if (!hasPositive && !existsSync(join(changeDir, "review-evidence.json"))) {
    console.error(`workflow check-ci: oracle evidence in '${changeDir}' must state an explicit anchored positive ACCEPT verdict.`);
    return { ok: false };
  }
  return { ok: true, oracleRelForCommit };
}

export function checkPushEvidence(root, flags) {
  const baseRef = flags['base-ref'] || flags.baseRef || flags['base_ref'];
  if (!baseRef || /^0+$/.test(baseRef)) {
    console.error('workflow check-ci: push requires a resolvable previous commit in --base-ref; use a reviewed PR to initialize the branch.');
    return 1;
  }
  const changedFiles = getBaseDiffFiles(root, baseRef);
  if (!changedFiles) return 1;
  const changes = [...new Set(changedFiles.map(path => /^openspec\/changes\/([A-Za-z0-9_-]+)\//.exec(path)?.[1]).filter(Boolean))]
    // `archive/` is a retired-change container, not a change: it owns no manifest.
    .filter((change) => change !== "archive");
  if (changes.length) {
    for (const change of changes) {
      const tier = existsSync(join(root, 'openspec', 'changes', change, 'worktrees.md')) ? 'T3' : 'T2';
      // Judge each change by the tree it was accepted against: the last commit that
      // touched its directory. Validating archived changes against HEAD makes every
      // later, unrelated commit redden the push forever (see W01 / R03).
      const revision = lastTouchingRevision(root, change, baseRef) || baseRef;
      if (cmdCheckCi(root, { tier, change, 'base-ref': baseRef, 'evidence-revision': revision }) !== 0) return 1;
    }
    return 0;
  }
  if (changedFiles.length > 9) {
    console.error(`workflow check-ci: push changes ${changedFiles.length} files; committed T2/T3 acceptance evidence is required.`);
    return 1;
  }
  const tier = changedFiles.length <= 2 ? 'T0' : 'T1';
  const recon = ['.workflow-recon.md', 'recon.md', ...changedFiles.filter(path => /(?:^|\/)(?:recon|\.workflow-recon)\.md$/i.test(path))].find(path => existsSync(join(root, path)));
  return cmdCheckCi(root, { tier, recon, 'base-ref': baseRef });
}

export function checkQualityGates(root = ".", options = {}) {
  const absRoot = resolve(root);
  const gates = [];
  const allViolators = [];

  // Gate 1: code-size
  try {
    const baseConfig = loadCodeSizeConfig(absRoot);
    const sizeConfig = {
      maxLines: options["max-lines"] ? Number(options["max-lines"]) : (options.maxLines ?? baseConfig.maxLines),
      maxFunctionLines: options["max-function-lines"] ? Number(options["max-function-lines"]) : (options.maxFunctionLines ?? baseConfig.maxFunctionLines),
      scope: options.scope || (existsSync(join(absRoot, "tools")) ? baseConfig.scope : ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", ...baseConfig.scope]),
    };
    const sizeRes = checkCodeSize(absRoot, { config: sizeConfig });
    if (!sizeRes.ok && sizeRes.failures.length > 0) {
      const violators = sizeRes.failures.map((f) => `${f.file} (${f.message})`);
      gates.push({
        name: "code-size",
        status: "fail",
        path: [...new Set(sizeRes.failures.map((f) => f.file))].join(", "),
        violators,
        detail: `${sizeRes.failures.length} threshold violations`,
      });
      allViolators.push(...violators);
    } else if (sizeRes.stats.fileOffenders > 0 || sizeRes.stats.functionOffenders > 0) {
      gates.push({
        name: "code-size",
        status: "warn",
        path: sizeRes.files[0]?.file || ".",
        violators: [],
        detail: `${sizeRes.stats.exempt} exempt, ${sizeRes.stats.baselined} baselined`,
      });
    } else {
      gates.push({
        name: "code-size",
        status: "pass",
        path: ".",
        violators: [],
        detail: `all ${sizeRes.stats.scannedFiles} files within limits`,
      });
    }
  } catch (err) {
    gates.push({
      name: "code-size",
      status: "warn",
      path: ".",
      violators: [],
      detail: `code-size scan skipped: ${err.message}`,
    });
  }

  // Gate 2: debt-ledger
  try {
    const debtRes = scanRepo(absRoot, { marker: options.marker || "defer" });
    const maxUntriggered = options["max-untriggered-debt"] !== undefined
      ? Number(options["max-untriggered-debt"])
      : (options.maxUntriggeredDebt ?? 0);
    const maxTotalDebt = options["max-debt"] !== undefined
      ? Number(options["max-debt"])
      : (options.maxDebt ?? Infinity);
    const strictDebt = Boolean(options["strict-debt"] || options.strictDebt);

    const untriggeredMarkers = debtRes.markers.filter((m) => m.noTrigger);
    const hasViolations = untriggeredMarkers.length > maxUntriggered ||
      debtRes.total > maxTotalDebt ||
      (strictDebt && debtRes.total > 0);

    if (hasViolations) {
      const offending = (strictDebt || debtRes.total > maxTotalDebt)
        ? debtRes.markers
        : untriggeredMarkers;
      const violators = offending.map((m) => `${m.file}:${m.line} (defer: ${m.what || "untriggered debt"})`);
      gates.push({
        name: "debt-ledger",
        status: "fail",
        path: [...new Set(offending.map((m) => m.file))].join(", "),
        violators,
        detail: `${offending.length} unmanaged/untriggered debt marker(s)`,
      });
      allViolators.push(...violators);
    } else if (debtRes.total > 0) {
      gates.push({
        name: "debt-ledger",
        status: "warn",
        path: Object.keys(debtRes.byFile).join(", "),
        violators: [],
        detail: `${debtRes.total} tracked defer markers with upgrade triggers`,
      });
    } else {
      gates.push({
        name: "debt-ledger",
        status: "pass",
        path: ".",
        violators: [],
        detail: "0 defer markers",
      });
    }
  } catch (err) {
    gates.push({
      name: "debt-ledger",
      status: "warn",
      path: ".",
      violators: [],
      detail: `debt scan skipped: ${err.message}`,
    });
  }

  // Gate 3: logs-hygiene
  try {
    const candidateLogDirs = [
      options["logs-dir"] ? join(absRoot, options["logs-dir"]) : null,
      join(absRoot, "logs"),
      join(absRoot, ".logs"),
      join(absRoot, ".omp", "logs"),
    ].filter(Boolean).filter((d) => existsSync(d));

    let totalLogFiles = 0;
    let totalLogBytes = 0;
    let staleFilesCount = 0;
    const maxAgeMs = (options["max-log-days"] ? Number(options["max-log-days"]) : (options.maxLogDays ?? 14)) * 24 * 60 * 60 * 1000;
    const maxFiles = options["max-log-files"] ? Number(options["max-log-files"]) : (options.maxLogFiles ?? 1000);
    const maxBytes = options["max-log-bytes"] ? Number(options["max-log-bytes"]) : (options.maxLogBytes ?? 50 * 1024 * 1024);
    const now = Date.now();

    for (const d of candidateLogDirs) {
      try {
        const files = readdirSync(d);
        for (const f of files) {
          try {
            const st = statSync(join(d, f));
            if (st.isFile()) {
              totalLogFiles++;
              totalLogBytes += st.size;
              if (now - st.mtimeMs > maxAgeMs) staleFilesCount++;
            }
          } catch {}
        }
      } catch {}
    }

    const logPath = candidateLogDirs[0] ? relative(absRoot, candidateLogDirs[0]) || "logs" : "logs";
    if (totalLogFiles > maxFiles || totalLogBytes > maxBytes) {
      const violator = `${logPath} (${totalLogFiles} files, ${(totalLogBytes / 1024 / 1024).toFixed(1)} MB exceeds threshold ${maxFiles} files / ${(maxBytes / 1024 / 1024).toFixed(1)} MB)`;
      gates.push({
        name: "logs-hygiene",
        status: "fail",
        path: logPath,
        violators: [violator],
        detail: violator,
      });
      allViolators.push(violator);
    } else if (staleFilesCount > 0 || totalLogFiles > 100) {
      gates.push({
        name: "logs-hygiene",
        status: "warn",
        path: logPath,
        violators: [],
        detail: `${totalLogFiles} log files (${(totalLogBytes / 1024 / 1024).toFixed(1)} MB), ${staleFilesCount} stale (>14 days)`,
      });
    } else {
      gates.push({
        name: "logs-hygiene",
        status: "pass",
        path: candidateLogDirs[0] ? logPath : ".",
        violators: [],
        detail: `${totalLogFiles} log files in hygiene bounds`,
      });
    }
  } catch (err) {
    gates.push({
      name: "logs-hygiene",
      status: "warn",
      path: ".",
      violators: [],
      detail: `logs-hygiene scan skipped: ${err.message}`,
    });
  }

  // Gate 4: orphan / orphan-files
  try {
    const orphanViolators = [];
    const NEVER_DIRS = new Set([
      "node_modules", ".git", ".archmap", "target", "dist", "build", "out", "coverage", ".venv",
    ]);
    // A gitignored path is not an orphan: the operator's ignore rules are the
    // statement of intent. `.tmp/` is where our own containment law sends scratch
    // work, so counting its contents as "orphan/temporary files" made the gate
    // demand the deletion of files the workflow explicitly tells agents to create.
    const ignored = gitIgnoredPaths(absRoot);

    function scanOrphans(dir, relPrefix = "") {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (NEVER_DIRS.has(entry.name)) continue;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (ignored.has(relPath)) continue;
        if (entry.isDirectory()) {
          scanOrphans(join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (/(?:^|[._-])orphan(?:[._-]|$)/i.test(lower) || /\.(tmp|bak|swp|orig)$/i.test(lower)) {
            orphanViolators.push(relPath);
          }
        }
      }
    }

    scanOrphans(absRoot);

    const maxOrphans = options["max-orphans"] !== undefined
      ? Number(options["max-orphans"])
      : (options.maxOrphans ?? 0);

    if (orphanViolators.length > maxOrphans) {
      gates.push({
        name: "orphan-files",
        status: "fail",
        path: orphanViolators.join(", "),
        violators: orphanViolators.map((f) => `${f} (orphan/temporary file)`),
        detail: `${orphanViolators.length} orphan/temporary file(s) found`,
      });
      allViolators.push(...orphanViolators);
    } else if (orphanViolators.length > 0) {
      gates.push({
        name: "orphan-files",
        status: "warn",
        path: orphanViolators.join(", "),
        violators: [],
        detail: `${orphanViolators.length} orphan file(s) tolerated`,
      });
    } else {
      gates.push({
        name: "orphan-files",
        status: "pass",
        path: ".",
        violators: [],
        detail: "0 orphan files",
      });
    }
  } catch (err) {
    gates.push({
      name: "orphan-files",
      status: "warn",
      path: ".",
      violators: [],
      detail: `orphan scan skipped: ${err.message}`,
    });
  }

  const ok = allViolators.length === 0 && gates.every((g) => g.status !== "fail");

  for (const g of gates) {
    const msg = `workflow check-ci: [${g.name}] ${g.status}: ${g.path} (${g.detail})`;
    if (g.status === "fail") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  }

  if (!ok) {
    console.error(`workflow check-ci: quality gate failures:`);
    for (const v of allViolators) {
      console.error(`  - ${v}`);
    }
  }

  return { ok, gates, violators: allViolators };
}

export function cmdCheckCi(root, flags = {}) {
  if (flags.push) return checkPushEvidence(root, flags);
  if (flags.quality || flags["quality-only"] || flags.tier === "quality") {
    const qg = checkQualityGates(root, flags);
    return qg.ok ? 0 : 1;
  }
  let tier = null;
  if (flags.labels !== undefined) {
    const raw = Array.isArray(flags.labels) ? flags.labels : String(flags.labels).split(/[\s,]+/);
    const matches = raw
      .map((l) => String(l).trim())
      .filter((l) => /^workflow:T[0-3]$/i.test(l))
      .map((l) => l.split(":")[1].toUpperCase());
    if (matches.length === 0) {
      console.error("workflow check-ci: PR missing required workflow tier label (workflow:T0, workflow:T1, workflow:T2, or workflow:T3).");
      return 1;
    }
    if (matches.length > 1) {
      console.error(`workflow check-ci: PR has ${matches.length} workflow tier labels; exactly one is required.`);
      return 1;
    }
    tier = matches[0];
    if (flags.tier && String(flags.tier).toUpperCase() !== tier) {
      console.error(`workflow check-ci: --tier (${flags.tier}) contradicts PR label (${tier}).`);
      return 1;
    }
  } else if (flags.tier) {
    tier = String(flags.tier).toUpperCase();
  }

  if (!tier || !["T0", "T1", "T2", "T3"].includes(tier)) {
    console.error("workflow check-ci: --tier T0|T1|T2|T3 is required.");
    return 1;
  }

  const baseRef = flags["base-ref"] || flags.baseRef || flags["base_ref"] || null;

  if (tier === "T0") {
    if (baseRef) {
      const changedFiles = getBaseDiffFiles(root, baseRef);
      if (!changedFiles) return 1;
      if (changedFiles.length > 2) {
        const hasApprovedOverride = Boolean(flags.override || (flags.force && flags.reason));
        if (!hasApprovedOverride) {
          console.error(`workflow check-ci: T0 PR exceeds 1-2 file limit (${changedFiles.length} files changed against ${baseRef}) without approved override:\n  ${changedFiles.slice(0, 5).join("\n  ")}`);
          return 1;
        }
      }
    }
    if (!flags["skip-quality"] && !flags.skipQuality) {
      const qg = checkQualityGates(root, flags);
      if (!qg.ok) return 1;
    }
    console.log(`workflow check-ci: tier T0 passed (lean tier).`);
    return 0;
  }

  if (tier === "T1") {
    if (!flags["skip-quality"] && !flags.skipQuality) {
      const qg = checkQualityGates(root, flags);
      if (!qg.ok) return 1;
    }
    return validateCheckCiT1(root, flags, baseRef);
  }
  // T2 and T3 require committed change artifacts
  const changeId = flags.change ? String(flags.change).trim() : null;
  if (!changeId) {
    console.error(`workflow check-ci: --change <id> is required for ${tier}.`);
    return 1;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(changeId)) {
    console.error(`workflow check-ci: invalid change id '${changeId}' (must be alphanumeric slug).`);
    return 1;
  }

  const relChangeDir = join("openspec", "changes", changeId);
  const changeDir = join(root, relChangeDir);
  if (!existsSync(changeDir) || !isRealPathInsideRoot(root, relChangeDir)) {
    console.error(`workflow check-ci: OpenSpec change directory '${changeDir}' does not exist or resolves outside project root.`);
    return 1;
  }

  // 1. Manifest
  const relManifest = join(relChangeDir, "manifest.md");
  const manifestPath = join(changeDir, "manifest.md");
  if (!existsSync(manifestPath) || !isRealPathInsideRoot(root, relManifest)) {
    console.error(`workflow check-ci: missing manifest.md in '${changeDir}' or resolves outside project root.`);
    return 1;
  }
  const manifestBody = readFileSync(manifestPath, "utf8");
  if (!/R\d\d/.test(manifestBody)) {
    console.error(`workflow check-ci: manifest.md in '${changeDir}' must contain requirement rows (R##).`);
    return 1;
  }

  // 2. Proposal (proposal.md)
  const relProposal = join(relChangeDir, "proposal.md");
  const proposalPath = join(changeDir, "proposal.md");
  if (!existsSync(proposalPath) || !isRealPathInsideRoot(root, relProposal) || !statSync(proposalPath).isFile() || readFileSync(proposalPath, "utf8").trim().length === 0) {
    console.error(`workflow check-ci: missing proposal.md in '${changeDir}'.`);
    return 1;
  }

  // 3. Tasks (tasks.md)
  const relTasks = join(relChangeDir, "tasks.md");
  const tasksPath = join(changeDir, "tasks.md");
  if (!existsSync(tasksPath) || !isRealPathInsideRoot(root, relTasks) || !statSync(tasksPath).isFile() || readFileSync(tasksPath, "utf8").trim().length === 0) {
    console.error(`workflow check-ci: missing tasks.md in '${changeDir}'.`);
    return 1;
  }

  // 4. Specs (specs/ directory)
  const relSpecs = join(relChangeDir, "specs");
  const specsDir = join(changeDir, "specs");
  if (!existsSync(specsDir) || !isRealPathInsideRoot(root, relSpecs) || !statSync(specsDir).isDirectory()) {
    console.error(`workflow check-ci: missing specs/ directory in '${changeDir}'.`);
    return 1;
  }
  const specEntries = readdirSync(specsDir);
  if (specEntries.length === 0) {
    console.error(`workflow check-ci: specs/ directory in '${changeDir}' is empty.`);
    return 1;
  }
  for (const entry of specEntries) {
    const relSpecEntry = join(relSpecs, entry);
    if (!isRealPathInsideRoot(root, relSpecEntry)) {
      console.error(`workflow check-ci: spec entry '${entry}' in '${changeDir}' resolves outside project root.`);
      return 1;
    }
  }

  // 5. Interfaces
  const relInterfaces = join(relChangeDir, "interfaces.md");
  const interfacesPath = join(changeDir, "interfaces.md");
  if (!existsSync(interfacesPath) || !isRealPathInsideRoot(root, relInterfaces)) {
    console.error(`workflow check-ci: missing interfaces.md in '${changeDir}' or resolves outside project root.`);
    return 1;
  }
  const interfacesBody = readFileSync(interfacesPath, "utf8");
  if (interfacesBody.trim().length === 0) {
    console.error(`workflow check-ci: interfaces.md in '${changeDir}' is empty.`);
    return 1;
  }

  const oracleFiles = validateCheckCiOracleFiles(root, relChangeDir);
  if (!oracleFiles.ok) return 1;
  let { oracleRelForCommit } = oracleFiles;

  // T3 additionally requires worktrees.md
  if (tier === "T3") {
    const relWorktrees = join(relChangeDir, "worktrees.md");
    const worktreesPath = join(changeDir, "worktrees.md");
    if (!existsSync(worktreesPath) || !isRealPathInsideRoot(root, relWorktrees) || !statSync(worktreesPath).isFile()) {
      console.error(`workflow check-ci: tier T3 requires openspec/changes/${changeId}/worktrees.md describing at least one isolated worktree.`);
      return 1;
    }
    const worktreesBody = readFileSync(worktreesPath, "utf8").trim();
    if (worktreesBody.length === 0 || !/worktree/i.test(worktreesBody)) {
      console.error(`workflow check-ci: tier T3 requires openspec/changes/${changeId}/worktrees.md describing at least one isolated worktree.`);
      return 1;
    }
  }
  const revRes = flags['evidence-revision']
    ? validateReviewEvidenceAtRevision({ root, changeId, tier, baseRef, revision: String(flags['evidence-revision']) })
    : validateReviewEvidence({ root, changeId, tier, baseRef });
  if (!revRes.ok) {
    console.error(`workflow check-ci: review execution evidence failed for '${changeId}':\n  ${revRes.errors.join("\n  ")}`);
    return 1;
  }
  if (!oracleRelForCommit && existsSync(join(changeDir, "review-evidence.json"))) {
    oracleRelForCommit = join(relChangeDir, "review-evidence.json");
  }

  // A single git verification covers the oracle evidence: validateCheckCiGit
  // already walks commit history from the oracle acceptance commit forward,
  // so a second call on review-evidence.json only repeats subprocess work
  // and fails spuriously on sequential oracle commits.
  // When evidence is validated at a historical revision (push gate), the
  // "modified after acceptance" scan is scoped to this change's own directory:
  // a later commit touching unrelated files cannot taint an archived acceptance.
  const evidenceRevision = flags['evidence-revision'] ? String(flags['evidence-revision']) : null;
  const gitCode = validateCheckCiGit(
    root,
    oracleRelForCommit || join(relChangeDir, "review-evidence.json"),
    baseRef,
    evidenceRevision ? relChangeDir : null,
  );
  if (gitCode !== 0) return gitCode;
  if (!flags["skip-quality"] && !flags.skipQuality) {
    const qg = checkQualityGates(root, flags);
    if (!qg.ok) return 1;
  }
  console.log(`workflow check-ci: ${tier} evidence verified for change '${changeId}'.`);
  return 0;
}
