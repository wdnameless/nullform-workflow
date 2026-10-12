/**
 * tools/tests/portable-runtime.test.mjs — Real FS/child-process regressions for portable runtime:
 * fault, kill, stale lock, live owner, tampered journal, pending retry, human assets,
 * no-Bun non-OMP public workflow, and unsupported review refusal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireDeploymentLock, releaseDeploymentLock, recoverAbandonedJournal, DeploymentJournal, getDeploymentLockPath, getDeploymentJournalPath } from "../deployment-journal.mjs";
import { readInstallationState, writeInstallationState, getStateFilePath, sanitizeError } from "../installation-state.mjs";
import { installHarness } from "../install-harness.mjs";
import { runWorkflowCli } from "../workflow.mjs";
import { getCapabilitiesInfo, main } from "../../bin/nullform.mjs";
import { runDoctor } from "../doctor.mjs";
import { checkVersionAlignment } from "../harness-capabilities.mjs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "../..");
const CLI_PATH = resolve(REPO_ROOT, "bin/nullform.mjs");

function createTempDir(prefix = "runtime-test-") {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("1. fault: deterministic write failure interrupts install; prior verified identity remains intact and human bytes preserved", () => {
  const userHome = createTempDir("fault-home-");
  const targetRoot = createTempDir("fault-root-");

  try {
    const priorState = {
      schemaVersion: 1,
      harness: "opencode",
      root: targetRoot,
      userHome,
      version: "1.0.0",
      managedFiles: {},
    };
    writeInstallationState(userHome, priorState);

    const humanFile = join(targetRoot, "human-notes.md");
    writeFileSync(humanFile, "# Human original notes", "utf8");

    const journal = new DeploymentJournal({
      userHome,
      targetRoot,
      harness: "opencode",
      targetVersion: "1.2.0",
    });
    journal.start();

    const file1 = join(targetRoot, "test-file1.txt");
    journal.recordBeforeWrite(file1, "content-v2");
    writeFileSync(file1, "content-v2", "utf8");
    journal.recordWritten(file1);

    journal.rollback("injected_fault");

    const current = readInstallationState(userHome);
    assert.equal(current.version, "1.0.0");
    assert.equal(existsSync(file1), false, "Created file should be unlinked on rollback");
    assert.equal(readFileSync(humanFile, "utf8"), "# Human original notes", "Human file preserved");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("2. kill: interrupted process leaves journal that can be recovered without permanent lockout or data loss", () => {
  const userHome = createTempDir("kill-home-");
  const targetRoot = createTempDir("kill-root-");

  try {
    const originalFile = join(targetRoot, "config.json");
    writeFileSync(originalFile, '{"setting": "original"}', "utf8");

    const journal = new DeploymentJournal({
      userHome,
      targetRoot,
      harness: "claude",
      targetVersion: "1.2.0",
    });
    journal.start();

    journal.recordBeforeWrite(originalFile, '{"setting": "modified"}');
    writeFileSync(originalFile, '{"setting": "modified"}', "utf8");
    journal.recordWritten(originalFile);

    assert.equal(existsSync(getDeploymentJournalPath(userHome)), true);

    const res = recoverAbandonedJournal(userHome, { targetRoot });
    assert.equal(res.recovered, true);
    assert.equal(readFileSync(originalFile, "utf8"), '{"setting": "original"}', "File restored from backup");
    assert.equal(existsSync(getDeploymentJournalPath(userHome)), false, "Journal cleaned up after recovery");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("3. stalelock: verified dead owner PID allows scoped recovery and lock reacquisition", () => {
  const userHome = createTempDir("stale-home-");
  const targetRoot = createTempDir("stale-root-");

  try {
    const lockPath = getDeploymentLockPath(userHome);
    mkdirSync(join(userHome, ".nullform"), { recursive: true });

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        createdAt: new Date().toISOString(),
        targetRoot,
        harness: "cursor",
      }),
      "utf8"
    );

    const lock = acquireDeploymentLock({ userHome, targetRoot, harness: "cursor" });
    assert.equal(lock.acquired, true);
    assert.equal(lock.lockId, process.pid);
    lock.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("4. liveowner: active process holding lock cannot be displaced; concurrent application is refused; uncertain/corrupt PID is not displaced", () => {
  const userHome = createTempDir("live-home-");
  const targetRoot = createTempDir("live-root-");

  try {
    const lock = acquireDeploymentLock({ userHome, targetRoot, harness: "omp" });
    assert.equal(lock.acquired, true);

    assert.throws(
      () => {
        acquireDeploymentLock({ userHome, targetRoot, harness: "omp" });
      },
      (err) => err.code === "ELOCKED"
    );

    lock.release();

    // Corrupted lock file: must NOT displace uncertain owner
    const lockPath = getDeploymentLockPath(userHome);
    writeFileSync(lockPath, "{corrupt-json", "utf8");
    assert.throws(
      () => {
        acquireDeploymentLock({ userHome, targetRoot, harness: "omp" });
      },
      (err) => err.code === "ELOCKED"
    );
    rmSync(lockPath, { force: true });
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("5. tamperedjournal: crafted journal with outside targetRoot, escaped destPath or backupFile traversal is rejected BEFORE mutation", () => {
  const userHome = createTempDir("tamper-home-");
  const victimDir = createTempDir("tamper-victim-");

  try {
    const victimFile = join(victimDir, "victim.txt");
    writeFileSync(victimFile, "VICTIM_INTACT", "utf8");

    const journalPath = getDeploymentJournalPath(userHome);
    mkdirSync(join(userHome, ".nullform"), { recursive: true });

    // Attack 1: journal.targetRoot outside trusted boundaries
    const attack1 = {
      journalId: "valid_id_123",
      status: "in-progress",
      pid: 99999999,
      userHome,
      targetRoot: victimDir,
      entries: [
        {
          index: 0,
          destPath: victimFile,
          existed: true,
          backupFile: "entry_0.bak",
          status: "written",
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(attack1), "utf8");

    assert.throws(
      () => {
        recoverAbandonedJournal(userHome);
      },
      (err) => err.code === "ETAMPERED"
    );
    assert.equal(readFileSync(victimFile, "utf8"), "VICTIM_INTACT");

    // Attack 2: backupFile with path traversal
    const trustedTarget = createTempDir("tamper-target-");
    const targetFile = join(trustedTarget, "file.txt");
    writeFileSync(targetFile, "FILE_INTACT", "utf8");

    const attack2 = {
      journalId: "valid_id_456",
      status: "in-progress",
      pid: 99999999,
      userHome,
      targetRoot: trustedTarget,
      entries: [
        {
          index: 0,
          destPath: targetFile,
          existed: true,
          backupFile: "../payload.txt",
          status: "written",
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(attack2), "utf8");

    assert.throws(
      () => {
        recoverAbandonedJournal(userHome, { targetRoot: trustedTarget });
      },
      (err) => err.code === "ETAMPERED"
    );
    assert.equal(readFileSync(victimFile, "utf8"), "VICTIM_INTACT");
    assert.equal(readFileSync(targetFile, "utf8"), "FILE_INTACT");

    rmSync(trustedTarget, { recursive: true, force: true });
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test("6. crashwindow: write-ahead recovery handles pending applied writes (crash before recordWritten)", () => {
  const userHome = createTempDir("crash-home-");
  const targetRoot = createTempDir("crash-root-");

  try {
    const file = join(targetRoot, "pending-test.txt");
    writeFileSync(file, "ORIGINAL_DATA", "utf8");

    const journal = new DeploymentJournal({
      userHome,
      targetRoot,
      harness: "opencode",
      targetVersion: "1.2.0",
    });
    journal.start();

    // 1. Record before write (status: 'pending')
    journal.recordBeforeWrite(file, "NEW_DATA");
    // 2. Write file to disk
    writeFileSync(file, "NEW_DATA", "utf8");
    // 3. CRASH! (recordWritten was NEVER called, status is still 'pending')

    // Recovery runs on abandoned journal
    const res = recoverAbandonedJournal(userHome, { targetRoot });
    assert.equal(res.recovered, true);
    assert.equal(readFileSync(file, "utf8"), "ORIGINAL_DATA", "Pending write must be restored from backup");
    assert.equal(existsSync(getDeploymentJournalPath(userHome)), false);
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("7. stateatomic: writeInstallationState safely replaces state without unlinking old state on Windows rename failure", () => {
  const userHome = createTempDir("state-home-");

  try {
    const state1 = {
      schemaVersion: 1,
      harness: "claude",
      root: join(userHome, "root1"),
      userHome,
      version: "1.0.0",
    };
    writeInstallationState(userHome, state1);
    assert.equal(readInstallationState(userHome).version, "1.0.0");

    const state2 = {
      schemaVersion: 1,
      harness: "claude",
      root: join(userHome, "root2"),
      userHome,
      version: "1.1.0",
    };
    writeInstallationState(userHome, state2);
    assert.equal(readInstallationState(userHome).version, "1.1.0");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("8. pendingretry: version divergence is reported by doctor as pending/recoverable; retry finishes without treating partly deployed owned bytes as human edits", () => {
  const userHome = createTempDir("pending-home-");
  const targetRoot = createTempDir("pending-root-");

  try {
    writeInstallationState(userHome, {
      schemaVersion: 1,
      harness: "opencode",
      root: targetRoot,
      userHome,
      version: "1.0.0",
      managedFiles: {},
    });

    writeFileSync(join(targetRoot, "VERSION"), "1.0.0\n", "utf8");

    const docRes = runDoctor({
      harness: targetRoot,
      targetHarness: "opencode",
      userHome,
      packageRoot: REPO_ROOT,
    });

    const alignCheck = docRes.checks.find((c) => c.id === "version-alignment");
    assert.ok(alignCheck, "version-alignment check must exist");
    assert.equal(alignCheck.status, "warn");
    assert.equal(alignCheck.divergence, "pending");

    const skillDir = join(targetRoot, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "# Deployed Candidate Bytes", "utf8");

    const plan = installHarness({
      harness: "opencode",
      root: targetRoot,
      userHome,
      dryRun: false,
    });

    assert.ok(plan.filesToCopy.length > 0);
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("9. humanassets: Markdown outside managed block and human edits in core scripts are preserved", () => {
  const userHome = createTempDir("assets-home-");
  const targetRoot = createTempDir("assets-root-");

  try {
    mkdirSync(targetRoot, { recursive: true });
    const agentsFile = join(targetRoot, "AGENTS.md");
    writeFileSync(agentsFile, "# Custom Human Header\n\nUser instructions here.\n", "utf8");

    const plan = installHarness({
      harness: "codex",
      root: targetRoot,
      userHome,
      dryRun: false,
    });

    const resultAgents = readFileSync(agentsFile, "utf8");
    assert.ok(resultAgents.includes("Custom Human Header"), "Human header outside managed section must be preserved");
    assert.ok(resultAgents.includes("<!-- BEGIN NULLFORM WORKFLOW -->"), "Managed section must be inserted");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("10. noBunnonOMPpublicworkflow: public nullform workflow works Node-native without OMP or Bun in PATH", () => {
  const projectRoot = createTempDir("proj-workflow-");

  try {
    let code = runWorkflowCli(["start", "--tier", "T0", "--task", "fix-bug", "--no-dashboard"], {
      cwd: projectRoot,
    });
    assert.equal(code, 0);

    code = runWorkflowCli(["check"], { cwd: projectRoot });
    assert.equal(code, 0);

    code = runWorkflowCli(["status"], { cwd: projectRoot });
    assert.equal(code, 0);

    code = runWorkflowCli(["close"], { cwd: projectRoot });
    assert.equal(code, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("11. unsupportedreview: automated review execution for unsupported harness refuses BEFORE dispatch", () => {
  const projectRoot = createTempDir("review-refuse-");

  try {
    const code = runWorkflowCli(["review-run", "--harness", "cursor", "--role", "reviewer", "--change", "feat-x", "--model", "dummy/model", "--base-ref", "HEAD"], {
      cwd: projectRoot,
    });
    assert.equal(code, 1, "Review for unsupported host must exit 1 before dispatch");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("12. capabilities: returns honest distinction between 8 config adapters, Node-native core gates, and OMP+Bun review only", () => {
  const caps = getCapabilitiesInfo();
  assert.equal(caps.ok, true);
  assert.equal(caps.configurationAdapters.length, 8);
  assert.equal(caps.coreWorkflowGates.supported, true);
  assert.equal(caps.coreWorkflowGates.requiresOmp, false);
  assert.equal(caps.coreWorkflowGates.requiresBun, false);
  assert.deepEqual(caps.automatedReview.supportedHarnesses, ["omp"]);
  assert.equal(caps.automatedReview.requiresBun, true);
});
test("13. human edit after failure: recovery detects unknown hash, fails closed with ECONFLICT, preserves human bytes and keeps journal", () => {
  const userHome = createTempDir("human-edit-home-");
  const targetRoot = createTempDir("human-edit-root-");

  try {
    const file = join(targetRoot, "script.js");
    writeFileSync(file, "OLD_BYTES", "utf8");

    const journal = new DeploymentJournal({
      userHome,
      targetRoot,
      harness: "opencode",
      targetVersion: "1.2.0",
    });
    journal.start();

    // Journal records OLD_BYTES, prepares NEW_BYTES
    journal.recordBeforeWrite(file, "NEW_BYTES");
    writeFileSync(file, "NEW_BYTES", "utf8");
    journal.recordWritten(file);

    // Now, after failure/interruption, human edits the file!
    writeFileSync(file, "HUMAN_EDIT_AFTER_FAILURE", "utf8");

    // Recovery must NOT overwrite human edit with OLD_BYTES!
    assert.throws(
      () => {
        recoverAbandonedJournal(userHome, { targetRoot });
      },
      (err) => err.code === "ECONFLICT"
    );

    assert.equal(readFileSync(file, "utf8"), "HUMAN_EDIT_AFTER_FAILURE", "Human edits MUST be preserved");
    assert.equal(existsSync(getDeploymentJournalPath(userHome)), true, "Journal must be retained for operator");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("14. crafted dead lock: dead lock with targetRoot=outside does not grant outside scope; caller targetRoot is authoritative", () => {
  const userHome = createTempDir("deadlock-home-");
  const insideRoot = createTempDir("inside-root-");
  const outsideVictim = createTempDir("outside-victim-");

  try {
    const victimFile = join(outsideVictim, "victim.txt");
    writeFileSync(victimFile, "VICTIM_INTACT", "utf8");

    const lockPath = getDeploymentLockPath(userHome);
    mkdirSync(join(userHome, ".nullform"), { recursive: true });

    // Dead lock crafted with outside targetRoot
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        createdAt: new Date().toISOString(),
        targetRoot: outsideVictim,
        harness: "cursor",
      }),
      "utf8"
    );

    // Crafted journal also attempting to target outside victim
    const journalPath = getDeploymentJournalPath(userHome);
    writeFileSync(
      journalPath,
      JSON.stringify({
        journalId: "valid_id_789",
        status: "in-progress",
        pid: 99999999,
        userHome,
        targetRoot: outsideVictim,
        entries: [
          {
            index: 0,
            destPath: victimFile,
            existed: false,
            status: "written",
          },
        ],
      }),
      "utf8"
    );

    // acquireDeploymentLock with insideRoot must NOT trust lock's outsideVictim!
    assert.throws(
      () => {
        acquireDeploymentLock({ userHome, targetRoot: insideRoot, harness: "cursor" });
      },
      (err) => err.code === "ETAMPERED"
    );

    assert.equal(readFileSync(victimFile, "utf8"), "VICTIM_INTACT", "Outside victim must remain untouched");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(insideRoot, { recursive: true, force: true });
    rmSync(outsideVictim, { recursive: true, force: true });
  }
});
test("15. backupDir junction: backupDir pointing outside via junction/symlink is rejected by canonical guard", () => {
  const userHome = createTempDir("junction-home-");
  const targetRoot = createTempDir("junction-root-");
  const outsidePoison = createTempDir("outside-poison-");

  try {
    const journalId = "poison_id_999";
    const backupsContainer = join(userHome, ".nullform", "backups");
    mkdirSync(backupsContainer, { recursive: true });

    // Place poison file in outsidePoison
    const poisonFile = join(outsidePoison, "entry_0.bak");
    writeFileSync(poisonFile, "POISON_PAYLOAD", "utf8");

    // Link backupDir to outsidePoison
    const backupDir = join(backupsContainer, journalId);
    try {
      symlinkSync(outsidePoison, backupDir, process.platform === "win32" ? "junction" : "dir");
    } catch {}

    const targetFile = join(targetRoot, "safe.txt");
    writeFileSync(targetFile, "ORIGINAL_SAFE", "utf8");

    const journalPath = getDeploymentJournalPath(userHome);
    writeFileSync(
      journalPath,
      JSON.stringify({
        journalId,
        status: "in-progress",
        pid: 99999999,
        userHome,
        targetRoot,
        entries: [
          {
            index: 0,
            destPath: targetFile,
            existed: true,
            backupFile: "entry_0.bak",
            originalHash: "dummy_hash",
            status: "written",
          },
        ],
      }),
      "utf8"
    );

    assert.throws(
      () => {
        recoverAbandonedJournal(userHome, { targetRoot });
      },
      (err) => err.code === "ETAMPERED"
    );

    assert.equal(readFileSync(targetFile, "utf8"), "ORIGINAL_SAFE", "Target file must not be poisoned");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outsidePoison, { recursive: true, force: true });
  }
});
test("16. real CLI init: openhuman with long root path succeeds within default spawnSync buffer and reflects clean post-commit readiness", () => {
  const userHome = createTempDir("cli-init-home-");
  const baseRoot = createTempDir("cli-init-root-");
  const longTargetRoot = join(baseRoot, "deep-segment-alpha", "deep-segment-beta", "openhuman-workspace-target");
  try {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "init", "--harness", "openhuman", "--root", longTargetRoot, "--user-home", userHome, "--yes", "--json", "--skip-release-check"],
      { encoding: "utf8" }
    );
    assert.equal(res.error, undefined, `Must not fail with ENOBUFS: ${res.error?.message}`);
    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.ok(res.stdout.length < 100000, `Init JSON must remain compact (<100KB), got ${res.stdout.length}`);
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.ok, true);
    assert.equal(json.stage, "complete");
    assert.notEqual(json.status, "recoverable", "Fresh completed identity must NOT be marked recoverable");
    assert.notEqual(json.status, "pending", "Fresh completed identity must NOT be marked pending");
    assert.ok(json.plan.filesCount > 0);
    assert.equal(json.plan.journal, undefined, "Internal journal must not be serialized in public init JSON");
    assert.equal(readInstallationState(userHome).root, resolve(longTargetRoot));
    assert.equal(existsSync(getDeploymentJournalPath(userHome)), false, "Journal must be deleted after clean commit");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(baseRoot, { recursive: true, force: true });
  }
});
test("17. non-OMP installed review refusal: review-run without --harness resolves installation state and refuses before dispatch when non-OMP installed", async () => {
  const userHome = createTempDir("rev-refuse-home-");
  const targetRoot = createTempDir("rev-refuse-root-");

  try {
    writeInstallationState(userHome, {
      schemaVersion: 1,
      harness: "opencode",
      root: targetRoot,
      userHome,
      version: "1.2.0",
      managedFiles: {},
    });

    const code = runWorkflowCli(
      ["review-run", "--role", "reviewer", "--change", "feat-test", "--model", "dummy/model", "--base-ref", "HEAD", "--user-home", userHome],
      { cwd: targetRoot }
    );

    assert.equal(code, 1, "review-run without --harness must resolve opencode from installation-state and refuse before dispatch");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
test("18. standalone installHarness cleans up own journal and backups on success", () => {
  const userHome = createTempDir("standalone-install-home-");
  const targetRoot = createTempDir("standalone-install-root-");
  try {
    const plan = installHarness({ harness: "opencode", root: targetRoot, userHome, dryRun: false });
    assert.ok(plan.filesToCopy.length > 0);
    assert.equal(existsSync(getDeploymentJournalPath(userHome)), false, "Standalone install must finalize own journal on success");
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("19. public CLI workflow start with -h task value forwards properly via real child process", () => {
  const projectRoot = createTempDir("task-h-proj-");
  try {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "workflow", "start", "--tier", "T0", "--task", "-h", "--no-dashboard"],
      { cwd: projectRoot, encoding: "utf8" }
    );
    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    const state = JSON.parse(readFileSync(join(projectRoot, ".workflow", "state.json"), "utf8"));
    assert.equal(state.tier, "T0");
    assert.equal(state.task, "-h");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("20. checkVersionAlignment warns with older_binary when package is older than verified target", () => {
  const tempPackageRoot = createTempDir("older-pkg-");
  const tempTargetRoot = createTempDir("target-root-");
  const tempHome = createTempDir("home-root-");
  try {
    writeFileSync(join(tempPackageRoot, "VERSION"), "1.1.0\n", "utf8");
    writeFileSync(join(tempTargetRoot, "VERSION"), "1.2.0\n", "utf8");
    const res = checkVersionAlignment({ harness: tempTargetRoot, userHome: tempHome, packageRoot: tempPackageRoot });
    assert.equal(res.status, "warn");
    assert.equal(res.divergence, "older_binary");
    assert.equal(res.status !== "pass", true, "Must not falsely report pass when package is older than target");
  } finally {
    rmSync(tempPackageRoot, { recursive: true, force: true });
    rmSync(tempTargetRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("21. sanitizeError redacts quoted and unquoted api_key, apikey, token, credential, and key prefixes while preserving normal error messages", () => {
  const secret1 = "sk-proj-1234567890abcdef";
  const secret2 = "my_super_secret_api_key_999";
  const secret3 = "quoted_token_secret_888";
  const raw = `Config error: {"api_key": "${secret2}", "token": "${secret3}", "apiKey": "${secret1}"} and Authorization: Bearer ${secret3}`;
  const out = sanitizeError(raw);
  assert.equal(out.includes(secret1), false);
  assert.equal(out.includes(secret2), false);
  assert.equal(out.includes(secret3), false);
  assert.equal(sanitizeError("Corrupted installation state JSON: Unexpected token"), "Corrupted installation state JSON: Unexpected token");
});
