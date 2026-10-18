/** Durable task coordination for cooperating agents; not an OS filesystem sandbox. */
import {
  constants, lstatSync, statSync, mkdirSync, readdirSync, openSync, closeSync,
  fstatSync, readSync, writeFileSync, fsyncSync, renameSync, rmdirSync,
} from "node:fs";
import { join, resolve, relative, dirname, isAbsolute, win32 } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  validateRootPath, validatePathWithinScope, resolveRealPath, getCanonicalPath,
  isInsideOrEqual, isSecretOrCredentialPath,
} from "./worktree-snapshot.mjs";

const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CHANGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUIREMENT_ID = /^R\d+[a-z]?$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const CONTRACT_LIMIT = 16 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
const CLAIM_LIMIT = 128 * 1024;
const STATE = ".workflow/claims";
const LOCK = ".workflow/claims.lock";
const CONTRACT_KEYS = ["schemaVersion", "change", "requirements", "files", "checks"];
const RECORD_KEYS = ["version", "task", "owner", "token", "generation", "startedAt", "endsAt", "workspaceRoot", "baseCommit", "contractPath", "contractIdentity", "contractDigest", "manifestPath", "manifestIdentity", "manifestDigest", "contract", "fileIdentities", "history"];
const HISTORY_KEYS = ["owner", "generation", "contractDigest", "startedAt", "endsAt", "disposition"];

function fail(message, code = "ECLAIMSTATE") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function entry(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function samePath(a, b) {
  return isInsideOrEqual(a, b) && isInsideOrEqual(b, a);
}
function workspace(root) {
  const full = validateRootPath(root);
  // Inspect the selection's ancestors as well as its leaf before following them.
  for (let path = full; ; path = dirname(path)) {
    const info = entry(path);
    if (!info?.isDirectory() || info.isSymbolicLink()) fail("Workspace ancestor is not a plain directory; symlink/junction refused", "EPATH");
    if (dirname(path) === path) break;
  }
  const canonical = resolveRealPath(full);
  if (!canonical) fail("Workspace is not resolvable", "EPATH");
  return canonical;
}
function literalPath(value, maxLength = 256) {
  if (typeof value !== "string" || !value || value.length > maxLength || CONTROL.test(value) || /[*?\[\]{}:]/.test(value) || isAbsolute(value) || win32.isAbsolute(value)) {
    fail("Expected a bounded literal project-relative path", "EPATH");
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) fail("Project-relative path has an ambiguous or escaping component", "EPATH");
  return normalized;
}
function checkedPath(root, rel, state = false) {
  const path = resolve(root, literalPath(rel));
  if (!validatePathWithinScope(path, root)) fail("Path escapes its canonical workspace", "EPATH");
  const parts = relative(root, path).split(/[\\/]/);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = entry(current);
    if (!info) break;
    if (info.isSymbolicLink() && (state || !validatePathWithinScope(current, root))) fail("Symlink/junction redirects protected authority", "EPATH");
    if (i < parts.length - 1 && !statSync(current).isDirectory()) fail("Path ancestor is not a directory", "EPATH");
  }
  return path;
}
function identity(root, rel, state = false) {
  const canonical = getCanonicalPath(checkedPath(root, rel, state));
  if (!canonical || !isInsideOrEqual(root, canonical) || samePath(root, canonical)) fail("Path identity is outside its workspace", "EPATH");
  return canonical;
}
function readBounded(root, rel, limit, state = false) {
  const path = checkedPath(root, rel, state);
  const before = entry(path);
  if (!before) fail("Required bounded file is missing", "ENOENT");
  if (state && before.isSymbolicLink()) fail("Claim authority cannot be a symlink/junction", "EPATH");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW && !before.isSymbolicLink() ? constants.O_NOFOLLOW : 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > limit || (state && info.nlink !== 1)) fail("File is not a bounded independent regular file", "EBOUNDS");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(descriptor);
    const current = statSync(checkedPath(root, rel, state));
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || current.dev !== info.dev || current.ino !== info.ino) fail("File changed during bounded read; reconcile before retrying", "ECLAIMSTATE");
    const body = bytes.subarray(0, length);
    return { body, identity: identity(root, rel, state), digest: hash(body) };
  } finally { closeSync(descriptor); }
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function json(body, label) {
  try { return JSON.parse(body.toString("utf8")); }
  catch { fail(`Malformed ${label}; explicit operator reconciliation required`); }
}
function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function boundedArray(value, maximum) { return Array.isArray(value) && value.length > 0 && value.length <= maximum; }
function ownerValid(owner) { return typeof owner === "string" && owner.trim() && owner.length <= 256 && !CONTROL.test(owner); }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function taskId(task) {
  if (typeof task !== "string" || !TASK_ID.test(task)) fail("--task must be a lowercase alphanumeric/hyphen slug (1-64 characters)", "EARGS");
  return task;
}
function claimRel(task) { return `${STATE}/${taskId(task)}.json`; }
function validateContract(root, contract) {
  if (!exactObject(contract, CONTRACT_KEYS) || contract.schemaVersion !== 1 || typeof contract.change !== "string" || !CHANGE_ID.test(contract.change) || !boundedArray(contract.requirements, 64) || contract.requirements.some((id) => typeof id !== "string" || !REQUIREMENT_ID.test(id)) || new Set(contract.requirements).size !== contract.requirements.length || !boundedArray(contract.files, 64) || !boundedArray(contract.checks, 16)) fail("Invalid bounded task contract", "ECONTRACT");
  const files = contract.files.map((file) => {
    const rel = literalPath(file);
    if (rel.split("/").some((part) => [".workflow", ".git"].includes(part.toLowerCase())) || isSecretOrCredentialPath(rel.toLowerCase())) fail("Task scope names reserved state, Git or credential authority", "ECONTRACT");
    const path = checkedPath(root, rel);
    if (entry(path) && !statSync(path).isFile()) fail("Task scope must name files, not directories", "ECONTRACT");
    return identity(root, rel);
  });
  if (new Set(files.map((path) => process.platform === "win32" ? path.toLowerCase() : path)).size !== files.length) fail("Task scope has duplicate canonical files", "ECONTRACT");
  if (contract.checks.some((argv) => !boundedArray(argv, 32) || argv.some((arg) => typeof arg !== "string" || CONTROL.test(arg) || Buffer.byteLength(arg, "utf8") > 1024) || !argv[0].trim())) fail("Task checks must be bounded argv arrays, never shell command strings", "ECONTRACT");
  return files;
}
function requirements(body, ids) {
  const rows = new Map();
  for (const row of body.toString("utf8").split(/\r?\n/)) {
    const match = /^\|\s*(R\d+[a-z]?)\s*\|/.exec(row);
    if (!match) continue;
    if (rows.has(match[1])) fail("Ambiguous requirement identity in manifest", "ECONTRACT");
    rows.set(match[1], row);
  }
  return ids.map((id) => {
    if (!rows.has(id)) fail("Task contract names an unknown manifest requirement", "ECONTRACT");
    return rows.get(id);
  });
}
function loadContract(root, contractPath) {
  const rel = literalPath(contractPath);
  const file = readBounded(root, rel, CONTRACT_LIMIT);
  const contract = json(file.body, "task contract");
  const fileIdentities = validateContract(root, contract);
  const manifestPath = `openspec/changes/${contract.change}/manifest.md`;
  const manifest = readBounded(root, manifestPath, MANIFEST_LIMIT);
  const rows = requirements(manifest.body, contract.requirements);
  return { contract, contractPath: rel, contractIdentity: file.identity, contractDigest: file.digest, manifestPath, manifestIdentity: manifest.identity, manifestDigest: manifest.digest, fileIdentities, rows };
}
function gitBase(root) {
  let gitPresent = false;
  for (let path = root; ; path = dirname(path)) {
    if (entry(join(path, ".git"))) { gitPresent = true; break; }
    if (dirname(path) === path) break;
  }
  if (!gitPresent) return null;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  try {
    const base = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!/^[a-f0-9]{40,64}$/.test(base)) fail("Git did not return a valid base commit");
    return base;
  } catch { fail("Cannot establish actual Git base; explicit operator reconciliation required"); }
}
function readRecord(root, task) {
  const rel = claimRel(task);
  if (!entry(checkedPath(root, rel, true))) return null;
  const record = json(readBounded(root, rel, CLAIM_LIMIT, true).body, "task claim");
  const invalid = () => fail("Legacy or malformed task claim; explicit operator reconciliation required");
  if (!exactObject(record, RECORD_KEYS) || record.version !== 2 || record.task !== task || !ownerValid(record.owner) || typeof record.token !== "string" || !TOKEN.test(record.token) || !Number.isSafeInteger(record.generation) || record.generation < 1 || !timestamp(record.startedAt) || (record.endsAt !== null && !timestamp(record.endsAt)) || typeof record.workspaceRoot !== "string" || !samePath(root, record.workspaceRoot) || (record.baseCommit !== null && (typeof record.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(record.baseCommit))) || !HASH.test(record.contractDigest) || !HASH.test(record.manifestDigest) || !Array.isArray(record.history) || record.history.length > 64 || record.history.length !== record.generation - 1) invalid();
  const files = validateContract(root, record.contract);
  if (typeof record.contractPath !== "string" || typeof record.contractIdentity !== "string" || typeof record.manifestIdentity !== "string" || record.manifestPath !== `openspec/changes/${record.contract.change}/manifest.md` || !isInsideOrEqual(root, record.contractIdentity) || samePath(root, record.contractIdentity) || !isInsideOrEqual(root, record.manifestIdentity) || samePath(root, record.manifestIdentity) || !Array.isArray(record.fileIdentities) || record.fileIdentities.length !== files.length || record.fileIdentities.some((file, i) => typeof file !== "string" || !samePath(file, files[i]))) invalid();
  literalPath(record.contractPath);
  for (let i = 0; i < record.history.length; i++) {
    const previous = record.history[i];
    if (!exactObject(previous, HISTORY_KEYS) || !ownerValid(previous.owner) || previous.generation !== i + 1 || !HASH.test(previous.contractDigest) || !timestamp(previous.startedAt) || !timestamp(previous.endsAt) || previous.disposition !== "released") invalid();
  }
  return record;
}
function publicClaim(record) {
  const { token: _token, ...projection } = record;
  return projection;
}
function ensureState(root) {
  for (const rel of [".workflow", STATE]) {
    const path = checkedPath(root, rel, true);
    try { mkdirSync(path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!entry(path)?.isDirectory()) fail("Claim state must be a plain directory", "EPATH");
    checkedPath(root, rel, true);
  }
}
function transition(root, action) {
  ensureState(root);
  const lock = checkedPath(root, LOCK, true);
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    fail("Workspace claim transition is busy or held; abandoned authority requires explicit operator reconciliation", "ECLAIMBUSY");
  }
  let uncertain = false;
  const publish = (record) => {
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    if (bytes.length > CLAIM_LIMIT) fail("Claim state exceeds its byte bound; operator archival required", "EBOUNDS");
    const target = checkedPath(root, claimRel(record.task), true);
    const pending = checkedPath(root, `${STATE}/${record.task}.${randomUUID()}.pending`, true);
    uncertain = true;
    const fd = openSync(pending, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    checkedPath(root, claimRel(record.task), true);
    renameSync(pending, target);
    uncertain = false;
  };
  try { return action(publish); }
  finally {
    // A failed publication leaves both its lock and any pending bytes for reconciliation.
    if (!uncertain) rmdirSync(checkedPath(root, LOCK, true));
  }
}
function records(root) {
  const results = new Map();
  for (const name of readdirSync(checkedPath(root, STATE, true))) {
    if (!name.endsWith(".json") || !TASK_ID.test(name.slice(0, -5))) fail("Uncertain claim directory entry; explicit operator reconciliation required");
    const task = name.slice(0, -5);
    results.set(task, readRecord(root, task));
  }
  return results;
}

/** Acquisition alone returns the new generation's release token. */
export function claimTask(root, task, owner, contractPath) {
  taskId(task);
  if (!ownerValid(owner)) fail("--owner must be a non-empty bounded identity string", "EARGS");
  const canonical = workspace(root);
  return transition(canonical, (publish) => {
    const all = records(canonical);
    const previous = all.get(task);
    if (previous && previous.endsAt === null) fail(`Task "${task}" is already claimed; never retry a refusal`, "ECLAIMED");
    if (previous?.history.length >= 64) fail("Claim history is full; explicit operator archival required", "EBOUNDS");
    const loaded = loadContract(canonical, contractPath);
    for (const other of all.values()) {
      if (other.endsAt === null && loaded.fileIdentities.some((file) => other.fileIdentities.some((owned) => samePath(file, owned)))) fail("Another active task owns an overlapping canonical file", "ECLAIMED");
    }
    const history = previous ? [...previous.history, {
      owner: previous.owner, generation: previous.generation, contractDigest: previous.contractDigest,
      startedAt: previous.startedAt, endsAt: previous.endsAt, disposition: "released",
    }] : [];
    const { rows: _rows, ...pinned } = loaded;
    const record = {
      version: 2, task, owner: owner.trim(), token: randomUUID(), generation: (previous?.generation ?? 0) + 1,
      startedAt: new Date().toISOString(), endsAt: null, workspaceRoot: canonical, baseCommit: gitBase(canonical),
      ...pinned, history,
    };
    publish(record);
    return record;
  });
}

/** A fresh random token fences every generation; release never returns it. */
export function releaseTask(root, task, token) {
  taskId(task);
  const canonical = workspace(root);
  return transition(canonical, (publish) => {
    const record = readRecord(canonical, task);
    if (!record) fail(`No active claim for task "${task}"`, "ENOCLAIM");
    if (record.endsAt !== null) fail(`Claim for task "${task}" already ended`, "EENDED");
    if (typeof token !== "string" || record.token !== token) fail("Claim token mismatch; refusing release without holder proof", "ETOKEN");
    record.endsAt = new Date().toISOString();
    publish(record);
    return publicClaim(record);
  });
}

export function readClaim(root, task) {
  taskId(task);
  const canonical = workspace(root);
  if (entry(checkedPath(canonical, LOCK, true))) fail("Claim transition is held; explicit operator reconciliation required", "ECLAIMBUSY");
  const record = readRecord(canonical, task);
  return record ? publicClaim(record) : null;
}

/** An active packet is a projection of pinned task authority, never generic instructions. */
export function contextPacket(root, { change, task } = {}) {
  if (typeof change !== "string" || !CHANGE_ID.test(change)) fail("--change must be an alphanumeric slug", "EARGS");
  taskId(task);
  const canonical = workspace(root);
  const claim = readClaim(canonical, task);
  if (!claim) fail("No task claim; acquire explicit task authority first", "ENOCLAIM");
  if (claim.endsAt !== null) fail("Ended task cannot provide active execution authority", "EENDED");
  if (claim.contract.change !== change) fail("Requested change does not match the task contract", "ECONTRACT");
  const loaded = loadContract(canonical, claim.contractPath);
  for (const field of ["contractIdentity", "contractDigest", "manifestIdentity", "manifestDigest"]) {
    if (loaded[field] !== claim[field]) fail("Pinned contract or requirement identity changed; reconcile explicitly", "ECONTRACT");
  }
  if (JSON.stringify(loaded.contract) !== JSON.stringify(claim.contract)) fail("Pinned contract content changed", "ECONTRACT");
  return {
    version: 2, change, task, claim, contract: claim.contract,
    workspaceRoot: claim.workspaceRoot, baseCommit: claim.baseCommit,
    requirementsSource: { path: claim.manifestPath, identity: claim.manifestIdentity, digest: claim.manifestDigest },
    goalAncestry: { requirements: loaded.rows }, scope: { files: claim.contract.files }, verification: claim.contract.checks,
  };
}

export function runClaimCommand(command, root, flags, positionalCount = 1) {
  try {
    const allowed = {
      claim: ["root", "task", "owner", "contract"], release: ["root", "task", "token"], context: ["root", "task", "change"],
    }[command];
    if (!allowed || positionalCount !== 1 || !flags || Object.keys(flags).some((key) => !allowed.includes(key) || typeof flags[key] !== "string")) fail("Unknown flags, extra positional arguments or missing flag values", "EARGS");
    if (command === "claim") {
      if (typeof flags.contract !== "string") fail("Use --task SLUG --owner IDENTITY --contract PROJECT_RELATIVE_JSON", "EARGS");
      console.log(JSON.stringify({ ok: true, claim: claimTask(root, flags.task, flags.owner, flags.contract) }, null, 2));
    } else if (command === "release") {
      if (typeof flags.token !== "string") fail("Use --task SLUG --token TOKEN", "EARGS");
      console.log(JSON.stringify({ ok: true, released: releaseTask(root, flags.task, flags.token) }, null, 2));
    } else {
      console.log(JSON.stringify(contextPacket(root, { change: flags.change, task: flags.task }), null, 2));
    }
    return 0;
  } catch (error) {
    // Do not echo native JSON parse diagnostics or argv; either may contain authority.
    console.error(`workflow ${command} error: ${error.message}`);
    return error.code === "ECLAIMED" ? 3 : 1;
  }
}
