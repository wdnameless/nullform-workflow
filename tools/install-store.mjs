import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent, RUNTIME_PARSER_DEPS, resolveRuntimePackageDir } from "./installation/config.mjs";
import { safeAtomicWrite } from "./installation/journal.mjs";
import { readLocalVersion, CORE_FILES, getCoreDirs } from "./installation/state.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STORE_MARKER = ".store-marker";

export function isPreparedStore(targetRoot, expectedVersion = readLocalVersion(REPO_ROOT)) {
  if (!targetRoot || typeof targetRoot !== "string" || !existsSync(targetRoot)) return false;
  const markerPath = join(targetRoot, STORE_MARKER);
  const altMarkerPath = join(targetRoot, ".store.json");
  const actualMarker = existsSync(markerPath) ? markerPath : (existsSync(altMarkerPath) ? altMarkerPath : null);
  if (!actualMarker) return false;

  try {
    const raw = readFileSync(actualMarker, "utf8").trim();
    let storeVersion = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        storeVersion = parsed.version || null;
      }
    } catch {
      storeVersion = raw;
    }
    if (!storeVersion && existsSync(join(targetRoot, "VERSION"))) {
      storeVersion = readFileSync(join(targetRoot, "VERSION"), "utf8").trim();
    }
    if (!storeVersion || !expectedVersion) return false;
    return storeVersion === expectedVersion;
  } catch {
    return false;
  }
}

export function writeStoreMarker(targetRoot, version, { journal = null } = {}) {
  if (!targetRoot || !version) return null;
  const markerPath = join(targetRoot, STORE_MARKER);
  const content = JSON.stringify({ version, preparedAt: new Date().toISOString() }, null, 2) + "\n";
  if (journal) journal.recordBeforeWrite(markerPath, content);
  mkdirSync(targetRoot, { recursive: true });
  safeAtomicWrite(markerPath, content, "utf8");
  if (journal) journal.recordWritten(markerPath, hashContent(content));
  return markerPath;
}

function copyRuntimeDeps(repoRoot, targetRoot, slashRoot, assetContext, copyDirRecursive) {
  const copied = [];
  const destToolsNm = join(targetRoot, "tools", "node_modules");
  for (const pkg of RUNTIME_PARSER_DEPS) {
    const srcPkg = resolveRuntimePackageDir(pkg, repoRoot);
    if (srcPkg && existsSync(srcPkg)) {
      const destPkg = join(destToolsNm, pkg);
      copied.push(...copyDirRecursive(srcPkg, destPkg, slashRoot, assetContext));
    }
  }
  return copied;
}

export function applyStorePlan({
  plan,
  targetRoot,
  repoRoot = REPO_ROOT,
  slashRoot,
  assetContext,
  storeReused,
  currentVersion,
  options = {},
  journal = null,
  priorManaged = {},
  copyAsset,
  copyDirRecursive,
}) {
  if (storeReused) {
    if (priorManaged && Object.keys(priorManaged).length > 0) {
      Object.assign(plan.managedFiles, priorManaged);
    }
    return;
  }

  const coreDirs = getCoreDirs();
  for (const dir of coreDirs) {
    const srcDir = join(repoRoot, dir);
    if (existsSync(srcDir)) {
      plan.filesToCopy.push(...copyDirRecursive(srcDir, join(targetRoot, dir), slashRoot, assetContext));
    }
  }

  for (const file of CORE_FILES) {
    const srcFile = join(repoRoot, file);
    const destFile = join(targetRoot, file);
    if (existsSync(srcFile) && copyAsset(srcFile, destFile)) plan.filesToCopy.push(destFile);
  }

  plan.filesToCopy.push(...copyRuntimeDeps(repoRoot, targetRoot, slashRoot, assetContext, copyDirRecursive));

  if (!options.dryRun && currentVersion) {
    const markerPath = writeStoreMarker(targetRoot, currentVersion, { journal });
    if (markerPath) {
      plan.managedFiles[markerPath] = hashContent(readFileSync(markerPath, "utf8"));
    }
  }
}
