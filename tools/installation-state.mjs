/**
 * tools/installation-state.mjs — Installation state persistence, schema validation, and SemVer utilities.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_HARNESSES } from "./install-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

export const PACKAGE_NAME = "nullform-workflow";

export const CONCRETE_HARNESSES = Object.freeze(
  SUPPORTED_HARNESSES.filter((h) => h !== "all" && h !== "auto")
);
export const HARNESS_CHOICES = CONCRETE_HARNESSES;

const ALLOWED_STATE_KEYS = new Set([
  "schemaVersion",
  "harness",
  "root",
  "projectRoot",
  "userHome",
  "version",
  "managedFiles",
]);

export function parseSemVer(v) {
  if (!v || typeof v !== "string") return null;
  const clean = v.trim().replace(/^v/i, "");
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    raw: clean,
  };
}

export function compareSemVer(a, b) {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease && pa.prerelease !== pb.prerelease) {
    return pa.prerelease < pb.prerelease ? -1 : 1;
  }
  return 0;
}

export function readLocalVersion(root = REPO_ROOT) {
  const versionPath = join(root, "VERSION");
  if (!existsSync(versionPath)) return null;
  try {
    const content = readFileSync(versionPath, "utf8").trim();
    const sem = parseSemVer(content);
    return sem ? sem.raw : null;
  } catch {
    return null;
  }
}

export function validateSafePath(value, label = "path") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (/[\x00\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}: contains control characters`);
  }
  if (value.trim().startsWith("-")) {
    throw new Error(`Invalid ${label}: path cannot start with "-"`);
  }
  return value;
}

export function getStateFilePath(userHome) {
  validateSafePath(userHome, "userHome");
  return join(resolve(userHome), ".nullform", "installation.json");
}

function validateManagedFilesMap(rawMap) {
  if (rawMap === undefined) return undefined;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    throw new Error("Invalid managedFiles in installation state: must be an object map");
  }
  const out = {};
  for (const [filePath, hash] of Object.entries(rawMap)) {
    if (typeof filePath !== "string" || !filePath.trim() || !isAbsolute(filePath) || /[\x00\r\n]/.test(filePath)) {
      throw new Error(`Invalid managedFiles key "${filePath}": must be an absolute path`);
    }
    if (typeof hash !== "string" || !hash.trim() || /[\x00\r\n]/.test(hash)) {
      throw new Error(`Invalid managedFiles hash for "${filePath}"`);
    }
    out[filePath] = hash;
  }
  return out;
}

export function validateInstallationState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Installation state must be a JSON object");
  }
  for (const key of Object.keys(state)) {
    if (!ALLOWED_STATE_KEYS.has(key)) {
      throw new Error(`Installation state contains unexpected field "${key}"`);
    }
  }
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported installation state schemaVersion: ${JSON.stringify(state.schemaVersion)}`);
  }
  if (typeof state.harness !== "string" || !CONCRETE_HARNESSES.includes(state.harness)) {
    throw new Error(
      `Invalid harness in installation state: ${JSON.stringify(state.harness)}. Expected one of: ${CONCRETE_HARNESSES.join(", ")}`
    );
  }
  if (typeof state.root !== "string" || !state.root.trim() || !isAbsolute(state.root) || /[\x00\r\n]/.test(state.root)) {
    throw new Error("Invalid root in installation state: must be an absolute path");
  }
  if (
    typeof state.userHome !== "string" ||
    !state.userHome.trim() ||
    !isAbsolute(state.userHome) ||
    /[\x00\r\n]/.test(state.userHome)
  ) {
    throw new Error("Invalid userHome in installation state: must be an absolute path");
  }
  let projectRoot;
  if (state.projectRoot !== undefined) {
    if (
      typeof state.projectRoot !== "string" ||
      !state.projectRoot.trim() ||
      !isAbsolute(state.projectRoot) ||
      /[\x00\r\n]/.test(state.projectRoot) ||
      state.projectRoot.trim().startsWith("-")
    ) {
      throw new Error("Invalid projectRoot in installation state: must be an absolute path");
    }
    projectRoot = resolve(state.projectRoot);
  }
  const sem = parseSemVer(state.version);
  if (!sem) {
    throw new Error(`Invalid version in installation state: ${JSON.stringify(state.version)}`);
  }
  const managedFiles = validateManagedFilesMap(state.managedFiles);

  return {
    schemaVersion: 1,
    harness: state.harness,
    root: resolve(state.root),
    ...(projectRoot ? { projectRoot } : {}),
    userHome: resolve(state.userHome),
    version: sem.raw,
    ...(managedFiles ? { managedFiles } : {}),
  };
}
export function readInstallationState(userHome) {
  const statePath = getStateFilePath(userHome);
  if (!existsSync(statePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    throw new Error(`Corrupted installation state JSON at ${statePath}: ${err.message}`);
  }
  return validateInstallationState(parsed);
}

export function writeInstallationState(userHome, state) {
  const statePath = getStateFilePath(userHome);
  const validated = validateInstallationState(state);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return { statePath, state: validated };
}

export function detectEffectivePrefix(options = {}) {
  const env = options.env || process.env;
  const explicit =
    options.prefix || env.NULLFORM_PREFIX || env.NPM_CONFIG_PREFIX || env.npm_config_prefix || null;
  if (explicit) {
    validateSafePath(explicit, "prefix");
    return resolve(explicit);
  }

  const candidates = [options.packageRoot, options.argv1 ? dirname(resolve(options.argv1)) : null, REPO_ROOT].filter(
    Boolean
  );
  for (const cand of candidates) {
    const resolved = resolve(cand);
    const pkgDir = basename(resolved) === "bin" ? dirname(resolved) : resolved;
    if (basename(pkgDir) === PACKAGE_NAME && basename(dirname(pkgDir)) === "node_modules") {
      const nmParent = dirname(dirname(pkgDir));
      return basename(nmParent) === "lib" ? dirname(nmParent) : nmParent;
    }
  }

  if (options.argv1) {
    const rawBin = dirname(resolve(options.argv1));
    if (basename(rawBin) === "bin" && existsSync(join(dirname(rawBin), "lib", "node_modules", PACKAGE_NAME))) {
      return dirname(rawBin);
    }
    if (existsSync(join(rawBin, "node_modules", PACKAGE_NAME))) {
      return rawBin;
    }
  }
  return null;
}

export function resolveInstalledBinPath(effectivePrefix) {
  if (!effectivePrefix) return null;
  const pref = resolve(effectivePrefix);
  const candidates = [
    join(pref, "bin", "nullform.mjs"),
    join(pref, "node_modules", PACKAGE_NAME, "bin", "nullform.mjs"),
    join(pref, "lib", "node_modules", PACKAGE_NAME, "bin", "nullform.mjs"),
    join(pref, "nullform.cmd"),
    join(pref, "bin", "nullform.cmd"),
    join(pref, "bin", "nullform"),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return null;
}

export function sanitizeError(msg) {
  if (!msg || typeof msg !== "string") return "";
  return msg
    .replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/g, "$1$2:***@")
    .replace(/(?:_authToken|token|secret|password|bearer|auth)[:=]\s*([a-zA-Z0-9_\-\.]+)/gi, "$1=***")
    .replace(/Bearer\s+([a-zA-Z0-9_\-\.]+)/gi, "Bearer ***");
}
