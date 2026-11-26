/**
 * tools/pack-install.mjs — Harness-agnostic install pack deployment engine.
 * Confines destination paths, manages deployment locking and journals,
 * copies allow-listed modules, integrates target harness adapters,
 * executes post-install verification and doctor checks, and records receipts.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { loadPack } from "./pack-format.mjs";
import { CONCRETE_HARNESSES } from "./installation/state.mjs";
import {
  acquireDeploymentLock,
  releaseDeploymentLock,
  DeploymentJournal,
  safeAtomicWrite,
} from "./installation/journal.mjs";
import { applyHarnessAdapter } from "./installation/adapters.mjs";
import { validatePathWithinScope } from "./worktree-snapshot.mjs";
import { runDoctor } from "./doctor.mjs";

/**
 * Returns canonical receipt path for an installed pack.
 * @param {string} targetRoot - Destination root
 * @param {string} packName - Pack manifest name
 * @returns {string} Absolute path to pack receipt JSON
 */
export function getPackReceiptPath(targetRoot, packName) {
  return join(targetRoot, ".nullform", "packs", `${packName}.json`);
}

/**
 * Validates high-level input options for pack installation.
 * @param {object} options
 */
function validateInstallOptions(options) {
  if (!options || typeof options !== "object") {
    throw new Error("workflow pack: options must be an object");
  }
  if (!options.packDir || typeof options.packDir !== "string" || !options.packDir.trim()) {
    throw new Error("workflow pack: pack directory is required");
  }
  if (!options.root || typeof options.root !== "string" || !options.root.trim()) {
    throw new Error("workflow pack: target root is required");
  }
  if (!options.harness || typeof options.harness !== "string" || !options.harness.trim()) {
    throw new Error("workflow pack: harness is required");
  }
  if (!CONCRETE_HARNESSES.includes(options.harness)) {
    throw new Error(
      `workflow pack: unknown harness '${options.harness}', expected one of: ${CONCRETE_HARNESSES.join(", ")}`
    );
  }
}

/**
 * Ensures all file paths stay confined within the target root and do not escape via junctions/symlinks.
 * @param {string} targetRoot - Absolute target root path
 * @param {Array<{ path: string }>} files - Allow-listed pack files
 */
function verifyTargetConfinement(targetRoot, files) {
  for (const file of files) {
    const destPath = resolve(targetRoot, file.path);
    const rel = relative(targetRoot, destPath);
    if (rel.startsWith("..") || isAbsolute(rel) || destPath === targetRoot) {
      throw new Error(`workflow pack: file path '${file.path}' resolves outside target root`);
    }
    if (!validatePathWithinScope(destPath, targetRoot)) {
      throw new Error(`workflow pack: file path '${file.path}' resolves outside target root`);
    }
  }
}

/**
 * Checks if an identical pack version is already installed in target root.
 * @param {string} receiptPath - Path to pack receipt
 * @param {object} manifest - Pack manifest
 * @param {string} harness - Target harness
 * @param {string} packHash - Pack manifest SHA-256
 * @param {string} targetRoot - Target root path
 * @returns {object|null} Previous receipt if already installed, otherwise null
 */
function checkExistingReceipt(receiptPath, manifest, harness, packHash, targetRoot) {
  if (!existsSync(receiptPath)) return null;
  try {
    const prev = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (
      prev &&
      prev.name === manifest.name &&
      prev.version === manifest.version &&
      prev.harness === harness
    ) {
      return {
        name: manifest.name,
        version: manifest.version,
        hash: prev.hash || packHash,
        harness,
        root: targetRoot,
        installedAt: prev.installedAt || new Date().toISOString(),
        files: prev.files || manifest.files.map((f) => f.path),
        status: "already installed",
        receiptPath,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Copies all allow-listed files into target root under journal recording.
 * @param {object} params
 */
function copyAllowlistedModules({ files, targetRoot, journal }) {
  for (const file of files) {
    const destPath = resolve(targetRoot, file.path);
    const content = readFileSync(file.fullPath);
    journal.recordBeforeWrite(destPath, content);
    mkdirSync(dirname(destPath), { recursive: true });
    safeAtomicWrite(destPath, content);
    journal.recordWritten(destPath, file.sha256);
  }
}

/**
 * Applies target harness adapter target paths under journal recording.
 * @param {object} params
 */
function applyAdapterTargetPaths({ harness, targetRoot, home, journal }) {
  const slashRoot = targetRoot.replace(/\\/g, "/");
  const adapterCtx = {
    targetRoot,
    projectRoot: targetRoot,
    slashRoot,
    userHome: home,
    hostHome: home,
    shouldWriteHome: false,
    report: { notes: [] },
    plan: { adapters: [], managedFiles: {}, warnings: [] },
    writeAdapter: (filePath, content) => {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(buf).digest("hex");
      journal.recordBeforeWrite(filePath, content);
      mkdirSync(dirname(filePath), { recursive: true });
      safeAtomicWrite(filePath, content, "utf8");
      journal.recordWritten(filePath, hash);
    },
    readExisting: (p) => (existsSync(p) ? readFileSync(p, "utf8") : ""),
    hermesActivation: { activation: { status: "ready" }, writes: [], warnings: [] },
  };
  applyHarnessAdapter(harness, adapterCtx);
}

/**
 * Executes the post-install tests entrypoint script.
 * @param {object} params
 */
function runTestScript({ packDir, targetRoot, harness, home, testsEntry, testTimeoutMs }) {
  const fullTestPath = resolve(packDir, testsEntry);
  const testResult = spawnSync(process.execPath, [fullTestPath], {
    cwd: targetRoot,
    timeout: testTimeoutMs,
    env: {
      ...process.env,
      HARNESS: harness,
      TARGET_ROOT: targetRoot,
      PACK_DIR: packDir,
      NULLFORM_USER_HOME: home,
    },
    encoding: "utf8",
    windowsHide: true,
  });

  if (testResult.error) {
    throw new Error(`workflow pack: post-install test execution error: ${testResult.error.message}`);
  }
  if (testResult.status !== 0) {
    const detail = (testResult.stderr || testResult.stdout || "").trim().slice(0, 500);
    throw new Error(`workflow pack: post-install test failed with exit code ${testResult.status}: ${detail}`);
  }
}

/**
 * Runs the subset of doctor checks declared in the pack manifest.
 * @param {object} params
 */
function runDoctorSubsetChecks({ targetRoot, harness, home, doctorSubset }) {
  if (!doctorSubset || doctorSubset.length === 0) return;
  const doctorResult = runDoctor({
    harness: targetRoot,
    targetHarness: harness,
    userHome: home,
  });
  const failed = (doctorResult.checks || []).filter(
    (c) => doctorSubset.includes(c.id) && c.status === "fail"
  );
  if (failed.length > 0) {
    const names = failed.map((c) => `${c.id} (${c.detail || "failed"})`).join("; ");
    throw new Error(`workflow pack: doctor check failed: ${names}`);
  }
}

/**
 * Runs post-install verification test entrypoint and declared doctor subset.
 * @param {object} params
 */
function verifyIntegration({ packDir, targetRoot, harness, home, manifest, testTimeoutMs = 30000 }) {
  const testsEntry = manifest.testsEntry || (typeof manifest.tests === "string" ? manifest.tests : (manifest.tests?.entrypoint || "tests/index.test.mjs"));
  runTestScript({ packDir, targetRoot, harness, home, testsEntry, testTimeoutMs });

  const doctorSubset = Array.isArray(manifest.doctor)
    ? manifest.doctor
    : (Array.isArray(manifest.doctorSubset) ? manifest.doctorSubset : (Array.isArray(manifest.doctorChecks) ? manifest.doctorChecks : null));
  runDoctorSubsetChecks({ targetRoot, harness, home, doctorSubset });
}

/**
 * Records receipt of the installed pack under the target root.
 * @param {object} params
 * @returns {string} Path to written receipt
 */
function recordReceipt({ journal, targetRoot, receipt }) {
  const receiptDir = join(targetRoot, ".nullform", "packs");
  const receiptPath = join(receiptDir, `${receipt.name}.json`);
  const content = JSON.stringify(receipt, null, 2) + "\n";
  const hash = createHash("sha256").update(content).digest("hex");

  journal.recordBeforeWrite(receiptPath, content);
  mkdirSync(receiptDir, { recursive: true });
  safeAtomicWrite(receiptPath, content, "utf8");
  journal.recordWritten(receiptPath, hash);
  return receiptPath;
}

/**
 * Executes the file copies, adapter wiring, verification, and receipt commit.
 * @param {object} params
 * @returns {object} Receipt
 */
function executeInstallTransaction({ files, targetRoot, harness, home, manifest, packDir, testTimeoutMs, journal, packHash }) {
  copyAllowlistedModules({ files, targetRoot, journal });
  applyAdapterTargetPaths({ harness, targetRoot, home, journal });
  journal.endBatch();

  verifyIntegration({ packDir, targetRoot, harness, home, manifest, testTimeoutMs });

  const receipt = {
    name: manifest.name,
    version: manifest.version,
    hash: packHash,
    harness,
    root: targetRoot,
    installedAt: new Date().toISOString(),
    files: files.map((f) => f.path),
    status: "installed",
  };

  recordReceipt({ journal, targetRoot, receipt });
  journal.finalize();
  return receipt;
}

/**
 * Handles rollback and rollbackPointer recording on installation failure.
 * @param {Error} err
 * @param {DeploymentJournal|null} journal
 * @param {boolean} shouldRollback
 */
function handleInstallFailure(err, journal, shouldRollback) {
  if (journal && !journal.committed) {
    err.rollbackPointer = {
      journalId: journal.journalId,
      backupDir: journal.backupDir,
      journalPath: journal.journalPath,
    };
    if (shouldRollback) {
      try {
        journal.rollback(err.message);
      } catch {}
    }
  }
}

/**
 * Installs a harness-agnostic install pack into a target harness.
 *
 * @param {object} options
 * @param {string} options.packDir - Directory containing the pack
 * @param {string} options.harness - Concrete target harness name
 * @param {string} options.root - Target installation root directory
 * @param {boolean} [options.dryRun=false] - Preview only without modifications
 * @param {string} [options.userHome] - User home directory override
 * @param {number} [options.testTimeoutMs=30000] - Test timeout in milliseconds
 * @param {boolean} [options.rollback=true] - Rollback on verification failure
 * @returns {Promise<object>} Installation receipt
 */
export async function installPack(options = {}) {
  validateInstallOptions(options);

  const packDir = resolve(options.packDir);
  const targetRoot = resolve(options.root);
  const harness = options.harness;
  const home = options.userHome
    ? resolve(options.userHome)
    : (process.env.NULLFORM_USER_HOME ? resolve(process.env.NULLFORM_USER_HOME) : homedir());

  const { manifest, files } = loadPack(packDir);
  if (!manifest.targets.includes(harness) && !manifest.targets.includes("*")) {
    throw new Error(
      `workflow pack: harness '${harness}' not supported by pack '${manifest.name}' (targets: ${manifest.targets.join(", ")})`
    );
  }

  verifyTargetConfinement(targetRoot, files);

  const manifestRaw = readFileSync(join(packDir, "pack.json"), "utf8");
  const packHash = createHash("sha256").update(manifestRaw).digest("hex");
  const receiptPath = getPackReceiptPath(targetRoot, manifest.name);

  const existingReceipt = checkExistingReceipt(receiptPath, manifest, harness, packHash, targetRoot);
  if (existingReceipt) return existingReceipt;

  if (options.dryRun) {
    return {
      dryRun: true,
      name: manifest.name,
      version: manifest.version,
      hash: packHash,
      harness,
      root: targetRoot,
      files: files.map((f) => f.path),
      status: "dry-run",
    };
  }

  let lock = null;
  let journal = null;

  try {
    lock = acquireDeploymentLock({ userHome: home, targetRoot, harness, dryRun: false });
    journal = new DeploymentJournal({ userHome: home, targetRoot, harness, targetVersion: manifest.version, dryRun: false });
    journal.start();
    journal.beginBatch();

    return executeInstallTransaction({
      files,
      targetRoot,
      harness,
      home,
      manifest,
      packDir,
      testTimeoutMs: options.testTimeoutMs || 30000,
      journal,
      packHash,
    });
  } catch (err) {
    handleInstallFailure(err, journal, options.rollback !== false);
    throw err;
  } finally {
    if (lock) {
      try {
        releaseDeploymentLock(home, process.pid);
      } catch {}
    }
  }
}
