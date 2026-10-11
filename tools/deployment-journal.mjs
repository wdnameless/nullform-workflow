/**
 * tools/deployment-journal.mjs — Recoverable deployment journals, exclusive locking,
 * atomic identity, and scoped backup/rollback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { hashContent } from "./harness-config.mjs";
import { getStateFilePath, validateInstallationState, writeInstallationState, readInstallationState, sanitizeError } from "./installation-state.mjs";
import { normalizePath, validateRootPath, validatePathWithinScope, isInsideOrEqual } from "./worktree-snapshot.mjs";

export function getDeploymentLockPath(userHome) {
  return join(normalizePath(resolve(userHome)), ".nullform", "deployment.lock");
}
export function getDeploymentJournalPath(userHome) {
  return join(normalizePath(resolve(userHome)), ".nullform", "deployment-journal.json");
}
export function getDeploymentBackupDir(userHome, journalId) {
  return join(normalizePath(resolve(userHome)), ".nullform", "backups", journalId);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, verifiedDead: false, status: "invalid_pid" };
  try {
    process.kill(pid, 0);
    return { alive: true, verifiedDead: false, status: "live" };
  } catch (err) {
    if (err.code === "ESRCH") return { alive: false, verifiedDead: true, status: "dead" };
    return { alive: true, verifiedDead: false, status: "uncertain" };
  }
}

export function safeAtomicWrite(destPath, content, encoding = "utf8") {
  const normDest = normalizePath(resolve(destPath));
  const dir = dirname(normDest);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.tmp.${basename(normDest)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

  const fd = openSync(tmpPath, "w");
  try {
    if (typeof content === "string") {
      writeSync(fd, content, 0, encoding);
    } else {
      writeSync(fd, content);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, normDest);
  } catch (err) {
    if (process.platform === "win32") {
      const bakPath = join(dir, `.bak.${basename(normDest)}.${Date.now()}`);
      let renamedExisting = false;
      try {
        if (existsSync(normDest)) {
          renameSync(normDest, bakPath);
          renamedExisting = true;
        }
        renameSync(tmpPath, normDest);
        if (renamedExisting) {
          try { unlinkSync(bakPath); } catch {}
        }
      } catch (replaceErr) {
        if (renamedExisting && existsSync(bakPath)) {
          try { renameSync(bakPath, normDest); } catch {}
        }
        try { unlinkSync(tmpPath); } catch {}
        throw replaceErr;
      }
    } else {
      try { unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }
}

export function acquireDeploymentLock({
  userHome,
  targetRoot,
  harness,
  dryRun = false,
} = {}) {
  if (dryRun) {
    return {
      lockPath: null,
      lockId: null,
      acquired: true,
      dryRun: true,
      release() {},
    };
  }

  const normHome = normalizePath(resolve(userHome));
  const normTarget = normalizePath(resolve(targetRoot));
  const lockPath = getDeploymentLockPath(normHome);
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      const err = new Error(`Lock file at ${lockPath} is corrupt or unreadable; owner is uncertain`);
      err.code = "ELOCKED";
      throw err;
    }

    const pid = existing?.pid;
    const probe = isProcessAlive(pid);

    if (!probe.verifiedDead) {
      const err = new Error(
        `Active deployment lock held by PID ${pid} (${probe.status}) for ${existing?.targetRoot || normTarget}`
      );
      err.code = "ELOCKED";
      err.lock = existing;
      throw err;
    }

    // Process is verified dead (ESRCH): recover abandoned journal with ONLY trusted scopes (caller + last verified)
    try {
      recoverAbandonedJournal(normHome, { targetRoot: normTarget });
    } catch (recErr) {
      if (recErr.code === "ETAMPERED" || recErr.code === "ECONFLICT") throw recErr;
    }

    try {
      unlinkSync(lockPath);
    } catch {}
  }

  const lockData = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    targetRoot: normTarget,
    harness: harness || "unknown",
  };

  try {
    writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n", {
      flag: "wx",
      encoding: "utf8",
    });
  } catch (err) {
    if (err.code === "EEXIST") {
      const errLocked = new Error(`Concurrent deployment lock collision at ${lockPath}`);
      errLocked.code = "ELOCKED";
      throw errLocked;
    }
    throw err;
  }

  return {
    lockPath,
    lockId: process.pid,
    acquired: true,
    dryRun: false,
    release() {
      releaseDeploymentLock(normHome, process.pid);
    },
  };
}

export function releaseDeploymentLock(userHome, expectedPid = null) {
  try {
    const normHome = normalizePath(resolve(userHome));
    const lockPath = getDeploymentLockPath(normHome);
    if (!existsSync(lockPath)) return;
    if (expectedPid !== null) {
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8"));
        if (existing.pid !== expectedPid) return;
      } catch {}
    }
    unlinkSync(lockPath);
  } catch {}
}

function restoreSingleEntry(entry, userHome, backupDir, allowedScopes) {
  const normDest = normalizePath(entry.destPath);
  const isDestSafe = allowedScopes.some((scope) => validatePathWithinScope(normDest, scope));
  if (!isDestSafe) {
    const err = new Error(`Restore refused: destination "${entry.destPath}" escapes allowed scopes`);
    err.code = "ETAMPERED";
    throw err;
  }

  if (entry.action === "symlink") {
    if (!entry.existed) {
      let isStillExpected = false;
      try {
        if (lstatSync(normDest).isSymbolicLink() && readlinkSync(normDest) === entry.newSymlinkTarget) {
          isStillExpected = true;
        }
      } catch {}
      if (isStillExpected) {
        try { unlinkSync(normDest); } catch {}
      } else if (existsSync(normDest)) {
        const err = new Error(`Restore conflict: symlink at "${entry.destPath}" has human replacement; preserving`);
        err.code = "ECONFLICT";
        throw err;
      }
    } else if (entry.symlinkTarget) {
      try { unlinkSync(normDest); } catch {}
      mkdirSync(dirname(normDest), { recursive: true });
      symlinkSync(entry.symlinkTarget, normDest, process.platform === "win32" ? "junction" : "dir");
    }
    return;
  }

  if (entry.action === "unlink") {
    if (entry.existed) {
      if (entry.isSymlink && entry.symlinkTarget) {
        mkdirSync(dirname(normDest), { recursive: true });
        symlinkSync(entry.symlinkTarget, normDest, process.platform === "win32" ? "junction" : "dir");
      } else if (entry.backupFile) {
        const absBackup = resolve(backupDir, entry.backupFile);
        if (existsSync(absBackup)) {
          mkdirSync(dirname(normDest), { recursive: true });
          copyFileSync(absBackup, normDest);
        }
      }
    }
    return;
  }

  // Standard file write/copy entry
  if (entry.existed && entry.backupFile) {
    const absBackup = resolve(backupDir, entry.backupFile);
    if (!existsSync(absBackup)) {
      const err = new Error(`Restore error: backup file "${entry.backupFile}" missing; aborting`);
      err.code = "EMISSING_BACKUP";
      throw err;
    }

    if (existsSync(normDest)) {
      const currentBytes = readFileSync(normDest);
      const currentHash = hashContent(currentBytes);
      if (currentHash === entry.originalHash) {
        return; // Already in original state
      }
      if (entry.newHash && currentHash !== entry.newHash) {
        const err = new Error(
          `Restore conflict: destination "${entry.destPath}" modified with human edits after failure; fail-closed`
        );
        err.code = "ECONFLICT";
        throw err;
      }
    }

    mkdirSync(dirname(normDest), { recursive: true });
    copyFileSync(absBackup, normDest);
  } else if (!entry.existed) {
    if (existsSync(normDest)) {
      const currentBytes = readFileSync(normDest);
      const currentHash = hashContent(currentBytes);
      if (entry.newHash && currentHash !== entry.newHash) {
        const err = new Error(
          `Restore conflict: new file at "${entry.destPath}" contains human edits; preserving`
        );
        err.code = "ECONFLICT";
        throw err;
      }
      try {
        unlinkSync(normDest);
      } catch {}
    }
  }
}

export class DeploymentJournal {
  constructor({ userHome, targetRoot, projectRoot = null, harness, targetVersion, dryRun = false, extraScopes = [] }) {
    this.userHome = normalizePath(resolve(userHome));
    this.targetRoot = normalizePath(resolve(targetRoot));
    this.projectRoot = projectRoot ? normalizePath(resolve(projectRoot)) : null;
    this.harness = harness;
    this.targetVersion = targetVersion;
    this.dryRun = Boolean(dryRun);
    this.journalId = `journal_${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    this.journalPath = getDeploymentJournalPath(this.userHome);
    this.backupDir = getDeploymentBackupDir(this.userHome, this.journalId);
    this.allowedScopes = [this.targetRoot, this.userHome];
    if (this.projectRoot) this.allowedScopes.push(this.projectRoot);
    if (resolve(this.userHome) === resolve(homedir()) && process.env.HERMES_HOME) {
      this.allowedScopes.push(normalizePath(resolve(process.env.HERMES_HOME)));
    }
    for (const s of extraScopes) if (s) this.allowedScopes.push(normalizePath(resolve(s)));
    this.entries = [];
    this.status = "in-progress";
    this.committed = false;
  }

  start() {
    if (this.dryRun) return;
    mkdirSync(dirname(this.journalPath), { recursive: true });
    mkdirSync(this.backupDir, { recursive: true });
    this.flush();
  }

  flush() {
    if (this.dryRun) return;
    const payload = {
      journalId: this.journalId,
      status: this.status,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      userHome: this.userHome,
      targetRoot: this.targetRoot,
      projectRoot: this.projectRoot,
      harness: this.harness,
      targetVersion: this.targetVersion,
      entries: this.entries,
    };
    const tmpPath = `${this.journalPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    try {
      renameSync(tmpPath, this.journalPath);
    } catch {
      try { unlinkSync(this.journalPath); } catch {}
      renameSync(tmpPath, this.journalPath);
    }
  }

  recordBeforeWrite(destPath, content) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const isSafe = this.allowedScopes.some((scope) => validatePathWithinScope(absDest, scope));
    if (!isSafe) {
      const err = new Error(`Attempted write outside allowed scopes: "${absDest}"`);
      err.code = "ESCOPE";
      throw err;
    }

    const entryIndex = this.entries.length;
    let exists = false;
    let isSymlink = false;
    let symlinkTarget = null;
    try {
      const st = lstatSync(absDest);
      exists = true;
      isSymlink = st.isSymbolicLink();
      if (isSymlink) symlinkTarget = readlinkSync(absDest);
    } catch {}

    let originalHash = null;
    let backupFile = null;

    if (exists && !isSymlink) {
      const originalBytes = readFileSync(absDest);
      originalHash = hashContent(originalBytes);
      backupFile = `entry_${entryIndex}.bak`;
      writeFileSync(join(this.backupDir, backupFile), originalBytes);
    }

    const newHash = content !== undefined ? hashContent(content) : null;
    const entry = {
      index: entryIndex,
      action: "write",
      destPath: absDest,
      existed: exists,
      isSymlink,
      symlinkTarget,
      originalHash,
      backupFile,
      newHash,
      status: "pending",
    };
    this.entries.push(entry);
    this.flush();
    return entry;
  }

  recordWritten(destPath, newHash = null) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const entry = this.entries.find((e) => e.destPath === absDest);
    if (entry) {
      entry.status = "written";
      if (newHash) entry.newHash = newHash;
      this.flush();
    }
  }

  recordBeforeUnlink(destPath) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const isSafe = this.allowedScopes.some((scope) => validatePathWithinScope(absDest, scope));
    if (!isSafe) {
      const err = new Error(`Attempted unlink outside allowed scopes: "${absDest}"`);
      err.code = "ESCOPE";
      throw err;
    }

    const entryIndex = this.entries.length;
    let exists = false;
    let isSymlink = false;
    let symlinkTarget = null;
    try {
      const st = lstatSync(absDest);
      exists = true;
      isSymlink = st.isSymbolicLink();
      if (isSymlink) symlinkTarget = readlinkSync(absDest);
    } catch {}

    let backupFile = null;
    if (exists && !isSymlink && lstatSync(absDest).isFile()) {
      backupFile = `entry_${entryIndex}.bak`;
      writeFileSync(join(this.backupDir, backupFile), readFileSync(absDest));
    }

    const entry = {
      index: entryIndex,
      action: "unlink",
      destPath: absDest,
      existed: exists,
      isSymlink,
      symlinkTarget,
      backupFile,
      status: "pending",
    };
    this.entries.push(entry);
    this.flush();
    return entry;
  }

  recordUnlinked(destPath) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const entry = this.entries.find((e) => e.destPath === absDest && e.action === "unlink");
    if (entry) {
      entry.status = "written";
      this.flush();
    }
  }

  recordBeforeSymlink(destPath, target) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const isSafe = this.allowedScopes.some((scope) => validatePathWithinScope(absDest, scope));
    if (!isSafe) {
      const err = new Error(`Attempted symlink outside allowed scopes: "${absDest}"`);
      err.code = "ESCOPE";
      throw err;
    }

    const entryIndex = this.entries.length;
    let exists = false;
    let isSymlink = false;
    let symlinkTarget = null;
    try {
      const st = lstatSync(absDest);
      exists = true;
      isSymlink = st.isSymbolicLink();
      if (isSymlink) symlinkTarget = readlinkSync(absDest);
    } catch {}

    const entry = {
      index: entryIndex,
      action: "symlink",
      destPath: absDest,
      existed: exists,
      isSymlink,
      symlinkTarget,
      newSymlinkTarget: target,
      status: "pending",
    };
    this.entries.push(entry);
    this.flush();
    return entry;
  }

  recordSymlinked(destPath) {
    if (this.dryRun) return;
    const absDest = normalizePath(resolve(destPath));
    const entry = this.entries.find((e) => e.destPath === absDest && e.action === "symlink");
    if (entry) {
      entry.status = "written";
      this.flush();
    }
  }

  rollback(reason = "") {
    if (this.dryRun || this.committed) return;
    this.status = "rolling-back";
    const entriesToRevert = this.entries.slice().reverse();

    for (const entry of entriesToRevert) {
      restoreSingleEntry(entry, this.userHome, this.backupDir, this.allowedScopes);
    }

    this.status = "rolled-back";
    try {
      rmSync(this.backupDir, { recursive: true, force: true });
    } catch {}
    try {
      unlinkSync(this.journalPath);
    } catch {}
  }

  finalize() {
    if (this.dryRun) return;
    this.status = "committed";
    this.committed = true;
    try { rmSync(this.backupDir, { recursive: true, force: true }); } catch {}
    try { unlinkSync(this.journalPath); } catch {}
  }

  commit(verifiedState) {
    if (this.dryRun) return;
    writeInstallationState(this.userHome, verifiedState);
    this.finalize();
  }
}

export function recoverAbandonedJournal(userHome, options = {}) {
  const normHome = normalizePath(resolve(userHome));
  const journalPath = getDeploymentJournalPath(normHome);
  if (!existsSync(journalPath)) return { recovered: false };

  let journal = null;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch {
    const err = new Error(`Corrupted journal at ${journalPath}; keeping quarantined for operator inspection`);
    err.code = "ECORRUPT_JOURNAL";
    throw err;
  }

  if (journal.status === "committed") {
    try { unlinkSync(journalPath); } catch {}
    return { recovered: true, status: "committed" };
  }

  // 1. Verify userHome in journal matches caller's trusted normHome
  if (!journal.userHome || normalizePath(journal.userHome) !== normHome) {
    const err = new Error(
      `Tampered journal detected: userHome "${journal.userHome}" does not match trusted userHome "${normHome}"`
    );
    err.code = "ETAMPERED";
    throw err;
  }

  // 2. Verify journalId strictly alphanumeric, no traversal
  if (!journal.journalId || typeof journal.journalId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(journal.journalId)) {
    const err = new Error(`Tampered journal detected: invalid journalId "${journal.journalId}"`);
    err.code = "ETAMPERED";
    throw err;
  }

  // 3. Establish authoritative trusted scopes (caller + validated last verified identity ONLY)
  const trustedScopes = [normHome];
  try {
    const savedState = readInstallationState(normHome);
    if (savedState?.root) trustedScopes.push(normalizePath(savedState.root));
    if (savedState?.projectRoot) trustedScopes.push(normalizePath(savedState.projectRoot));
  } catch {}

  if (options.targetRoot && typeof options.targetRoot === "string") {
    trustedScopes.push(normalizePath(options.targetRoot));
  }
  if (options.projectRoot && typeof options.projectRoot === "string") {
    trustedScopes.push(normalizePath(options.projectRoot));
  }

  // Verify journal.targetRoot is within trusted scopes (CANONICAL GUARD ONLY, NO LEXICAL FALLBACK)
  if (!journal.targetRoot || typeof journal.targetRoot !== "string") {
    const err = new Error("Tampered journal detected: missing targetRoot");
    err.code = "ETAMPERED";
    throw err;
  }
  const normJournalTarget = normalizePath(journal.targetRoot);
  const isTargetTrusted = trustedScopes.some((scope) => validatePathWithinScope(normJournalTarget, scope));
  if (!isTargetTrusted) {
    const err = new Error(
      `Tampered journal detected: journal targetRoot "${journal.targetRoot}" escapes trusted boundaries`
    );
    err.code = "ETAMPERED";
    throw err;
  }

  if (journal.projectRoot && typeof journal.projectRoot === "string") {
    const normJournalProject = normalizePath(journal.projectRoot);
    const isProjectTrusted = trustedScopes.some((scope) => validatePathWithinScope(normJournalProject, scope));
    if (!isProjectTrusted) {
      const err = new Error(
        `Tampered journal detected: journal projectRoot "${journal.projectRoot}" escapes trusted boundaries`
      );
      err.code = "ETAMPERED";
      throw err;
    }
  }

  // 4. Validate backupDir is strictly inside normHome/.nullform/backups (CANONICAL GUARD ONLY)
  const backupDir = getDeploymentBackupDir(normHome, journal.journalId);
  const backupsParent = join(normHome, ".nullform", "backups");
  if (!validatePathWithinScope(backupDir, backupsParent)) {
    const err = new Error(`Tampered journal detected: backupDir "${backupDir}" escapes backups container`);
    err.code = "ETAMPERED";
    throw err;
  }

  // 5. VALIDATE EVERY ENTRY, BACKUP FILE AND INTEGRITY BEFORE MUTATION
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  for (const entry of entries) {
    if (
      !entry.destPath ||
      typeof entry.destPath !== "string" ||
      !isAbsolute(entry.destPath) ||
      /[\x00\r\n]/.test(entry.destPath)
    ) {
      const err = new Error(`Tampered journal detected: invalid destPath "${entry.destPath}"`);
      err.code = "ETAMPERED";
      throw err;
    }
    const normDest = normalizePath(entry.destPath);
    const isDestSafe = trustedScopes.some((scope) => validatePathWithinScope(normDest, scope));
    if (!isDestSafe) {
      const err = new Error(`Tampered journal detected: path "${entry.destPath}" escapes trusted boundaries`);
      err.code = "ETAMPERED";
      throw err;
    }

    if (entry.backupFile) {
      if (
        typeof entry.backupFile !== "string" ||
        entry.backupFile.includes("..") ||
        isAbsolute(entry.backupFile) ||
        /[\x00\r\n]/.test(entry.backupFile)
      ) {
        const err = new Error(`Tampered journal detected: backupFile "${entry.backupFile}" contains path traversal`);
        err.code = "ETAMPERED";
        throw err;
      }
      const absBackup = resolve(backupDir, entry.backupFile);
      if (!validatePathWithinScope(absBackup, backupDir)) {
        const err = new Error(`Tampered journal detected: backupFile "${entry.backupFile}" escapes backup directory`);
        err.code = "ETAMPERED";
        throw err;
      }
      if (!existsSync(absBackup)) {
        const err = new Error(`Tampered journal detected: backupFile "${entry.backupFile}" does not exist`);
        err.code = "ETAMPERED";
        throw err;
      }
      if (entry.originalHash) {
        const backupHash = hashContent(readFileSync(absBackup));
        if (backupHash !== entry.originalHash) {
          const err = new Error(`Tampered journal detected: backupFile hash mismatch for "${entry.backupFile}"`);
          err.code = "ETAMPERED";
          throw err;
        }
      }
    }
  }

  // 6. ALL VALIDATIONS PASSED. Execute restoration in reverse order
  const entriesToRevert = entries.slice().reverse();
  for (const entry of entriesToRevert) {
    restoreSingleEntry(entry, normHome, backupDir, trustedScopes);
  }

  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {}
  try {
    unlinkSync(journalPath);
  } catch {}

  return { recovered: true, status: "restored" };
}
