#!/usr/bin/env node
/**
 * tools/workflow-ci.mjs — CI-гейты workflow (check-ci): вынесены из workflow.mjs 1:1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCodeSize, loadConfig as loadCodeSizeConfig } from "./code-size.mjs";
import { checkTripwire } from "./tripwire.mjs";
import { scanRepo } from "./debt-ledger.mjs";
import {
  NEGATIVE_VERDICT_RE,
  isPositiveOracleVerdict,
  isNegativeOracleVerdict,
  isAcceptanceArtifactFilename,
  validateReviewEvidence,
  LEGACY_MARKER,
  isSupersededOracleArtifact,
  recordStageB,
  runReviewRecord,
  loadReviewEvidence,
  saveReviewEvidence,
} from "./review/evidence.mjs";
import { repairBudget } from "./review/arbitrate.mjs";
import { assertReviewRunFlags, createHttpExecutor, resolveNodeRuntime, validatePolicy } from "./review/http-runtime.mjs";
import { validateReviewCapability } from "./installation/capabilities.mjs";
import { runBriefRounds, appendAddenda } from "./brief-rounds.mjs";
import { oracleInput } from "./brief.mjs";
import { validateReviewEvidenceAtRevision } from "./review/evidence-history.mjs";
import { isPathInsideRoot, isRealPathInsideRoot, isStructuralExcludedPath } from "./worktree-snapshot.mjs";
import { isWorkflowPath, isInsideGitRepo, getPorcelainEntries, gitIgnoredPaths, lastTouchingRevision, hasReconEvidence } from "./workflow-shared.mjs";
import {
  isPlainObject,
  withStateLock,
  load,
  save,
  logEvent,
} from "./workflow-core.mjs";

export function resolveChangedFilesAgainstBase(root, baseRef) {
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
  try {
    let diffOut;
    try { diffOut = run(["diff", "--name-only", `${baseRef}...HEAD`]); }
    catch { diffOut = run(["diff", "--name-only", `${baseRef}..HEAD`]); }
    const changedFiles = diffOut.split("\n").map((f) => f.trim()).filter((f) => f && !isStructuralExcludedPath(f));
    // Changed LINES, from the same diff: a file count cannot see a 2000-line edit
    // inside one file, which is exactly what the per-tier ceiling is about.
    let changedLines = 0;
    try {
      for (const row of run(["diff", "--numstat", `${baseRef}...HEAD`]).split("\n")) {
        const [added, deleted] = row.trim().split(/\s+/);
        if (!added || added === "-" || deleted === "-") continue;
        changedLines += (Number(added) || 0) + (Number(deleted) || 0);
      }
    } catch { changedLines = null; }
    return { ok: true, changedFiles, changedLines };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
/** Resolve the diff once and enforce the tier ceiling; null means the gate must stop. */
function guardDiffBudget(root, baseRef, tier) {
  const res = resolveChangedFilesAgainstBase(root, baseRef);
  if (!res.ok) {
    console.error(`workflow check-ci: failed to resolve base ref '${baseRef}': ${res.error}`);
    return null;
  }
  // The per-tier ceiling is on changed LINES: a file count cannot see a 2000-line
  // edit inside one file, which is exactly the change a lane should refuse.
  if (tier && res.changedLines !== null) {
    try { checkTripwire(res.changedLines, tier); }
    catch (err) {
      console.error(`workflow check-ci: ${err.message}`);
      console.error("  upgrade the tier, or split the change so it fits its lane.");
      return null;
    }
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
  if (!hasReconEvidence(reconBody)) {
    console.error(`workflow check-ci: recon file '${reconFlag}' must name touched files and an acceptance check.`);
    console.error("  headings alone are not evidence: name the files and the command/observation that proves completion.");
    return 1;
  }

  if (baseRef) {
    const changedFiles = guardDiffBudget(root, baseRef, "T1");
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
    // "Skipping" here silently removed the dirty-worktree, mixed-commit and
    // post-acceptance checks — the whole point of this function. A root that is not
    // a git checkout cannot produce commit evidence, so it must say so and refuse.
    console.error("workflow check-ci: git verification is required for accepted changes but this root is not a git worktree.");
    console.error("  the dirty-check, mixed-commit and post-acceptance scans cannot run; commit the change to a git repo or use the non-git close path.");
    return 1;
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
  const changedFiles = guardDiffBudget(root, baseRef, null);
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

/** Directories no gate scans: build output, VCS metadata, and agent caches. */
const IGNORED_SCAN_DIRS = new Set([
  "node_modules", ".git", ".archmap", "target", "dist", "build", "out", "coverage", ".venv",
]);

/** Count regular files under `dir`, bounded: used only to tell an empty root from a
 *  docs-only one, so a runaway walk must not hang a gate. */
function countFiles(dir, limit = 5000) {
  let n = 0;
  const walk = (current) => {
    if (n >= limit) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (n >= limit) return;
      if (IGNORED_SCAN_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

export function checkQualityGates(root = ".", options = {}) {
  const absRoot = resolve(root);
  const gates = [];
  const allViolators = [];
  // Recorder: every gate pushed the same five-field object by hand, which is where
  // this module's size came from. One call per outcome keeps the checks readable.
  const record = (name, status, path, detail, violators = []) => {
    gates.push({ name, status, path, violators, detail });
    if (status === "fail") allViolators.push(...(violators.length ? violators : [`${name}: ${detail}`]));
  };

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
      record("code-size", "fail", [...new Set(sizeRes.failures.map((f) => f.file))].join(", "), `${sizeRes.failures.length} threshold violations`, violators);
    } else if (sizeRes.stats.fileOffenders > 0 || sizeRes.stats.functionOffenders > 0) {
      record("code-size", "warn", sizeRes.files[0]?.file || ".", `${sizeRes.stats.exempt} exempt, ${sizeRes.stats.baselined} baselined`);
    } else if (sizeRes.stats.scannedFiles === 0) {
      // Zero files in scope is not evidence of anything, so it is a warning, never a
      // pass: an empty directory or a wrong --root measured nothing. It must not be a
      // failure either — T0 on a fresh project legitimately has no source files yet,
      // and the tier gate is about the change, not about the tree being populated.
      const fileCount = countFiles(absRoot);
      record("code-size", "warn", ".", fileCount === 0
        ? "empty root — nothing was measured"
        : `no source files in scope (${fileCount} other file(s) present)`);
    } else {
      record("code-size", "pass", ".", `all ${sizeRes.stats.scannedFiles} files within limits`);
    }
  } catch (err) {
    record("code-size", "warn", ".", `code-size scan skipped: ${err.message}`);
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
      record("debt-ledger", "fail", [...new Set(offending.map((m) => m.file))].join(", "), `${offending.length} unmanaged/untriggered debt marker(s)`, violators);
    } else if (debtRes.total > 0) {
      record("debt-ledger", "warn", Object.keys(debtRes.byFile).join(", "), `${debtRes.total} tracked defer markers with upgrade triggers`);
    } else {
      record("debt-ledger", "pass", ".", "0 defer markers");
    }
  } catch (err) {
    record("debt-ledger", "warn", ".", `debt scan skipped: ${err.message}`);
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
    const NEVER_DIRS = IGNORED_SCAN_DIRS;
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
      const changedFiles = guardDiffBudget(root, baseRef, tier);
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

  // Legacy changes predate oracle-artifact and native-evidence; marker = exemption.
  let oracleRelForCommit = null;
  if (!existsSync(join(changeDir, LEGACY_MARKER))) {
    const oracleFiles = validateCheckCiOracleFiles(root, relChangeDir);
    if (!oracleFiles.ok) return 1;
    oracleRelForCommit = oracleFiles.oracleRelForCommit;
  }

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
  // In the push gate the post-acceptance scan is scoped to this change directory:
  // a later commit touching unrelated files cannot taint an archived acceptance.
  const evidenceRevision = flags['evidence-revision'] ? String(flags['evidence-revision']) : null;
  if (!revRes.legacy) { // legacy: no native acceptance commit to walk from
    const gitCode = validateCheckCiGit(root, oracleRelForCommit || join(relChangeDir, "review-evidence.json"), baseRef, evidenceRevision ? relChangeDir : null);
    if (gitCode !== 0) return gitCode;
  }
  if (!flags["skip-quality"] && !flags.skipQuality) {
    const qg = checkQualityGates(root, flags);
    if (!qg.ok) return 1;
  }
  console.log(`workflow check-ci: ${tier} evidence verified for change '${changeId}'.`);
  return 0;
}

/**
 * Reported-only stages: done && !verified (interfaces.md §T2, R03).
 * A stage is reported-only if its status is 'done' (or 'reported') and verified is not true.
 */
export function isStageReported(status, verified) {
  const norm = String(status || "").toLowerCase();
  return (norm === "done" || norm === "reported") && !verified;
}

export function checkStageObject(id, s) {
  if (typeof s === "boolean") return !s ? id : null;
  if (typeof s === "string") return isStageReported(s, false) ? id : null;
  if (isPlainObject(s)) {
    const rawSt = s.status || (s.done ? "done" : (s.verified !== undefined ? "done" : "pending"));
    return isStageReported(rawSt, s.verified === true) ? id : null;
  }
  return null;
}

export function extractReportedFromArray(stages) {
  const list = [];
  for (const s of stages) {
    if (!s) continue;
    const id = String(s.id || s.name || s.stage || "unknown");
    const status = s.status || (s.done ? "done" : "pending");
    if (isStageReported(status, s.verified === true)) list.push(id);
  }
  return list;
}

export function extractReportedFromObject(stages) {
  const list = [];
  for (const [id, s] of Object.entries(stages)) {
    const hit = checkStageObject(id, s);
    if (hit) list.push(hit);
  }
  return list;
}

export function hasOracleStage(stages) {
  if (Array.isArray(stages)) {
    return stages.some((s) => (s?.id || s?.name) === "oracle");
  }
  return isPlainObject(stages) && stages.oracle !== undefined;
}

export function checkUnverifiedOracleArtifact(st, reported) {
  if (st?.artifacts?.oracle?.verified !== false) return null;
  if (reported.includes("oracle")) return null;
  if (hasOracleStage(st.stages)) return null;
  return "oracle";
}

export function getReportedStages(st) {
  if (!st) return [];
  const reported = Array.isArray(st.stages)
    ? extractReportedFromArray(st.stages)
    : (isPlainObject(st.stages) ? extractReportedFromObject(st.stages) : []);
  const oracleMissing = checkUnverifiedOracleArtifact(st, reported);
  if (oracleMissing) reported.push(oracleMissing);
  return [...new Set(reported)];
}

export function checkStageState(root, st, flags) {
  const unverifiedStages = getReportedStages(st);
  if (!unverifiedStages.length) return { ok: true, unverifiedStages: [] };
  if (!flags.force) {
    console.error(`workflow: cannot close ${st.tier} — reported-but-unverified: ${unverifiedStages.join(", ")}.`);
    console.error(`  verify stages with passing oracle/gates, or close with --force --reason "<why unverified stages are accepted>".`);
    logEvent(root, "reported-but-unverified", `${st.tier} — ${st.task} (${unverifiedStages.join(", ")})`);
    return { ok: false, exitCode: 1, unverifiedStages };
  }
  if (!flags.reason) {
    console.error(`workflow: --force requires --reason "<why unverified stages are accepted>"`);
    return { ok: false, exitCode: 1, unverifiedStages };
  }
  return { ok: true, unverifiedStages };
}

export function recordStage(root, stageName, { status = "done", verified = false } = {}) {
  return withStateLock(root, () => {
    const st = load(root);
    if (!st || st.status !== "open") {
      console.error("workflow: no open task to update stage. Run `start` first.");
      return 2;
    }
    if (!st.stages) st.stages = {};
    const now = new Date().toISOString();
    const entry = { status, verified: Boolean(verified), at: now };
    if (verified) entry.verifiedAt = now;
    if (isPlainObject(st.stages)) {
      st.stages[stageName] = { ...(isPlainObject(st.stages[stageName]) ? st.stages[stageName] : {}), ...entry };
    } else if (Array.isArray(st.stages)) {
      const idx = st.stages.findIndex((s) => (s?.id || s?.name) === stageName);
      if (idx >= 0) st.stages[idx] = { ...st.stages[idx], ...entry };
      else st.stages.push({ id: stageName, ...entry });
    }
    if (stageName === "oracle" && st.artifacts?.oracle) {
      st.artifacts.oracle.verified = Boolean(verified);
    }
    save(root, st);
    logEvent(root, "stage", `${stageName}: ${status}${verified ? " (verified)" : " (reported)"}`);
    return 0;
  });
}

export function setStageVerified(root, stageName, verified = true) {
  return recordStage(root, stageName, { status: "done", verified: Boolean(verified) });
}

export function recordGatePass(root, gateName) {
  return setStageVerified(root, gateName, true);
}

export function cmdStage(root, flags = {}) {
  const name = flags.name || flags.stage || flags._?.[1];
  if (!name) {
    console.error("workflow stage: --name <stage> is required.");
    return 1;
  }
  const status = flags.status || "done";
  const verified = flags.verified !== undefined ? Boolean(flags.verified) : false;
  return recordStage(root, String(name), { status: String(status), verified });
}

export function cmdGatePass(root, flags = {}) {
  const gate = flags.gate || flags.name || flags._?.[1];
  if (!gate) {
    console.error("workflow gate-pass: --gate <name> is required.");
    return 1;
  }
  return recordGatePass(root, String(gate));
}

export function formatDeviationParts(dev) {
  const parts = [];
  if (dev.missing) parts.push(`missing ${dev.missing.join(", ")}`);
  if (dev.invalid) parts.push(`invalid ${dev.invalid.join(", ")}`);
  if (dev.staleAcceptance) parts.push("stale acceptance");
  if (dev.unverifiedStages) parts.push(`unverified ${dev.unverifiedStages.join(", ")}`);
  if (dev.noExperience) parts.push("no experience lesson");
  return parts.join(" + ");
}

export function buildDeviationRecord(reason, { missing, invalid, staleAcceptance, unverifiedStages, noExperience }) {
  const dev = { forced: true, reason: String(reason) };
  let hasAny = false;
  if (missing?.length) { dev.missing = [...missing]; hasAny = true; }
  if (invalid?.length) { dev.invalid = [...invalid]; hasAny = true; }
  if (staleAcceptance) { dev.staleAcceptance = staleAcceptance; hasAny = true; }
  if (unverifiedStages?.length) { dev.unverifiedStages = [...unverifiedStages]; hasAny = true; }
  if (noExperience) { dev.noExperience = true; hasAny = true; }
  return hasAny ? dev : null;
}

export function applyCloseDeviation(st, flags, details) {
  if (!flags.force) return null;
  const dev = buildDeviationRecord(flags.reason, details);
  if (!dev) return null;
  st.deviation = dev;
  return formatDeviationParts(dev);
}

/** Review attempts already recorded for this change: prior cycles in history + the live one. */
export function reviewAttempts(root, changeId) {
  if (!changeId) return { repairs: 0, retries: 0, reReviews: 0 };
  const dir = join(root, "openspec", "changes", changeId);
  const file = join(dir, "review-evidence.json");
  if (!existsSync(file)) return { repairs: 0, retries: 0, reReviews: 0 };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const cycles = Array.isArray(data.history) ? data.history.length : 0;
    return { repairs: 0, retries: 0, reReviews: cycles };
  } catch { return { repairs: 0, retries: 0, reReviews: 0 }; }
}
export function checkProviderAdmitted(provider, policy = null, env = process.env) {
  if (!provider || typeof provider !== "string") return false;
  const p = provider.trim();
  if (p === "nullform-gateway") {
    return Boolean(env.NULLFORM_GATEWAY_API_KEY || (policy && policy.provider === "nullform-gateway"));
  }
  if (p === "openai") {
    return Boolean(env.OPENAI_API_KEY || (policy && policy.provider === "openai"));
  }
  if (policy && policy.provider === p) {
    const credKey = policy.credentialEnv || "OPENAI_API_KEY";
    return Boolean(env[credKey]);
  }
  return false;
}

/**
 * Resolve and validate the review mode before any model dispatch.
 * Adversarial is reviewer-only: for the oracle, hunting counterexamples is already
 * the default stance, so accepting the flag there would imply a second, different
 * behaviour that does not exist.
 */
export function resolveReviewMode(rawMode, role) {
  const mode = rawMode === undefined || rawMode === null ? "default" : String(rawMode).trim() || "default";
  if (!["default", "adversarial"].includes(mode)) {
    throw new Error(`review-run: unknown --mode '${mode}'; allowed: default adversarial`);
  }
  if (mode === "adversarial" && role !== "reviewer") {
    throw new Error("review-run: --mode adversarial is only supported for --role reviewer");
  }
  return mode;
}

export function cmdReviewRun(root, flags, positionals = 0) {
  try {
    const rawCrossModel = flags?.["cross-model"] ?? flags?.crossModel ?? null;
    if (rawCrossModel === true) {
      throw new Error("review-run: '--cross-model' requires a '<provider/model>' argument");
    }
    const crossModel = rawCrossModel ? String(rawCrossModel).trim() : null;
    if (crossModel && flags.role !== "oracle") {
      throw new Error("review-run: --cross-model is only supported for --role oracle");
    }
    if (crossModel && !/^[^/\s]+\/\S+$/.test(crossModel)) {
      throw new Error("review-run: --cross-model requires '<provider/model>' format");
    }

    const cleanFlags = { ...flags };
    delete cleanFlags["cross-model"];
    delete cleanFlags.crossModel;
    delete cleanFlags.ompRunner;
    delete cleanFlags.crossModelRunner;
    delete cleanFlags.env;
    delete cleanFlags.mockMissingProvider;
    delete cleanFlags.returnResult;

    // Adversarial review is a mode, not a second role: the same reviewer must prove
    // the change can fail instead of confirming it works. Validation lives in its own
    // function so the admission rule is testable without a model dispatch.
    const mode = resolveReviewMode(flags?.mode, flags?.role);
    delete cleanFlags.mode;

    const { redo, dryRun } = assertReviewRunFlags(cleanFlags, positionals);
    const gate = validateReviewCapability(flags.harness, { dryRun: true, userHome: flags["user-home"] });
    if (!gate.ok) throw new Error(gate.error);
    // The re-review ceiling from CONTEXT.md ("one initial review plus two re-reviews")
    // was a documented rule with no enforcement: the attempt count is already in the
    // evidence history, so it is counted here instead of being asserted in prose.
    const attempts = reviewAttempts(root, flags.change);
    repairBudget(attempts);
    const rawProductCmd = flags["product-command"] ?? flags.productCommand ?? null;
    const productCommand = rawProductCmd ? (typeof rawProductCmd === "string" ? JSON.parse(rawProductCmd) : rawProductCmd) : null;
    let policy = null, httpExecutor = null;
    if (!dryRun && !flags["resume-session"] && !flags.ompRunner) {
      if (!flags["admission-policy"]) throw new Error('No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON');
      policy = validatePolicy(JSON.parse(readFileSync(resolve(root, flags["admission-policy"]), "utf8")));
      resolveNodeRuntime({});
      httpExecutor = createHttpExecutor({ root, policy });
    }
    const res = runReviewRecord({
      root, changeId: flags.change, role: flags.role, model: flags.model,
      baseRef: flags["base-ref"] || flags.baseRef, prompt: flags.prompt, redo,
      productCommand, admissionPolicy: flags["admission-policy"] || flags.admissionPolicy, resumeSessionDir: flags["resume-session"] ?? flags.resumeSession ?? null,
      dryRun, harness: gate.harness, httpExecutor, policy,
      ompRunner: flags.ompRunner,
    });

    if (dryRun) {
      if (crossModel) res.crossModel = crossModel;
      if (mode !== "default") res.mode = mode;
      console.log(JSON.stringify(res, null, 2));
      return flags.returnResult ? res : 0;
    }

    if (!crossModel) {
      const out = { ...res, mode };
      if (flags.returnResult) return out;
      console.log(`workflow review-run: recorded ${flags.role} execution for '${flags.change}'${mode === "adversarial" ? " (adversarial mode)" : ""}.`);
      return res.ok ? 0 : 1;
    }

    // Cross-model evaluation for oracle
    const [crossProvider] = crossModel.split("/");
    const env = flags.env || process.env;
    const isAdmitted = checkProviderAdmitted(crossProvider, policy, env) && !flags.mockMissingProvider;

    const changeDir = join(root, "openspec", "changes", flags.change);
    const evidence = loadReviewEvidence(changeDir);

    if (!isAdmitted) {
      // Provider unavailable or credential absent -> UNVERIFIED, never simulated
      if (evidence) {
        evidence.crossModel = {
          status: "unverified",
          model: crossModel,
          provider: crossProvider,
          verdict: "UNVERIFIED",
          reason: "provider unavailable or credential absent",
        };
        evidence.unverified = true;
        evidence.verdict = "UNVERIFIED";
        saveReviewEvidence(changeDir, evidence);
      }
      console.log(`workflow review-run: cross-model UNVERIFIED for '${flags.change}': provider unavailable or credential absent.`);
      return flags.returnResult ? { ok: false, unverified: true, verdict: "UNVERIFIED", record: res.record } : 1;
    }

    // Second pass with that model through the admitted transport only
    const crossRunner = flags.crossModelRunner || flags.ompRunner || null;
    const res2 = runReviewRecord({
      root, changeId: flags.change, role: flags.role, model: crossModel,
      baseRef: flags["base-ref"] || flags.baseRef, prompt: flags.prompt, redo: false,
      productCommand, admissionPolicy: flags["admission-policy"] || flags.admissionPolicy, resumeSessionDir: null,
      dryRun: false, harness: gate.harness, httpExecutor, policy,
      ompRunner: crossRunner,
    });

    if (!res2.ok) {
      console.error(`workflow review-run: cross-model execution failed for '${flags.change}'.`);
      return flags.returnResult ? { ok: false, error: "cross-model pass failed" } : 1;
    }

    const verdict1 = res.record?.verdict;
    const verdict2 = res2.record?.verdict;
    const updatedEvidence = loadReviewEvidence(changeDir);

    if (verdict1 === verdict2) {
      // Equal verdicts -> one verdict
      if (updatedEvidence) {
        updatedEvidence.verdict = verdict1;
        updatedEvidence.crossModel = { model: crossModel, verdict: verdict2, matches: true };
        saveReviewEvidence(changeDir, updatedEvidence);
      }
      const ok = verdict1 === "ACCEPT";
      console.log(`workflow review-run: recorded ${flags.role} execution for '${flags.change}'. Cross-model agreed: ${verdict1}.`);
      return flags.returnResult ? { ok, verdict: verdict1, record: res.record, crossRecord: res2.record } : (ok ? 0 : 1);
    } else {
      // Different verdicts -> escalate, record both verdicts and mark change escalated (no ACCEPT)
      if (updatedEvidence) {
        updatedEvidence.escalated = true;
        updatedEvidence.escalation = {
          reason: "cross-model verdict disagreement",
          verdicts: [verdict1, verdict2],
          at: new Date().toISOString(),
        };
        updatedEvidence.verdicts = [verdict1, verdict2];
        updatedEvidence.crossModel = { model: crossModel, verdict: verdict2, matches: false, escalated: true };
        updatedEvidence.verdict = "ESCALATED";
        saveReviewEvidence(changeDir, updatedEvidence);
      }

      try {
        const st = load(root);
        if (st && st.status === "open") {
          st.escalated = true;
          st.escalatedAt = new Date().toISOString();
          st.escalations = [
            ...(st.escalations || []),
            { reason: "cross-model verdict disagreement", verdicts: [verdict1, verdict2], at: st.escalatedAt },
          ];
          save(root, st);
        }
      } catch {}

      console.log(`workflow review-run: cross-model verdict divergence (${verdict1} vs ${verdict2}) -> escalated (no ACCEPT).`);
      return flags.returnResult ? { ok: false, escalated: true, verdicts: [verdict1, verdict2], record: res.record, crossRecord: res2.record } : 1;
    }
  } catch (err) {
    console.error(`workflow review-run error: ${err.message}`);
    return 1;
  }
}

export function cmdStageB(root, flags) {
  try {
    const res = recordStageB({ root, changeId: flags.change, phase: flags.phase || "after", disposition: flags.disposition || "lean-already", testCmd: flags["test-cmd"] || flags.testCmd, summary: flags.summary, ...(flags["test-timeout"] !== undefined ? { testTimeoutMs: /^[1-9]\d*$/.test(String(flags["test-timeout"])) && typeof flags["test-timeout"] !== "boolean" ? Number(flags["test-timeout"]) * 1000 : NaN } : {}) });
    if (res.ok) { console.log(`workflow stage-b: recorded ${flags.phase || "after"} execution (${res.stageB.disposition || "frozen baseline"}) for '${flags.change}'.`); return 0; }
    return 1;
  } catch (err) { console.error(`workflow stage-b error: ${err.message}`); return 1; }
}

export async function cmdBrief(root, flags, options = {}) {
  try {
    let rounds = flags.rounds !== undefined ? parseInt(flags.rounds, 10) : 2;
    if (isNaN(rounds) || rounds < 1) rounds = 2;
    if (rounds > 5) rounds = 5;

    let manifestPath = flags.manifest ? String(flags.manifest).trim() : null;
    if (!manifestPath) {
      const st = load(root);
      if (st?.artifacts?.manifest?.path) {
        manifestPath = st.artifacts.manifest.path;
      }
    }
    if (!manifestPath) {
      console.error("workflow brief: manifest path required (--manifest <path>)");
      return 1;
    }
    manifestPath = resolve(root, manifestPath);

    let briefText = "";
    const briefArg = flags.brief || flags["brief-file"] || flags.file;
    if (briefArg) {
      const candidatePath = resolve(root, String(briefArg));
      if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
        briefText = readFileSync(candidatePath, "utf8");
      } else {
        briefText = String(briefArg);
      }
    } else {
      const manifestDir = dirname(manifestPath);
      try {
        const frozen = oracleInput(manifestDir);
        if (frozen && existsSync(frozen)) {
          briefText = readFileSync(frozen, "utf8");
        }
      } catch {
        // No frozen brief, briefText defaults to empty
      }
    }

    const ask = options?.ask;
    const addenda = await runBriefRounds(briefText, { rounds, ask });
    appendAddenda(manifestPath, addenda);
    console.log(`workflow brief: recorded ${addenda.length} addenda in ${basename(manifestPath)} (${rounds} rounds).`);
    return 0;
  } catch (err) {
    console.error(`workflow brief error: ${err.message}`);
    return 1;
  }
}

export const PROTECTED_BRANCH_RE = /^(?:master|main|head)$|(?:\/|-)(?:master|main|head)$/i;

export function isProtectedRefName(name) {
  if (!name || typeof name !== "string") return false;
  return PROTECTED_BRANCH_RE.test(name.trim());
}

export function getCurrentBranch(root) {
  if (!isInsideGitRepo(root)) return null;
  try {
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

export function isRefMatchingCurrentBranch(refOrChange, currentBranch) {
  if (!refOrChange || !currentBranch) return false;
  const c = refOrChange.trim();
  const b = currentBranch.trim();
  if (c === b) return true;
  const strip = (s) => s.replace(/^(?:feat|fix|feature)[/-]/i, "");
  return strip(c) === strip(b);
}

export function getLocalBranches(root) {
  if (!isInsideGitRepo(root)) return new Set();
  try {
    const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function confirmSettle(flags) {
  let positional = null;
  if (Array.isArray(flags._)) {
    const nonCmd = flags._.filter((a) => a !== "settle");
    if (nonCmd.length > 0) positional = nonCmd[0];
  }
  const change = flags.change || flags.name || positional;
  if (!change || typeof change !== "string" || !change.trim()) {
    console.error("workflow settle: --change <name> is required.");
    return null;
  }
  const trimmed = change.trim();
  if (isProtectedRefName(trimmed)) {
    console.error(`workflow settle: refusing to settle protected ref '${trimmed}'.`);
    return null;
  }
  if (!flags.yes) {
    console.error(`workflow settle: confirmation required (--yes) to remove worktree and branch for change '${trimmed}'.`);
    return null;
  }
  return trimmed;
}

export function resolveSettleDocTargets(root, change, worktreePaths, branches) {
  const doc = join(root, "openspec", "changes", change, "worktrees.md");
  if (!existsSync(doc)) return;
  try {
    for (const line of readFileSync(doc, "utf8").split("\n")) {
      const match = line.match(/\.tmp\/worktrees\/[^\s|`]+/);
      if (match) {
        const p = resolve(root, match[0]);
        if (existsSync(p) && isPathInsideRoot(root, p) && resolve(p) !== resolve(root)) {
          worktreePaths.add(p);
        }
      }
      const branchMatch = line.match(/(?:feat|fix|feature)\/[a-z0-9_-]+/i);
      if (branchMatch && !isProtectedRefName(branchMatch[0])) {
        branches.add(branchMatch[0]);
      }
    }
  } catch {}
}

export function resolveSettleGitTargets(root, change, worktreePaths, branches) {
  if (!isInsideGitRepo(root)) return;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    const state = { currentPath: null };
    for (const line of out.split("\n")) {
      parseWorktreeLine(line, root, change, worktreePaths, branches, state);
    }
  } catch {}
}

function parseWorktreeLine(line, root, change, worktreePaths, branches, state) {
  if (line.startsWith("worktree ")) {
    state.currentPath = line.slice("worktree ".length).trim();
    const resolvedPath = resolve(root, state.currentPath);
    if (resolvedPath !== resolve(root) && isPathInsideRoot(root, resolvedPath) && existsSync(resolvedPath)) {
      const base = basename(state.currentPath);
      if (base === change || base === `feature${change}` || base === `feat-${change}` || state.currentPath.includes(change)) {
        worktreePaths.add(resolvedPath);
      }
    }
  } else if (line.startsWith("branch refs/heads/") && state.currentPath) {
    const b = line.slice("branch refs/heads/".length).trim();
    const resolvedPath = resolve(root, state.currentPath);
    if (resolvedPath !== resolve(root) && worktreePaths.has(resolvedPath)) {
      if (!isProtectedRefName(b)) branches.add(b);
    }
  }
}

export function resolveSettleTargets(root, change) {
  const worktreePaths = new Set();
  const branches = new Set();

  if (!change || typeof change !== "string" || isProtectedRefName(change)) {
    return { worktreePaths, branches };
  }

  const currentBranch = isInsideGitRepo(root) ? getCurrentBranch(root) : null;
  if (currentBranch && isRefMatchingCurrentBranch(change, currentBranch)) {
    return { worktreePaths, branches };
  }

  resolveSettleDocTargets(root, change, worktreePaths, branches);
  resolveSettleDiskWorktrees(root, change, worktreePaths);
  resolveSettleGitTargets(root, change, worktreePaths, branches);
  resolveSettleBranchCandidates(root, change, currentBranch, branches);

  return { worktreePaths, branches };
}

function resolveSettleDiskWorktrees(root, change, worktreePaths) {
  const wtBase = join(root, ".tmp", "worktrees");
  if (!existsSync(wtBase)) return;
  try {
    for (const entry of readdirSync(wtBase)) {
      if (entry === change || entry === `feature${change}` || entry === `feat-${change}` || entry === `feat_${change}` || (change.length >= 3 && entry.includes(change))) {
        const p = resolve(wtBase, entry);
        if (existsSync(p) && isPathInsideRoot(root, p) && resolve(p) !== resolve(root)) {
          worktreePaths.add(p);
        }
      }
    }
  } catch {}
}

function resolveSettleBranchCandidates(root, change, currentBranch, branches) {
  if (!isInsideGitRepo(root)) {
    branches.clear();
    return;
  }
  const existingLocalBranches = getLocalBranches(root);
  const candidateBranches = new Set([
    `feat/${change}`,
    `fix/${change}`,
    `feat-${change}`,
    `fix-${change}`,
  ]);
  if (/^(?:feat|fix|feature)[/-]/i.test(change)) {
    candidateBranches.add(change);
  }
  for (const b of candidateBranches) {
    if (existingLocalBranches.has(b)) branches.add(b);
  }
  for (const b of Array.from(branches)) {
    if (!existingLocalBranches.has(b) || isProtectedRefName(b) || (currentBranch && isRefMatchingCurrentBranch(b, currentBranch))) {
      branches.delete(b);
    }
  }
}

export function removeSettleWorktrees(root, worktreePaths) {
  for (const wtPath of worktreePaths) {
    if (isPathInsideRoot(root, wtPath) && resolve(wtPath) !== resolve(root)) {
      removeSingleSettleWorktree(root, wtPath);
    }
  }
}

function removeSingleSettleWorktree(root, wtPath) {
  if (isInsideGitRepo(root)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch {}
  }
  try {
    rmSync(wtPath, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`failed to remove worktree at ${wtPath}: ${err.message}`);
  }
  if (existsSync(wtPath)) {
    throw new Error(`failed to remove worktree at ${wtPath}: directory still exists`);
  }
}

export function removeSettleBranches(root, branches) {
  if (!isInsideGitRepo(root)) return;
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore", windowsHide: true });
  } catch {}
  for (const b of branches) {
    if (isProtectedRefName(b)) {
      throw new Error(`cannot delete protected branch '${b}'`);
    }
    const currentBranch = getCurrentBranch(root);
    if (currentBranch && isRefMatchingCurrentBranch(b, currentBranch)) {
      throw new Error(`cannot delete current branch '${b}'`);
    }
    try {
      execFileSync("git", ["branch", "-D", b], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`failed to delete branch '${b}': ${msg}`);
    }
  }
}

export function cmdSettle(root, flags = {}) {
  const change = confirmSettle(flags);
  if (!change) return 1;

  if (isProtectedRefName(change)) {
    console.error(`workflow settle: refusing to settle protected ref '${change}'.`);
    return 1;
  }

  if (isInsideGitRepo(root)) {
    const currentBranch = getCurrentBranch(root);
    if (currentBranch && isRefMatchingCurrentBranch(change, currentBranch)) {
      console.error(`workflow settle: refusing to settle current branch '${currentBranch}'.`);
      return 1;
    }
  }

  const { worktreePaths, branches } = resolveSettleTargets(root, change);
  if (worktreePaths.size === 0 && branches.size === 0) {
    console.error(`workflow settle: no existing worktree or branch found for change '${change}'.`);
    return 1;
  }

  try {
    removeSettleWorktrees(root, worktreePaths);
    removeSettleBranches(root, branches);
  } catch (err) {
    console.error(`workflow settle: ${err.message}`);
    return 1;
  }

  console.log(`workflow settle: change '${change}' worktree and branch removed.`);
  return 0;
}

if (process.argv[1] && (() => { try { const a = resolve(process.argv[1]).toLowerCase(), b = fileURLToPath(import.meta.url).toLowerCase(); return a === b || realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; } })()) {
  // workflow-ci is a library module; direct invocation is a clean no-op
}

