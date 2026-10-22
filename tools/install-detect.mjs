#!/usr/bin/env node
/**
 * tools/install-detect.mjs — Smart installation, version, upgrade, and conflict detection.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { readInstallationState, parseSemVer, compareSemVer, getStateFilePath } from "./installation/state.mjs";

/**
 * Detect conflicts with foreign workflows (.autopilot, foreign skills catalogues, foreign CLAUDE.md routes).
 * NEVER deletes or moves anything. Returns list of conflict descriptors.
 *
 * @param {string} root - Directory to check for conflicts
 * @returns {Array<{ marker: string, path: string, advice: string }>}
 */
export function detectConflicts(root = ".") {
  const targetDir = resolve(root);
  const conflicts = [];

  // 1. .autopilot/ directory
  const apPath = join(targetDir, ".autopilot");
  if (existsSync(apPath)) {
    conflicts.push({
      marker: ".autopilot",
      path: apPath,
      advice: `Conflict with foreign workflow .autopilot found at ${apPath}. Remove with: rm -rf "${apPath}" (Unix) or rmdir /s /q "${apPath}" (Windows).`,
    });
  }

  // 2. Foreign skills directories
  const foreignSkillsDirs = [
    { marker: ".skills", path: join(targetDir, ".skills") },
    { marker: "skills/autopilot", path: join(targetDir, "skills", "autopilot") },
    { marker: ".autopilot/skills", path: join(targetDir, ".autopilot", "skills") },
  ];

  for (const { marker, path: p } of foreignSkillsDirs) {
    if (existsSync(p)) {
      conflicts.push({
        marker,
        path: p,
        advice: `Foreign skills catalogue detected at ${p}. Remove with: rm -rf "${p}" (Unix) or rmdir /s /q "${p}" (Windows).`,
      });
    }
  }

  // Check subdirectories in skills/ for foreign markers
  const skillsDir = join(targetDir, "skills");
  if (existsSync(skillsDir)) {
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === "autopilot" || entry.name.startsWith("ap-"))) {
          const p = join(skillsDir, entry.name);
          if (!conflicts.some((c) => c.path === p)) {
            conflicts.push({
              marker: `skills/${entry.name}`,
              path: p,
              advice: `Foreign skill detected at ${p}. Remove with: rm -rf "${p}".`,
            });
          }
        }
      }
    } catch {}
  }

  // 3. Foreign CLAUDE.md routes
  const claudeCandidates = [join(targetDir, "CLAUDE.md"), join(targetDir, ".claude", "CLAUDE.md")];
  for (const claudePath of claudeCandidates) {
    if (existsSync(claudePath)) {
      try {
        const content = readFileSync(claudePath, "utf8");
        // Look for foreign routing / commands (autopilot, ap.py)
        if (/(autopilot|\.autopilot|ap\.py)/i.test(content)) {
          conflicts.push({
            marker: basename(claudePath),
            path: claudePath,
            advice: `Foreign workflow routing detected in ${claudePath}. Review and remove routing instructions: rm "${claudePath}".`,
          });
        }
      } catch {}
    }
  }

  return conflicts;
}

/**
 * Suggest upgrade if current version is older than latest.
 *
 * @param {string|null} cur - Current version
 * @param {string|null} latest - Latest available version
 * @returns {{ needed: boolean, current: string|null, latest: string|null, message: string, command: string|null, toString: () => string }}
 */
export function suggestUpgrade(cur, latest) {
  const pCur = parseSemVer(cur);
  const pLat = parseSemVer(latest);
  const needed = Boolean(pCur && pLat && compareSemVer(cur, latest) < 0);

  return {
    needed,
    current: cur || null,
    latest: latest || null,
    message: needed
      ? `Upgrade available: v${cur} -> v${latest}. Run 'nullform update' or 'nullform install' to upgrade.`
      : `Current version ${cur || "unknown"} is up to date (${latest || "unknown"}).`,
    command: needed ? "nullform update" : null,
    toString() {
      return this.message;
    },
  };
}

/**
 * Detect existing Nullform installation in user home / directory.
 * Source priority: VERSION / .harness-root / state.
 *
 * @param {string} homeDir - User home or project directory to inspect
 * @returns {{ present: boolean, version: string|null, root: string|null, conflicts: Array<{marker: string, path: string, advice: string}> }}
 */
export function detectInstall(homeDir = homedir()) {
  const targetHome = resolve(homeDir);
  let version = null;
  let root = null;
  let statePresent = false;

  // 1. Check .nullform/installation.json
  const statePath = getStateFilePath(targetHome);
  if (existsSync(statePath)) {
    statePresent = true;
    try {
      const state = readInstallationState(targetHome);
      if (state) {
        if (state.version) version = state.version;
        if (state.root) root = state.root;
      }
    } catch {
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        if (raw?.version) version = String(raw.version);
        if (raw?.root) root = String(raw.root);
      } catch {}
    }
  }

  // 2. Check .harness-root pointers
  const pointerCandidates = [
    join(targetHome, ".omp", "agent", ".harness-root"),
    join(targetHome, "agent", ".harness-root"),
    join(targetHome, ".harness-root"),
  ];

  for (const candidate of pointerCandidates) {
    if (existsSync(candidate)) {
      try {
        const pointer = readFileSync(candidate, "utf8").trim();
        if (pointer) {
          if (!root) root = pointer;
          const rootVersion = join(pointer, "VERSION");
          if (existsSync(rootVersion)) {
            const v = readFileSync(rootVersion, "utf8").trim();
            const sem = parseSemVer(v);
            if (sem) version = sem.raw;
          }
        }
      } catch {}
    }
  }

  // 3. Check direct VERSION file in targetHome or in root
  if (root && existsSync(join(root, "VERSION")) && !version) {
    try {
      const v = readFileSync(join(root, "VERSION"), "utf8").trim();
      const sem = parseSemVer(v);
      if (sem) version = sem.raw;
    } catch {}
  }

  if (existsSync(join(targetHome, "VERSION"))) {
    try {
      const v = readFileSync(join(targetHome, "VERSION"), "utf8").trim();
      const sem = parseSemVer(v);
      if (sem) {
        if (!version) version = sem.raw;
        if (!root) root = targetHome;
      }
    } catch {}
  }

  const present = Boolean(statePresent || root || version);

  // Detect conflicts across root and targetHome
  const conflictsMap = new Map();
  const searchRoots = [root, targetHome].filter(Boolean);
  for (const r of searchRoots) {
    for (const c of detectConflicts(r)) {
      conflictsMap.set(c.path, c);
    }
  }

  return {
    present,
    version: version || null,
    root: root ? resolve(root) : null,
    conflicts: Array.from(conflictsMap.values()),
  };
}
