#!/usr/bin/env node
/**
 * tools/self-update.mjs — npm registry version check and global package self-update.
 */

import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveNpmRunner, spawnAsync, spawnSafe } from './installation-state.mjs';
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { parseArgs } from "node:util";

import {
  PACKAGE_NAME,
  HARNESS_CHOICES,
  CONCRETE_HARNESSES,
  parseSemVer,
  compareSemVer,
  readLocalVersion,
  validateSafePath,
  getStateFilePath,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  detectEffectivePrefix,
  resolveInstalledBinPath,
  sanitizeError,
} from "./installation-state.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

export {
  PACKAGE_NAME,
  HARNESS_CHOICES,
  CONCRETE_HARNESSES,
  parseSemVer,
  compareSemVer,
  readLocalVersion,
  validateSafePath,
  getStateFilePath,
  validateInstallationState,
  readInstallationState,
  writeInstallationState,
  detectEffectivePrefix,
  resolveInstalledBinPath,
  sanitizeError,
  sanitizeResultObject,
};

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_RELEASE_API = `${DEFAULT_REGISTRY}/${PACKAGE_NAME}/latest`;
export const DEFAULT_TIMEOUT_MS = 10000;

export function validateHttpUrl(value, label = "url") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${label}: must be a non-empty URL string`);
  }
  const trimmed = value.trim();
  if (/[\x00-\x20\x7f]/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label}: "${sanitizeError(value)}" contains unsafe characters`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${label}: "${sanitizeError(value)}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${label}: protocol must be http: or https: (got ${parsed.protocol})`);
  }
  return trimmed;
}

export function readNpmrcRegistry(userHome, cwd, env = process.env) {
  const candidates = [
    env.NPM_CONFIG_USERCONFIG,
    env.npm_config_userconfig,
    cwd ? join(cwd, ".npmrc") : null,
    userHome ? join(userHome, ".npmrc") : null,
  ].filter(Boolean);

  for (const rcPath of candidates) {
    if (!existsSync(rcPath)) continue;
    try {
      for (const line of readFileSync(rcPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
        const match = trimmed.match(/^registry\s*=\s*(.+)$/i);
        if (match) {
          const val = match[1].trim().replace(/^["']|["']$/g, "");
          if (val) return validateHttpUrl(val, ".npmrc registry");
        }
      }
    } catch {}
  }
  return null;
}

export function resolveRegistryConfig(options = {}) {
  const env = options.env || process.env;
  const rawApiUrl = options.apiUrl || env.NULLFORM_RELEASE_URL || null;
  const rawRegistry =
    options.registry ||
    env.NULLFORM_REGISTRY ||
    env.npm_config_registry ||
    env.NPM_CONFIG_REGISTRY ||
    readNpmrcRegistry(options.userHome, options.root, env) ||
    null;

  const apiUrl = rawApiUrl ? validateHttpUrl(rawApiUrl, "apiUrl") : null;
  let registryUrl = rawRegistry ? validateHttpUrl(rawRegistry, "registry").replace(/\/+$/, "") : null;

  if (apiUrl) {
    const parsed = new URL(apiUrl);
    const cleanApi = apiUrl.replace(/\/+$/, "");
    if (!registryUrl) {
      const pkgSuffix = new RegExp(`/${PACKAGE_NAME}(?:/latest)?$`, "i");
      registryUrl = pkgSuffix.test(parsed.pathname)
        ? `${parsed.origin}${parsed.pathname.replace(pkgSuffix, "")}` || parsed.origin
        : parsed.origin;
    }
    const metadataUrls =
      parsed.pathname === "/" || parsed.pathname === ""
        ? [`${cleanApi}/${PACKAGE_NAME}`, `${cleanApi}/${PACKAGE_NAME}/latest`]
        : [apiUrl];
    return { registryUrl, metadataUrls };
  }

  const base = (registryUrl || DEFAULT_REGISTRY).replace(/\/+$/, "");
  return {
    registryUrl: base,
    metadataUrls: [`${base}/${PACKAGE_NAME}`, `${base}/${PACKAGE_NAME}/latest`],
  };
}

export function extractNpmMetadata(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  let rawVersion = null;
  let tarballUrl = null;

  if (typeof data.version === "string") {
    rawVersion = data.version;
    tarballUrl = data.dist?.tarball || null;
  } else if (typeof data["dist-tags"]?.latest === "string") {
    rawVersion = data["dist-tags"].latest;
    const verEntry = data.versions && typeof data.versions === "object" ? data.versions[rawVersion] : null;
    tarballUrl = verEntry?.dist?.tarball || data.dist?.tarball || null;
  } else if (data.versions && typeof data.versions === "object") {
    const valid = Object.keys(data.versions).filter((v) => parseSemVer(v) !== null).sort(compareSemVer);
    if (valid.length > 0) {
      rawVersion = valid[valid.length - 1];
      tarballUrl = data.versions[rawVersion]?.dist?.tarball || null;
    }
  }

  const sem = parseSemVer(rawVersion);
  return sem ? { version: sem.raw, tarballUrl } : null;
}

function buildComparisonResult(current, extracted) {
  const latest = extracted.version;
  const tag = `v${latest}`;
  const drift = compareSemVer(current, latest) < 0;
  return {
    status: drift ? "drift" : "clean",
    ok: true,
    drift,
    current,
    latest,
    tag,
    packageName: PACKAGE_NAME,
    tarballUrl: extracted.tarballUrl,
    detail: drift
      ? `Update available: local v${current} is behind npm latest v${latest}`
      : `Up to date: v${current} matches npm latest v${latest}`,
  };
}



export async function checkRelease(options = {}) {
  const root = resolve(options.root || REPO_ROOT), env = options.env || process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const raw = options.currentVersion || readLocalVersion(root), current = parseSemVer(raw)?.raw || raw;
  const setup = (detail, fields = {}) => ({ status: 'setup', ok: true, offline: false, current, latest: null, ...fields, detail: sanitizeError(detail) });
  if (!raw) return setup(`VERSION file missing in ${root}`, { missingVersion: true, current: null });
  let config;
  try { config = resolveRegistryConfig({ ...options, root }); }
  catch (error) { return setup(error.message, { ok: false, invalidConfig: true, error: sanitizeError(error.message) }); }

  // An explicit JSON endpoint is not an npm registry: never forward npm credentials to it.
  if (options.apiUrl || env.NULLFORM_RELEASE_URL || options.fetchFn) {
    let lastStatus, parseError;
    for (const url of config.metadataUrls) {
      let response;
      try { response = await (options.fetchFn || globalThis.fetch)(url, { method: 'GET', headers: { Accept: 'application/vnd.npm.install-v1+json, application/json', 'User-Agent': 'nullform-workflow-cli' }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (error) { return setup(`npm registry unreachable: ${error.message}`, { offline: true, error: sanitizeError(error.message) }); }
      lastStatus = response.status;
      if (lastStatus === 404) continue;
      if (!response.ok) return setup(`npm registry returned HTTP ${lastStatus}`, { offline: true, error: `HTTP ${lastStatus}` });
      try { const metadata = extractNpmMetadata(await response.json()); if (metadata) return buildComparisonResult(current, metadata); }
      catch (error) { parseError = error; }
    }
    if (lastStatus === 404) return setup(`No releases found for ${PACKAGE_NAME} in npm registry (HTTP 404)`, { notPublished: true });
    return setup(parseError ? `Failed to parse npm registry response: ${parseError.message}` : 'Could not parse npm package version from registry metadata', { ok: false });
  }

  const runner = resolveNpmRunner({ npmCliJs: options.npmCliJs, env, execPath: options.execPath });
  const home = options.userHome ? resolve(options.userHome) : null;
  const userconfig = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || (home ? join(home, '.npmrc') : null);
  const cache = mkdtempSync(join(tmpdir(), 'nullform-metadata-'));
  const childEnv = { ...env, ...(home ? { HOME: home, USERPROFILE: home, NULLFORM_USER_HOME: home } : {}), ...(userconfig && existsSync(userconfig) ? { npm_config_userconfig: userconfig, NPM_CONFIG_USERCONFIG: userconfig } : {}), npm_config_cache: cache, NPM_CONFIG_CACHE: cache, npm_config_fetch_retries: '0', NPM_CONFIG_FETCH_RETRIES: '0' };
  const args = [...runner.prefixArgs, 'view', PACKAGE_NAME, '--json', '--fetch-retries=0'];
  if (config.registryUrl) args.push('--registry', config.registryUrl);
  if (userconfig && existsSync(userconfig)) args.push(`--userconfig=${userconfig}`);
  let result;
  try { result = await (options.spawnAsyncFn || spawnAsync)(runner.command, args, { cwd: root, env: childEnv, timeoutMs }); }
  catch (error) { return setup(`npm view failed: ${error.message}`, { offline: true, error: sanitizeError(error.message) }); }
  finally { rmSync(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  if (result.status === 0) {
    try { const metadata = extractNpmMetadata(JSON.parse(result.stdout)); if (metadata) return buildComparisonResult(current, metadata); }
    catch (error) { return setup(`Failed to parse npm registry response: ${error.message}`, { ok: false }); }
    return setup('Could not parse npm package version from registry metadata', { ok: false });
  }
  let failure;
  for (const text of [result.stdout, result.stderr]) {
    try { const data = JSON.parse(text); if (data?.error) { failure = data.error; break; } } catch {}
  }
  const code = failure?.code || result.error?.code || '';
  const summary = failure?.summary || result.stderr || result.error?.message || `exit ${result.status}`;
  if (code === 'E404' || /404\b|Not Found/i.test(summary)) return setup(`No releases found for ${PACKAGE_NAME} in npm registry (HTTP 404)`, { notPublished: true });
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|unreachable/i.test(summary)) return setup(`npm registry unreachable: ${summary}`, { offline: true, error: sanitizeError(code || summary) });
  if (code === 'E401' || /401\b|Unauthorized/i.test(summary)) return setup(`npm registry returned HTTP 401: ${summary}`, { offline: true, error: 'HTTP 401' });
  return setup(`npm view failed: ${summary}`, { ok: false, error: sanitizeError(code || `exit ${result.status}`) });
}


function resolveUpdateTargetState(options, userHome) {
  const existing = readInstallationState(userHome);
  if (existing) {
    const projectRoot = options.projectRoot
      ? resolve(options.projectRoot)
      : existing.projectRoot
        ? resolve(existing.projectRoot)
        : null;
    return { ok: true, state: { ...existing, ...(projectRoot ? { projectRoot } : {}) } };
  }

  if (options.harness && options.root && HARNESS_CHOICES.includes(options.harness)) {
    validateSafePath(options.root, "root");
    if (options.projectRoot) validateSafePath(options.projectRoot, "projectRoot");
    const projectRoot = options.projectRoot
      ? resolve(options.projectRoot)
      : options.harness === "cursor"
        ? resolve(process.cwd())
        : null;
    const ver = readLocalVersion(resolve(options.root)) || readLocalVersion(REPO_ROOT);
    if (!ver) return { ok: false, error: "missing_version", detail: `Cannot determine version for target ${options.root}` };
    return {
      ok: true,
      state: {
        schemaVersion: 1,
        harness: options.harness,
        root: resolve(options.root),
        ...(projectRoot ? { projectRoot } : {}),
        userHome,
        version: ver,
      },
    };
  }
  return { ok: false, error: "missing_state", detail: `No saved installation found at ${getStateFilePath(userHome)}. Run 'nullform init' first.` };
}


function runInstalledBinReinit({ options, spawnFn, effectivePrefix, savedState, userHome, childEnv, check }) {
  const targetVersion = check.latest;
  const newBinPath = options.newBinPath || resolveInstalledBinPath(effectivePrefix);
  if (!newBinPath || (!options.spawnFn && !existsSync(newBinPath))) {
    return { ok: false, updated: false, error: "bin_not_found", current: check.current, latest: targetVersion, detail: `Installed nullform binary not found in prefix ${effectivePrefix || "(unknown)"}` };
  }

  const isJs = /\.[cm]?js$/i.test(newBinPath);
  const reinitArgs = [
    ...(isJs ? [newBinPath] : []),
    "init",
    "--harness",
    savedState.harness,
    "--root",
    savedState.root,
    ...(savedState.projectRoot ? ["--project-root", savedState.projectRoot] : []),
    "--user-home",
    userHome,
    "--yes",
    "--json",
    "--skip-release-check",
  ];
  const command = isJs ? (options.execPath || process.execPath) : newBinPath;
  const reinitRes = spawnSafe(spawnFn, command, reinitArgs, savedState.root, childEnv);
  const reinitStatus = reinitRes.status ?? (reinitRes.error ? 1 : 0);
  let reinitJson = null;
  if (reinitRes.stdout) {
    try { reinitJson = JSON.parse(reinitRes.stdout.trim()); } catch {}
  }

  if (reinitStatus !== 0 || (reinitJson && reinitJson.ok === false)) {
    const stageErr = reinitJson?.stage === "doctor" || reinitJson?.error === "doctor_failed" ? "doctor_failed" : "install_failed";
    const rawDetail = (reinitJson?.detail || reinitJson?.error || reinitRes.error?.message || (reinitRes.stderr || "").trim() || (reinitRes.stdout || "").trim().slice(0, 500) || `exit ${reinitStatus}`).trim();
    return {
      ok: false,
      updated: false,
      error: stageErr,
      status: "pending",
      recoverable: true,
      current: check.current,
      latest: targetVersion,
      doctor: reinitJson?.doctor || null,
      detail: `Package updated in prefix, but target re-apply failed (${stageErr}): ${sanitizeError(rawDetail)}`,
    };
  }

  let finalState = null;
  try { finalState = readInstallationState(userHome); } catch {}
  const finalVersion = finalState?.version || reinitJson?.version || null;
  if (!finalVersion || compareSemVer(finalVersion, targetVersion) !== 0) {
    return {
      ok: false,
      updated: false,
      error: "version_mismatch",
      status: "pending",
      recoverable: true,
      current: check.current,
      latest: targetVersion,
      detail: `Update verification failed: expected v${targetVersion}, got ${finalVersion ? `v${finalVersion}` : "unverified version"}`,
    };
  }
  return {
    ok: true,
    updated: true,
    from: check.current,
    to: finalVersion,
    current: check.current,
    latest: targetVersion,
    version: finalVersion,
    tag: `v${finalVersion}`,
    harness: finalState?.harness || savedState.harness,
    root: finalState?.root || savedState.root,
    ...(finalState?.projectRoot || savedState.projectRoot ? { projectRoot: finalState?.projectRoot || savedState.projectRoot } : {}),
    userHome,
    prefix: effectivePrefix,
    newBinPath,
    installOk: true,
    doctorOk: true,
    doctor: reinitJson?.doctor || null,
    detail: `Successfully updated ${PACKAGE_NAME} from v${check.current} to v${finalVersion}.`,
  };
}

function resolveUpdateContext(options, env) {
  const rawHome = options.userHome || env.NULLFORM_USER_HOME || env.USERPROFILE || env.HOME || homedir();
  let userHome;
  try {
    validateSafePath(rawHome, "userHome");
    if (options.root) validateSafePath(options.root, "root");
    if (options.projectRoot) validateSafePath(options.projectRoot, "projectRoot");
    userHome = resolve(rawHome);
  } catch (err) {
    return { ok: false, error: "invalid_arguments", detail: sanitizeError(err.message) };
  }


  let targetResolved;
  try {
    targetResolved = resolveUpdateTargetState(options, userHome);
  } catch (err) {
    const isArgErr = err.message.startsWith("Invalid root");
    return { ok: false, error: isArgErr ? "invalid_arguments" : "invalid_state", detail: sanitizeError(err.message) };
  }
  if (!targetResolved.ok) return { ...targetResolved, detail: sanitizeError(targetResolved.detail) };

  try {
    const effectivePrefix = detectEffectivePrefix({
      prefix: options.prefix,
      packageRoot: options.packageRoot || REPO_ROOT,
      argv1: options.argv1 || process.argv[1],
      env,
    });
    const registryConfig = resolveRegistryConfig({
      apiUrl: options.apiUrl,
      registry: options.registry,
      userHome,
      root: targetResolved.state.root,
      env,
    });
    return { ok: true, userHome, savedState: targetResolved.state, effectivePrefix, registryConfig };
  } catch (err) {
    return { ok: false, error: "invalid_arguments", detail: sanitizeError(err.message) };
  }
}

export async function executeUpdate(options = {}) {
  const env = options.env || process.env;
  const spawnFn = options.spawnFn || spawnSync;
  const ctx = resolveUpdateContext(options, env);
  if (!ctx.ok) return { ok: false, updated: false, error: ctx.error, detail: sanitizeError(ctx.detail) };
  const { userHome, savedState, effectivePrefix, registryConfig } = ctx;

  const verifiedVersion = savedState?.version || null;
  const currentVersion = options.currentVersion || verifiedVersion || readLocalVersion(savedState.root);
  const check = await checkRelease({
    root: savedState.root,
    currentVersion,
    userHome,
    apiUrl: options.apiUrl,
    registry: options.registry,
    timeoutMs: options.timeoutMs,
    fetchFn: options.fetchFn,
    spawnAsyncFn: options.spawnAsyncFn,
    npmCliJs: options.npmCliJs,
    execPath: options.execPath,
    env,
  });

  if (check.status === "setup" || !check.ok || !check.latest) {
    return { ok: false, updated: false, error: "release_check_failed", current: check.current, latest: null, detail: sanitizeError(check.detail || "Unable to determine latest version from npm registry") };
  }
  const isUpToDate = check.status === "clean" && (!verifiedVersion || compareSemVer(verifiedVersion, check.latest) >= 0);
  if (isUpToDate && !options.force && !options.dryRun) {
    return {
      ok: true,
      updated: false,
      current: verifiedVersion || check.current,
      latest: check.latest,
      harness: savedState.harness,
      root: savedState.root,
      ...(savedState.projectRoot ? { projectRoot: savedState.projectRoot } : {}),
      userHome,
      detail: `Already up to date (v${check.latest}).`,
    };
  }

  const targetVersion = check.latest;
  const pkgSpec = `${PACKAGE_NAME}@${targetVersion}`;
  const registryUrl = registryConfig.registryUrl;

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      updated: false,
      current: check.current,
      latest: targetVersion,
      targetVersion,
      tag: `v${targetVersion}`,
      targetTag: `v${targetVersion}`,
      harness: savedState.harness,
      root: savedState.root,
      ...(savedState.projectRoot ? { projectRoot: savedState.projectRoot } : {}),
      userHome,
      prefix: effectivePrefix,
      registry: sanitizeError(registryUrl),
      plan: [
        `npm install --global --ignore-scripts${effectivePrefix ? ` --prefix ${JSON.stringify(effectivePrefix)}` : ""}${registryUrl ? ` --registry ${JSON.stringify(sanitizeError(registryUrl))}` : ""} -- ${pkgSpec}`,
        `nullform init --harness ${savedState.harness} --root ${JSON.stringify(savedState.root)}${savedState.projectRoot ? ` --project-root ${JSON.stringify(savedState.projectRoot)}` : ""} --user-home ${JSON.stringify(userHome)} --yes`,
      ],
      detail: `[dry-run] Update plan for ${pkgSpec} ready. No changes written.`,
    };
  }

  const npmArgs = ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (effectivePrefix) npmArgs.push("--prefix", effectivePrefix);
  if (registryUrl) npmArgs.push("--registry", registryUrl);
  npmArgs.push("--", pkgSpec);

  const cacheDir = options.cacheDir || env.npm_config_cache || env.NPM_CONFIG_CACHE || join(userHome, ".nullform", "npm-cache");
  const pathSep = process.platform === "win32" ? ";" : ":";
  const extraPaths = effectivePrefix
    ? (process.platform === "win32"
        ? [effectivePrefix, join(effectivePrefix, "bin")]
        : [join(effectivePrefix, "bin"), effectivePrefix])
    : [];
  const currentPath = env.PATH || env.Path || "";
  const newPath = [...extraPaths.filter(Boolean), currentPath].join(pathSep);

  const userRc = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || join(userHome, ".npmrc");
  const childEnv = {
    ...env,
    HOME: userHome,
    USERPROFILE: userHome,
    NULLFORM_USER_HOME: userHome,
    ...(existsSync(userRc) ? { npm_config_userconfig: userRc, NPM_CONFIG_USERCONFIG: userRc } : {}),
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_fetch_retries: env.npm_config_fetch_retries ?? "0",
    NPM_CONFIG_FETCH_RETRIES: env.NPM_CONFIG_FETCH_RETRIES ?? "0",
    PATH: newPath,
    ...(process.platform === "win32" ? { Path: newPath } : {}),
    ...(effectivePrefix ? { npm_config_prefix: effectivePrefix, NPM_CONFIG_PREFIX: effectivePrefix, NULLFORM_PREFIX: effectivePrefix } : {}),
    ...(registryUrl ? { npm_config_registry: registryUrl, NPM_CONFIG_REGISTRY: registryUrl, NULLFORM_REGISTRY: registryUrl } : {}),
  };

  const runner = resolveNpmRunner({ npmCliJs: options.npmCliJs, env: childEnv, execPath: options.execPath });
  const npmRes = spawnSafe(spawnFn, runner.command, [...runner.prefixArgs, ...npmArgs], savedState.root, childEnv);
  const npmStatus = npmRes.status ?? (npmRes.error ? 1 : 0);
  if (npmStatus !== 0) {
    const errMsg = (npmRes.error?.message || (npmRes.stderr || "").trim() || (npmRes.stdout || "").trim().slice(0, 500) || `exit ${npmStatus}`).trim();
    return { ok: false, updated: false, error: "npm_install_failed", current: check.current, latest: targetVersion, detail: `npm install --global failed: ${sanitizeError(errMsg)}` };
  }

  return runInstalledBinReinit({ options, spawnFn, effectivePrefix, savedState, userHome, childEnv, check });
}

export function parseCliArgs(argv = []) {
  const options = {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    root: { type: "string" },
    "project-root": { type: "string" },
    "user-home": { type: "string" },
    prefix: { type: "string" },
    registry: { type: "string" },
    "api-url": { type: "string" },
    harness: { type: "string" },
    timeout: { type: "string" },
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    const rawMsg = err.message || "";
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const match = rawMsg.match(/'([^']+)'/);
      throw new Error(`Unknown option "${match ? match[1] : ""}"`);
    }
    if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const match = rawMsg.match(/Option '([^'\s]+)/);
      throw new Error(`Missing value for ${match ? match[1] : "option"}`);
    }
    throw err;
  }

  const command = parsed.positionals[0] || "check";
  if (command !== "check" && command !== "update") throw new Error(`Unknown command "${command}"`);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (parsed.values.timeout) {
    const val = parseInt(parsed.values.timeout, 10);
    if (!Number.isFinite(val) || val <= 0) throw new Error("Invalid --timeout value");
    timeoutMs = val * 1000;
  }

  return {
    command,
    json: Boolean(parsed.values.json),
    dryRun: Boolean(parsed.values["dry-run"]),
    force: Boolean(parsed.values.force),
    yes: Boolean(parsed.values.yes),
    root: parsed.values.root ? resolve(parsed.values.root) : null,
    projectRoot: parsed.values["project-root"] ? resolve(parsed.values["project-root"]) : null,
    userHome: parsed.values["user-home"] ? resolve(parsed.values["user-home"]) : null,
    prefix: parsed.values.prefix ? resolve(parsed.values.prefix) : null,
    registry: parsed.values.registry || null,
    apiUrl: parsed.values["api-url"] || null,
    harness: parsed.values.harness || null,
    timeoutMs,
    help: Boolean(parsed.values.help),
  };
}

function printHelp() {
  console.log(
    `
NULLFORM WORKFLOW Self-Update (npm)

Usage:
  node tools/self-update.mjs check [options]
  node tools/self-update.mjs update [options]

Commands:
  check     Check local VERSION against npm registry metadata
  update    Install latest npm package into global prefix and re-apply saved target

Options:
  --user-home <dir>  User home directory containing .nullform/installation.json
  --root <dir>       Workflow installation root directory
  --project-root <dir> Project root directory override
  --prefix <dir>     Global npm prefix override
  --api-url <url>    Direct package metadata endpoint override
  --dry-run          Preview update plan without making changes
  --force            Force update even when version matches
  --yes, -y          Non-interactive confirmation
  --timeout <sec>    Network timeout in seconds (default: 10)
  --json             Output result as JSON
  --help, -h         Show this help message
`.trim()
  );
}
function sanitizeResultObject(res) {
  if (typeof res === 'string') return sanitizeError(res);
  if (Array.isArray(res)) return res.map(sanitizeResultObject);
  if (res && typeof res === 'object') return Object.fromEntries(Object.entries(res).map(([key, value]) => [key, sanitizeResultObject(value)]));
  return res;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`self-update error: ${sanitizeError(err.message)}\n`);
    return 2;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.command === "check") {
    const res = await checkRelease({ ...opts, root: opts.root || REPO_ROOT });
    const safeRes = sanitizeResultObject(res);
    if (opts.json) {
      console.log(JSON.stringify(safeRes, null, 2));
    } else if (res.status === "drift") {
      console.log(`self-update: drift — local v${res.current} is behind npm v${res.latest}`);
      console.log(`To update, run: nullform update`);
    } else if (res.status === "clean") {
      console.log(`self-update: clean — local v${res.current} is up to date.`);
    } else {
      console.log(`self-update: setup — ${safeRes.detail}`);
    }
    return res.ok === false ? 1 : 0;
  }

  if (opts.command === "update") {
    const res = await executeUpdate(opts);
    const safeRes = sanitizeResultObject(res);
    if (opts.json) {
      console.log(JSON.stringify(safeRes, null, 2));
    } else if (!res.ok) {
      console.error(`self-update error: [${safeRes.error}] ${safeRes.detail}`);
    } else if (res.dryRun) {
      console.log(`[dry-run] Update plan for ${PACKAGE_NAME}@${res.latest}:`);
      for (const step of safeRes.plan || []) console.log(`  - ${step}`);
    } else if (res.updated) {
      console.log(`self-update: successfully updated from v${res.from} to v${res.to}.`);
    } else {
      console.log(`self-update: ${safeRes.detail}`);
    }
    return res.ok ? 0 : 1;
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`self-update: unhandled error: ${sanitizeError(err.message)}\n`);
    }
  );
}
