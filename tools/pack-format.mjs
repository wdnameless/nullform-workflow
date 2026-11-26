/**
 * tools/pack-format.mjs — Pack manifest format verification and loader.
 * Validates pack.json schema, verifies full file list in modules/ with SHA-256 hashes,
 * and ensures confinement and test entrypoint presence.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

/**
 * Calculates SHA-256 hash of a file or buffer.
 * @param {string|Buffer} input - File path or buffer
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashFileSha256(input) {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(input)) {
    hash.update(input);
  } else {
    hash.update(readFileSync(input));
  }
  return hash.digest("hex").toLowerCase();
}

/**
 * Recursively scans all files under a directory.
 * @param {string} dir - Directory to scan
 * @param {string} [baseDir] - Base directory for relative paths
 * @returns {Array<{ relPath: string, fullPath: string }>}
 */
export function scanFilesRecursively(dir, baseDir = dir) {
  const result = [];
  if (!existsSync(dir)) return result;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...scanFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile() || (entry.isSymbolicLink() && lstatSync(fullPath).isFile())) {
      const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
      result.push({ relPath, fullPath });
    }
  }
  return result;
}

/**
 * Normalizes and validates a relative module file path.
 * @param {string} rawPath - Raw path from manifest
 * @returns {string} Normalized relative path with forward slashes
 */
export function normalizeModulePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("workflow pack: file path must be a non-empty string");
  }
  if (isAbsolute(rawPath)) {
    throw new Error(`workflow pack: absolute file path not allowed: ${rawPath}`);
  }
  const forward = rawPath.replace(/\\/g, "/");
  const stripped = forward.replace(/^modules\//, "");
  const parts = stripped.split("/");
  if (parts.includes("..") || parts.includes(".") || parts.some((p) => !p)) {
    throw new Error(`workflow pack: file path contains invalid path traversal: ${rawPath}`);
  }
  return stripped;
}

/**
 * Extracts tests entrypoint path from raw manifest object.
 * @param {object} manifest - Parsed manifest object
 * @returns {string|null} Tests entrypoint or null
 */
function extractTestsEntry(manifest) {
  if (typeof manifest.tests === "string") return manifest.tests;
  if (manifest.tests && typeof manifest.tests.entrypoint === "string") return manifest.tests.entrypoint;
  if (typeof manifest.test === "string") return manifest.test;
  return null;
}

/**
 * Validates name and version strings in manifest.
 * @param {object} manifest - Parsed manifest object
 */
function validateManifestStrings(manifest) {
  if (!manifest.name || typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("workflow pack: pack.json missing or invalid 'name'");
  }
  if (!manifest.version || typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("workflow pack: pack.json missing or invalid 'version'");
  }
}

/**
 * Validates targets array in manifest.
 * @param {Array<string>} targets - Declared targets
 */
function validateManifestTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("workflow pack: pack.json missing or invalid 'targets' array");
  }
  for (const target of targets) {
    if (typeof target !== "string" || !target.trim()) {
      throw new Error("workflow pack: pack.json targets contains an invalid entry");
    }
  }
}

/**
 * Validates the top-level schema of a parsed pack.json object.
 * @param {object} manifest - Parsed manifest object
 * @returns {{ testsEntry: string }} Resolved tests entrypoint
 */
export function validateManifestSchema(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("workflow pack: pack.json must be a JSON object");
  }
  validateManifestStrings(manifest);
  validateManifestTargets(manifest.targets);
  if (!Array.isArray(manifest.files)) {
    throw new Error("workflow pack: pack.json missing or invalid 'files' array");
  }
  const testsEntry = extractTestsEntry(manifest);
  if (!testsEntry || !testsEntry.trim()) {
    throw new Error("workflow pack: pack.json missing or invalid 'tests' entrypoint");
  }
  return { testsEntry: testsEntry.trim() };
}

/**
 * Validates tests entrypoint existence within pack directory.
 * @param {string} packDir - Root directory of the pack
 * @param {string} testsEntry - Relative tests entrypoint path
 * @returns {string} Normalized relative test entrypoint path
 */
function validateTestsEntrypoint(packDir, testsEntry) {
  const testForward = testsEntry.replace(/\\/g, "/");
  if (isAbsolute(testForward) || testForward.split("/").includes("..")) {
    throw new Error(`workflow pack: tests entrypoint escapes pack root: ${testsEntry}`);
  }
  const fullTestPath = resolve(packDir, testForward);
  if (!existsSync(fullTestPath)) {
    throw new Error(`workflow pack: tests entrypoint not found: ${testsEntry}`);
  }
  return testForward;
}

/**
 * Validates and indexes declared manifest files.
 * @param {Array<{ path: string, sha256: string }>} manifestFiles
 * @returns {Map<string, string>}
 */
function parseDeclaredManifestFiles(manifestFiles) {
  const expectedMap = new Map();
  for (const entry of manifestFiles) {
    if (!entry || typeof entry !== "object") {
      throw new Error("workflow pack: pack.json files array contains an invalid entry");
    }
    const normPath = normalizeModulePath(entry.path);
    if (expectedMap.has(normPath)) {
      throw new Error(`workflow pack: duplicate file path in pack.json: ${normPath}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(entry.sha256)) {
      throw new Error(`workflow pack: invalid sha256 hash for file: ${entry.path}`);
    }
    expectedMap.set(normPath, entry.sha256.toLowerCase());
  }
  return expectedMap;
}

/**
 * Verifies disk files against expected manifest map.
 * @param {Array<{ relPath: string, fullPath: string }>} diskFiles
 * @param {Map<string, string>} expectedMap
 */
function verifyDiskFilesAgainstManifest(diskFiles, expectedMap) {
  const diskPaths = new Set();
  for (const file of diskFiles) {
    diskPaths.add(file.relPath);
    if (!expectedMap.has(file.relPath)) {
      throw new Error(`workflow pack: unlisted file in modules/: ${file.relPath}`);
    }
    const actualHash = hashFileSha256(file.fullPath);
    const expectedHash = expectedMap.get(file.relPath);
    if (actualHash !== expectedHash) {
      throw new Error(`workflow pack: hash mismatch for ${file.relPath}: expected ${expectedHash}, got ${actualHash}`);
    }
  }

  for (const expectedPath of expectedMap.keys()) {
    if (!diskPaths.has(expectedPath)) {
      throw new Error(`workflow pack: listed file missing from modules/: ${expectedPath}`);
    }
  }
}

/**
 * Verifies files listed in manifest against files physically present in modules/.
 * @param {string} modulesDir - Absolute path to modules/
 * @param {Array<{ path: string, sha256: string }>} manifestFiles - Files declared in manifest
 * @returns {Map<string, string>} Map of normalized relative path -> expected SHA-256
 */
function verifyModulePayload(modulesDir, manifestFiles) {
  const expectedMap = parseDeclaredManifestFiles(manifestFiles);

  if (!existsSync(modulesDir)) {
    if (expectedMap.size > 0) {
      throw new Error("workflow pack: modules directory missing from pack");
    }
    return expectedMap;
  }

  const diskFiles = scanFilesRecursively(modulesDir);
  verifyDiskFilesAgainstManifest(diskFiles, expectedMap);
  return expectedMap;
}

/**
 * Loads and verifies a pack from a pack directory.
 * @param {string} dir - Directory containing pack.json, modules/, and tests
 * @returns {{ manifest: object, files: Array<{ path: string, sha256: string, fullPath: string }> }}
 */
export function loadPack(dir) {
  if (!dir || typeof dir !== "string") {
    throw new Error("workflow pack: pack directory must be a non-empty string");
  }
  const packDir = resolve(dir);
  if (!existsSync(packDir)) {
    throw new Error(`workflow pack: pack directory not found: ${dir}`);
  }

  const manifestPath = join(packDir, "pack.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`workflow pack: manifest not found: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`workflow pack: invalid pack.json: ${err.message}`);
  }

  const { testsEntry } = validateManifestSchema(manifest);
  validateTestsEntrypoint(packDir, testsEntry);

  const modulesDir = join(packDir, "modules");
  const expectedMap = verifyModulePayload(modulesDir, manifest.files);

  const files = Array.from(expectedMap.entries()).map(([path, sha256]) => ({
    path,
    sha256,
    fullPath: join(modulesDir, path),
  }));

  return {
    manifest: { ...manifest, testsEntry },
    files,
  };
}
