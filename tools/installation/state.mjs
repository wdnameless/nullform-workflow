/**
 * tools/installation/state.mjs — Installation identity, deployment preflight, npm transport, and SemVer utilities.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { resolve, join, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from 'node:child_process';
import { validatePathWithinScope, isInsideOrEqual, resolveRealPath, getCanonicalPath } from '../worktree-snapshot.mjs';
import { RUNTIME_PARSER_DEPS, resolveRuntimePackageDir, resolveOpencodeConfigPaths } from './config.mjs';
import { resolveHostHome, validateHostManifest } from './profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

export const PACKAGE_NAME = "nullform-workflow";

export const CONCRETE_HARNESSES = Object.freeze(['claude', 'codex', 'opencode', 'cursor', 'omp', 'openclaw', 'hermes', 'openhuman']);
export const HARNESS_CHOICES = Object.freeze([...CONCRETE_HARNESSES, "custom"]);

const ALLOWED_STATE_KEYS = new Set([
  "schemaVersion",
  "harness",
  "root",
  "projectRoot",
  "userHome",
  "version",
  "managedFiles",
  "hostHome",
  "hostManifest",
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
      throw new Error(`Installation state contains unexpected field "${sanitizeError(key)}"`);
    }
  }
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported installation state schemaVersion: ${JSON.stringify(state.schemaVersion)}`);
  }
  if (typeof state.harness !== "string" || !HARNESS_CHOICES.includes(state.harness)) {
    throw new Error(
      `Invalid harness in installation state: ${JSON.stringify(sanitizeError(String(state.harness)))}. Expected one of: ${HARNESS_CHOICES.join(", ")}`
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
    throw new Error(`Invalid version in installation state: ${JSON.stringify(sanitizeError(String(state.version)))}`);
  }
  const managedFiles = validateManagedFilesMap(state.managedFiles);
  let hostHome;
  if (state.hostHome !== undefined) {
    if (typeof state.hostHome !== "string" || state.hostHome.length > 4096 || !isAbsolute(state.hostHome) || /[\x00-\x1f\x7f]/.test(state.hostHome)) {
      throw new Error("Invalid hostHome in installation state: must be a bounded absolute path");
    }
    hostHome = resolveHostHome({ harness: state.harness, userHome: state.userHome, hostHome: state.hostHome }).path;
  }
  const hostManifest = state.hostManifest === undefined ? undefined : validateHostManifest(state.hostManifest, { custom: state.harness === "custom" });
  if (state.harness === "custom" && (!hostManifest || !projectRoot)) throw new Error("Custom installation state requires hostManifest and projectRoot");

  return {
    schemaVersion: 1,
    harness: state.harness,
    root: resolve(state.root),
    ...(projectRoot ? { projectRoot } : {}),
    userHome: resolve(state.userHome),
    version: sem.raw,
    ...(managedFiles ? { managedFiles } : {}),
    ...(hostHome ? { hostHome } : {}),
    ...(hostManifest ? { hostManifest } : {}),
  };
}
export function readInstallationState(userHome) {
  const statePath = getStateFilePath(userHome);
  if (!existsSync(statePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (err) {
    throw new Error(`Corrupted installation state JSON at ${sanitizeError(statePath)}: ${sanitizeError(err.message)}`);
  }
  return validateInstallationState(parsed);
}

export function writeInstallationState(userHome, state, { journal = null } = {}) {
  const statePath = getStateFilePath(userHome);
  const validated = validateInstallationState(state);
  const content = JSON.stringify(validated, null, 2) + "\n";
  if (journal) journal.recordBeforeWrite(statePath, content);
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.installation.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    // Atomic replacement or failure; never leave installation identity temporarily absent.
    renameSync(tmpPath, statePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
  if (journal) journal.recordWritten(statePath);
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
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/-----BEGIN[ A-Z_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z_-]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/((?:https?|git\+https?|ssh):\/\/)([^:@\r\n]*):([^@\r\n]+)@/g, (_, scheme, user) => `${scheme}${user}:***@`)
    .replace(/((?:https?|git\+https?|ssh):\/\/)([^:@\s]+)@/g, (_, scheme) => `${scheme}***@`)
    .replace(/(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi, '[REDACTED_CONNECTION_URI]')
    .replace(/(?:\/\/)([^:@\r\n]*):([^@\r\n]+)@/g, (_, user) => `//${user}:***@`)
    .replace(/(?:\/\/)([^:@\s]+)@/g, '//***@')
    .replace(/ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._~+/-]*/g, '[REDACTED_JWT]')
    .replace(/(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/(?:sk-[A-Za-z0-9_-]{8,})/gi, 'sk-[REDACTED]')
    .replace(/(?:ghp_[A-Za-z0-9]{20,})/gi, 'ghp_[REDACTED]')
    .replace(/(?:npm_[A-Za-z0-9]{20,})/gi, 'npm_[REDACTED]')
    .replace(/(_authToken|_auth|api_key|apikey|api-key|access_key|secret_key|private_key|client_secret|credential|credentials|token|secret|password|passwd|bearer|auth|key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"',;}\]]+)/gi, (_, label) => `${label}=***`)
    .replace(/Bearer\s+["']?(?:[^\s"',;]+)["']?/gi, 'Bearer ***');
}
export const CORE_FILES = Object.freeze(["VERSION", ".code-size.baseline.json", "CONTEXT.md", "README.md", "secrets.example.env", "verify.ps1", "verify.sh", "package.json"]);
export function getCoreDirs() {
  return ["agent", "rules", "tools", "core", "templates", "skills", "paseo", "bin"];
}
export function preflightFilesystemConfinement({
  harnesses,
  targetRoot,
  projectRoot,
  userHome,
  agentsHome,
  shouldWriteHome,
  hostHomes = {},
  hostManifest,
}) {
  const pathCache = new Map();
    const source = getCanonicalPath(REPO_ROOT, pathCache), target = getCanonicalPath(targetRoot, pathCache);
    if (source && target && isInsideOrEqual(source, target) && !isInsideOrEqual(target, source)) throw new Error(`Cannot install harness into a subdirectory of the repository root ("${targetRoot}").`);
  const check = (targetPath, scope) => {
    if (!validatePathWithinScope(targetPath, scope, pathCache)) {
      throw new Error(
        `Preflight failed: destination path "${targetPath}" escapes declared root "${scope}" or is an unresolved link`
      );
    }
  };

  const checkTree = (src, dest, scope) => {
    check(dest, scope);
    if (!existsSync(src)) return;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (["node_modules", ".git", "__tmp__", "__pycache__", ".tmp"].includes(entry.name)) continue;
      const childDest = join(dest, entry.name);
      if (entry.isDirectory()) checkTree(join(src, entry.name), childDest, scope);
      else if (entry.isFile()) check(childDest, scope);
    }
  };
  for (const dir of getCoreDirs()) {
    checkTree(join(REPO_ROOT, dir), join(targetRoot, dir), targetRoot);
  }
  for (const file of CORE_FILES) {
    if (existsSync(join(REPO_ROOT, file))) check(join(targetRoot, file), targetRoot);
  }
  for (const pkg of RUNTIME_PARSER_DEPS) {
    const src = resolveRuntimePackageDir(pkg, REPO_ROOT);
    if (src) checkTree(src, join(targetRoot, "tools", "node_modules", pkg), targetRoot);
  }
  if (harnesses.includes("cursor")) {
    checkTree(join(REPO_ROOT, "skills"), join(targetRoot, "skills"), targetRoot);
  }

  for (const h of harnesses) {
    if (h !== "omp") {
      if (h === "custom") {
        if (!projectRoot || !hostManifest) throw new Error("Custom host requires a manifest and projectRoot");
        check(join(projectRoot, hostManifest.instructionsFile), projectRoot);
        continue;
      }
      if (h === "cursor") {
        const base = projectRoot || targetRoot;
        check(join(base, ".cursor", "rules", "00-workflow.mdc"), base);
        continue;
      }
      const home = hostHomes[h] || resolveHostHome({ harness: h, userHome }).path;
      check(home, home);
      check(join(targetRoot, h === "claude" ? "CLAUDE.md" : "AGENTS.md"), targetRoot);
      if (h === "hermes") {
        for (const path of ["config.yaml", "skills/nullform-workflow/SKILL.md"]) check(join(home, path), home);
        // The Hermes skill dir is the one adaptive home-skills write: fail if it exists as a link
        // or contains an escaping junction (parity with the old bulk-copy preflight).
        const skillDir = join(home, "skills", "nullform-workflow");
        if (existsSync(skillDir)) {
          check(skillDir, home);
          for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
            check(join(skillDir, entry.name), home);
          }
        }
      } else if (shouldWriteHome) {
        check(join(home, h === "claude" ? "CLAUDE.md" : "AGENTS.md"), home);
      }
      if (h === "opencode" || h === "openclaw") {
        for (const base of new Set([targetRoot, ...(shouldWriteHome ? [home] : [])])) {
          const paths = h === "opencode" ? resolveOpencodeConfigPaths(base) : [join(base, "openclaw.json")];
          for (const path of paths) check(path, base);
        }
      }
      continue;
    }
    if (h === "omp") {
      check(join(targetRoot, "agent", "AGENTS.md"), targetRoot);
      if (shouldWriteHome) {
        const homeAgentDir = hostHomes.omp || resolveHostHome({ harness: "omp", userHome }).path;
        check(homeAgentDir, homeAgentDir);
        check(join(homeAgentDir, "AGENTS.md"), homeAgentDir);
        check(join(homeAgentDir, ".harness-root"), homeAgentDir);
      }
    }
  }
}
function validateBatchArgs(command, args) {
  const isWin = process.platform === "win32";
  const isBatch = isWin && /\.(cmd|bat)$/i.test(command);
  if (isBatch) {
    for (const arg of args) {
      if (typeof arg === "string" && /[&|<>^%\r\n]/.test(arg)) {
        throw new Error(`Unsafe argument for batch command: "${sanitizeError(arg)}" contains shell metacharacters`);
      }
    }
  }
  return { isWin, isBatch };
}
export function spawnAsync(command, args, { cwd, env, timeoutMs } = {}) { let validated;
try { validated = validateBatchArgs(command, args); } catch (error) { return Promise.reject(error); }
return new Promise(resolveRun => {
  const output = { stdout: '', stderr: '' };
  let child, timer, timedOut = false, overflow = false, bytes = 0;
  try { child = spawn(command, args, { cwd: cwd && existsSync(cwd) ? cwd : process.cwd(), env, shell: validated.isBatch, windowsHide: validated.isWin }); }
  catch (error) { resolveRun({ status: 1, ...output, error }); return; }
  const collect = key => chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); return; }
    output[key] += chunk;
  };
  child.stdout?.setEncoding('utf8').on('data', collect('stdout'));
  child.stderr?.setEncoding('utf8').on('data', collect('stderr'));
  if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.on('error', error => { clearTimeout(timer); resolveRun({ status: 1, ...output, error, stderr: sanitizeError(error.message) }); });
  child.on('close', status => {
    clearTimeout(timer);
    resolveRun({ status: timedOut || overflow ? 1 : status ?? 1, ...output, ...(timedOut ? { stderr: 'ETIMEDOUT: npm metadata command exceeded timeout' } : overflow ? { stderr: 'npm metadata output exceeded 8 MiB' } : {}) });
  });
}); }
export function resolveNpmRunner(options = {}) {
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const nodeDir = dirname(execPath);
  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = (env.PATH || env.Path || "").split(pathSep).filter(Boolean);

  const candidates = [
    options.npmCliJs,
    env.npm_execpath,
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...pathDirs.flatMap((dir) => [
      join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]),
  ].filter((c) => typeof c === "string" && /\.[cm]?js$/i.test(c));

  for (const cliPath of candidates) {
    try {
      if (existsSync(cliPath)) return { command: execPath, prefixArgs: [cliPath], usesNode: true };
    } catch {}
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [], usesNode: false };
}
export function spawnSafe(spawnFn, command, args, rootDir, env) { const { isWin, isBatch } = validateBatchArgs(command, args);
return spawnFn(command, args, {
  cwd: existsSync(rootDir) ? rootDir : process.cwd(),
  env,
  encoding: "utf8",
  shell: isBatch,
  windowsHide: isWin,
}); }
export function getDefaultRoot(harness, userHome, options = {}) {
  if (harness === "omp" || harness === "all" || harness === "auto") return join(userHome, "omp-workflow");
  if (harness === "custom") return join(userHome, ".nullform", "workflow");
  return join(resolveHostHome({ harness, userHome, ...options }).path, "workflow");
}
