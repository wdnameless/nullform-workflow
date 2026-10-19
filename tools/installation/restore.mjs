/**
 * tools/installation/restore.mjs — Per-entry restore from deployment backup.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { hashContent } from "./config.mjs";
import { normalizePath, validatePathWithinScope } from "../worktree-snapshot.mjs";

export function restoreSingleEntry(entry, backupDir, allowedScopes, atomicWrite) {
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
          atomicWrite(normDest, readFileSync(absBackup));
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
    atomicWrite(normDest, readFileSync(absBackup));
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
