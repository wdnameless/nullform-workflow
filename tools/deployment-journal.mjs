/**
 * tools/deployment-journal.mjs — Recoverable deployment journals, exclusive locking,
 * atomic identity, and scoped backup/rollback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync, lstatSync, readlinkSync, symlinkSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { resolve, join, dirname, isAbsolute, basename } from "node:path";
import { hashContent } from "./harness-config.mjs";
import { writeInstallationState, readInstallationState } from "./installation-state.mjs";
import { normalizePath, validatePathWithinScope } from "./worktree-snapshot.mjs";
import { resolveHostHome } from "./harness-profiles.mjs";
import { restoreSingleEntry } from "./deployment-restore.mjs";

function selectedHostScope(hostHome, userHome, harness = "custom") {
  if (hostHome === undefined || hostHome === null) return null;
  if (typeof hostHome !== "string" || hostHome.length > 4096 || !isAbsolute(hostHome) || /[\x00-\x1f\x7f]/.test(hostHome)) {
    throw new Error("Invalid selected hostHome: expected a bounded absolute path");
  }
  const path = normalizePath(resolveHostHome({ harness: harness === "all" ? "hermes" : harness, userHome, hostHome }).path);
  if (path !== normalizePath(resolve(path))) {
    throw Object.assign(new Error("Selected hostHome is not normalized"), { code: "ESCOPE" });
  }
  return path;
}
/**
 * Validated multi-home write scope for harness=all installs. Accepts a single
 * path, an array, or a harness->path map; every entry is validated exactly
 * like a single selected hostHome. Fail-closed: invalid entries throw.
 */
function selectedHostScopes(hostHomes, userHome, harness = "custom") {
  if (hostHomes === undefined || hostHomes === null) return [];
  const list = Array.isArray(hostHomes)
    ? hostHomes
    : (typeof hostHomes === "object" ? Object.values(hostHomes) : [hostHomes]);
  const out = [];
  for (const home of list) {
    if (home === undefined || home === null) continue;
    const scope = selectedHostScope(home, userHome, harness);
    if (scope && !out.includes(scope)) out.push(scope);
  }
  return out.sort();
}

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
    // Keep the old destination discoverable if atomic replacement fails.
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function acquireDeploymentLock({
  userHome,
  targetRoot,
  harness,
  projectRoot = null,
  hostHome = null,
  hostHomes = null,
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
  const hostScopes = selectedHostScopes(hostHomes ?? hostHome, normHome, harness);
  const hostScope = hostScopes[0] ?? null;
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
    recoverAbandonedJournal(normHome, { targetRoot: normTarget, projectRoot, hostHome: hostScope, hostHomes: hostScopes, harness });

    try {
      unlinkSync(lockPath);
    } catch {}
  }
  const journalPath = getDeploymentJournalPath(normHome);
  if (existsSync(journalPath)) {
    let pending;
    try { pending = JSON.parse(readFileSync(journalPath, "utf8")); }
    catch { throw Object.assign(new Error("Corrupted deployment journal; recovery requires operator inspection"), { code: "ECORRUPT_JOURNAL" }); }
    if (!isProcessAlive(pending.pid).verifiedDead) {
      throw Object.assign(new Error("Deployment journal owner is live or uncertain; refusing concurrent recovery"), { code: "ELOCKED" });
    }
    recoverAbandonedJournal(normHome, { targetRoot: normTarget, projectRoot, hostHome: hostScope, hostHomes: hostScopes, harness });
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
export class DeploymentJournal {
  constructor({ userHome, targetRoot, projectRoot = null, hostHome = null, hostHomes = null, harness, targetVersion, dryRun = false }) {
    this.userHome = normalizePath(resolve(userHome));
    this.targetRoot = normalizePath(resolve(targetRoot));
    this.projectRoot = projectRoot ? normalizePath(resolve(projectRoot)) : null;
    this.hostHomes = selectedHostScopes(hostHomes ?? hostHome, this.userHome, harness);
    this.hostHome = this.hostHomes[0] ?? null;
    this.harness = harness;
    this.targetVersion = targetVersion;
    this.dryRun = Boolean(dryRun);
    this.journalId = `journal_${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    this.journalPath = getDeploymentJournalPath(this.userHome);
    this.backupDir = getDeploymentBackupDir(this.userHome, this.journalId);
    this.allowedScopes = [this.targetRoot, this.userHome];
    if (this.projectRoot) this.allowedScopes.push(this.projectRoot);
    for (const scope of this.hostHomes) this.allowedScopes.push(scope);
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
      hostHome: this.hostHome,
      hostHomes: this.hostHomes,
      harness: this.harness,
      targetVersion: this.targetVersion,
      entries: this.entries,
    };
    safeAtomicWrite(this.journalPath, JSON.stringify(payload, null, 2) + "\n");
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

  rollback(_reason = "") {
    if (this.dryRun || this.committed) return;
    this.status = "rolling-back";
    const entriesToRevert = this.entries.slice().reverse();

    for (const entry of entriesToRevert) {
      restoreSingleEntry(entry, this.backupDir, this.allowedScopes, safeAtomicWrite);
    }

    this.status = "rolled-back";
    this.flush();
    try {
      rmSync(this.backupDir, { recursive: true, force: true });
    } catch {}
    try {
      unlinkSync(this.journalPath);
    } catch {}
  }

  finalize() {
    if (this.dryRun) return;
    const previousStatus = this.status;
    this.status = "committed";
    try {
      this.flush();
    } catch (err) {
      this.status = previousStatus;
      throw err;
    }
    this.committed = true;
    try { rmSync(this.backupDir, { recursive: true, force: true }); } catch {}
    try { unlinkSync(this.journalPath); } catch {}
  }

  commit(verifiedState) {
    if (this.dryRun) return;
    try {
      writeInstallationState(this.userHome, verifiedState, { journal: this });
      this.finalize();
    } catch (err) {
      this.rollback(err.message);
      throw err;
    }
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
    if (savedState?.hostHome) trustedScopes.push(selectedHostScope(savedState.hostHome, normHome, savedState.harness));
  } catch {}

  if (options.targetRoot && typeof options.targetRoot === "string") {
    trustedScopes.push(normalizePath(options.targetRoot));
  }
  if (options.projectRoot && typeof options.projectRoot === "string") {
    trustedScopes.push(normalizePath(options.projectRoot));
  }
  const callerScopes = selectedHostScopes(options.hostHomes ?? options.hostHome, normHome, options.harness);
  for (const scope of callerScopes) trustedScopes.push(scope);

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

  // The interrupted journal's own host set must exactly match the caller's or
  // the validated saved identity's set. Pre-feature journals without hostHomes
  // fall back to their single legacy hostHome. Any mismatch fails ESCOPE so an
  // arbitrary caller home cannot authorize recovery of another profile set.
  let journalScopes = null;
  try {
    journalScopes = ("hostHomes" in journal)
      ? selectedHostScopes(journal.hostHomes, normHome, journal.harness)
      : (journal.hostHome === undefined || journal.hostHome === null
        ? null
        : [selectedHostScope(journal.hostHome, normHome, journal.harness)]);
  } catch {
    const err = new Error("Tampered journal detected: invalid journal host scope");
    err.code = "ETAMPERED";
    throw err;
  }
  if (journalScopes !== null && !("hostHomes" in journal) && journal.hostHome !== undefined && journal.hostHome !== null) {
    const normJournalHost = normalizePath(journal.hostHome);
    if (journalScopes[0] !== normJournalHost) {
      const err = new Error("Tampered journal detected: journal hostHome is not normalized");
      err.code = "ETAMPERED";
      throw err;
    }
  }
  if (journalScopes !== null) {
    const savedScopes = (() => {
      try {
        const savedState = readInstallationState(normHome);
        if (!savedState?.hostHome) return null;
        return [selectedHostScope(savedState.hostHome, normHome, savedState.harness)];
      } catch { return null; }
    })();
    const matches = (candidate) => candidate !== null &&
      candidate.length === journalScopes.length &&
      candidate.every((scope) => journalScopes.includes(scope));
    if (!matches(callerScopes) && !matches(savedScopes)) {
      const claimed = callerScopes.length > 0 || savedScopes !== null;
      const err = claimed
        ? new Error("Recovery refused: journal host scope does not match the caller-selected or validated saved profile set")
        : new Error(`Tampered journal detected: journal host scope "${journalScopes[0] ?? journal.hostHome}" escapes trusted boundaries`);
      err.code = claimed ? "ESCOPE" : "ETAMPERED";
      throw err;
    }
    for (const scope of journalScopes) {
      if (!trustedScopes.some((trusted) => validatePathWithinScope(scope, trusted))) {
        const err = new Error(`Tampered journal detected: journal host scope "${scope}" escapes trusted boundaries`);
        err.code = "ETAMPERED";
        throw err;
      }
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
  const terminal = journal.status === "committed" || journal.status === "rolled-back";
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
      if (!terminal && !existsSync(absBackup)) {
        const err = new Error(`Tampered journal detected: backupFile "${entry.backupFile}" does not exist`);
        err.code = "ETAMPERED";
        throw err;
      }
      if (!terminal && entry.originalHash) {
        const backupHash = hashContent(readFileSync(absBackup));
        if (backupHash !== entry.originalHash) {
          const err = new Error(`Tampered journal detected: backupFile hash mismatch for "${entry.backupFile}"`);
          err.code = "ETAMPERED";
          throw err;
        }
      }
    }
  }

  // Terminal decisions are durable: cleanup never needs backups that may already be deleted.
  if (!terminal) {
    const entriesToRevert = entries.slice().reverse();
    for (const entry of entriesToRevert) {
      restoreSingleEntry(entry, backupDir, trustedScopes, safeAtomicWrite);
    }
    journal.status = "rolled-back";
    safeAtomicWrite(journalPath, JSON.stringify(journal, null, 2) + "\n");
  }

  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {}
  try {
    unlinkSync(journalPath);
  } catch {}

  return { recovered: true, status: journal.status === "committed" ? "committed" : "restored" };
}
