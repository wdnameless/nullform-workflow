/**
 * tools/review/budget.mjs — single financial authority for controlled review.
 *
 * One permanent ledger per PROJECT, never per worktree: the ledger lives beside the
 * verified Git common directory (or, only when non-Git status is established, in the
 * canonical root). Discovery fails closed. Money is integer nano-USD throughout.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateRootPath } from '../worktree-snapshot.mjs';

export const BUDGET_LEDGER_FILE = 'nullform-review-budget.json';
// Non-Git fallback state lives under .workflow/ (structurally excluded from the source
// snapshot) so operational state can never hash itself into financial source identity.
export const BUDGET_LEDGER_DIR = '.workflow';
export const EXECUTOR = 'nullform-http-v1';
export const PINNED_PROVIDER = 'openai';
export const PINNED_MODEL = 'gpt-4o-mini-2024-07-18';
export const PINNED_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const PINNED_CONTEXT_TOKENS = 128000;
export const PINNED_MAX_OUTPUT_TOKENS = 16384;
export const PINNED_TARIFFS_USD_PER_MILLION = Object.freeze({ input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 });
export const GATEWAY_PROVIDER = 'nullform-gateway';
export const GATEWAY_MODEL = 'gemini-3.8-flash-high';
export const GATEWAY_ENDPOINT = 'https://ai-gateway.nullform.cv/v1/chat/completions';
export const GATEWAY_CONTEXT_TOKENS = 1048576;
export const GATEWAY_TARIFFS_USD_PER_MILLION = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const EVIDENCE_CLASSES = Object.freeze(['provider-direct', 'transport-fixture']);

const LOCK_FILE = 'nullform-review-budget.lock';
const NANO_PER_USD = 1e9;
const POLICY_FIELDS = ['schemaVersion', 'provider', 'model', 'transport', 'endpoint', 'ceilingUsd', 'maxRequests',
  'maxContextBytes', 'maxResponseBytes', 'maxOutputTokens', 'timeoutMs', 'maxInputTokens', 'tariffsUsdPerMillion',
  'credentialEnv', 'contextTokens'];
// Derived fields are RECOMPUTED from the pinned constants and never trusted from input;
// accepting them keeps validation idempotent for the normalized policy the child gets.
// They can never weaken the reserve, route or tariff.
const DERIVED_FIELDS = ['ceilingNanoUsd', 'tariffsNanoPerToken', 'reserveNanoUsd'];
const COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** Nano-USD per token for a published USD-per-million rate. Integer math, no float drift. */
function rateNanoPerToken(usdPerMillion) { return Math.round(usdPerMillion * 1000); }

/** Pinned tariff in integer nano-USD per token, for callers that price observed usage. */
export function pinnedTariffsNanoPerToken() { return Object.fromEntries(COUNTERS.map(key => [key, rateNanoPerToken(PINNED_TARIFFS_USD_PER_MILLION[key])])); }
export function redactSecret(text, secret) {
  const value = typeof text === 'string' ? text : '';
  if (typeof secret !== 'string' || secret.length < 8) return value;
  return value.split(secret).join('[REDACTED_PROVIDER_CREDENTIAL]');
}

/**
 * Redact every known provider credential from text: the policy-named one
 * plus the two historical pinned names (defense in depth, env may carry
 * several keys). Never throws, never requires any key to exist.
 */
export function redactPolicySecrets(text, policy = null, env = process.env) {
  let value = typeof text === 'string' ? text : '';
  const names = new Set(['OPENAI_API_KEY', 'NULLFORM_GATEWAY_API_KEY']);
  const named = policy && typeof policy.credentialEnv === 'string' ? policy.credentialEnv : '';
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(named)) names.add(named);
  for (const name of names) {
    const secret = env ? env[name] : undefined;
    if (typeof secret === 'string' && secret.length >= 8) value = value.split(secret).join('[REDACTED_PROVIDER_CREDENTIAL]');
  }
  return value;
}

/**
 * Non-throwing boundary report for --dry-run: explains WHY dispatch is unavailable
 * without launching anything. Never authorizes a run and never reads a credential.
 */
export function inspectAdmission({ policy = null, policyPath = null } = {}) {
  if (policy) return { dispatchAllowed: false, supported: true, transport: policy.transport, effectiveRoute: policy.endpoint };
  if (!policyPath) return { dispatchAllowed: false, supported: false, effectiveRoute: 'unverified', reason: 'No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON' };
  if (/openrouter/i.test(String(policyPath))) return { dispatchAllowed: false, supported: false, effectiveRoute: 'unverified', reason: 'OpenRouter and opaque providers are forbidden providers' };
  return { dispatchAllowed: false, supported: false, effectiveRoute: 'unverified', reason: 'Unsupported execution boundary: a validated admission policy plus the controlled HTTP executor is required' };
}

/** The provider credentials are never inherited by an operator-authorized product command. */
export function withoutProviderCredential(env, key = 'OPENAI_API_KEY') {
  const keys = new Set([String(key).toUpperCase(), 'OPENAI_API_KEY', 'NULLFORM_GATEWAY_API_KEY']);
  return Object.fromEntries(Object.entries(env || {}).filter(([name]) => !keys.has(name.toUpperCase())));
}

/** Nano-USD to USD for human-facing receipt fields. */
export function nanoUsdToUsd(nanoUsd) { return nanoUsd / NANO_PER_USD; }

function boundedInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid bounded admission policy ${name}`);
  return value;
}
/**
 * User-configured route: provider/model/endpoint/tariffs/credential come from
 * the admission policy (user config), validated for shape — never trusted blind.
 * Returns the route descriptor or throws with the exact defect.
 */
function userConfiguredRoute(policy) {
  if (typeof policy.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(policy.provider)) throw new Error('User-configured route: provider must be a safe identifier');
  if (typeof policy.model !== 'string' || !policy.model.trim() || policy.model.length > 128) throw new Error('User-configured route: model must be a non-empty string');
  let url = null;
  try { url = new URL(policy.endpoint); } catch { url = null; }
  const loopback = url && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (!url || (url.protocol !== 'https:' && !loopback)) throw new Error('User-configured route: endpoint must be https (http only for 127.0.0.1 fixture class)');
  if (typeof policy.credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.credentialEnv)) throw new Error('User-configured route: credentialEnv must name the credential env var');
  const contextTokens = boundedInteger(policy.contextTokens, 'contextTokens');
  if (contextTokens > GATEWAY_CONTEXT_TOKENS) throw new Error(`User-configured route: contextTokens exceeds the published cap ${GATEWAY_CONTEXT_TOKENS}`);
  const rates = policy.tariffsUsdPerMillion;
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('User-configured route: tariffsUsdPerMillion must carry all 4 finite counters');
  for (const key of COUNTERS) {
    if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || rates[key] < 0) throw new Error(`User-configured route: tariff '${key}' must be a finite number >= 0`);
  }
  return { model: policy.model, endpoint: policy.endpoint, contextTokens, tariffs: { ...rates }, credentialEnv: policy.credentialEnv };
}

/**
 * Resolve the admitted route: pinned table first, user-configured policy
 * second, OpenRouter never. Returns the route descriptor or throws.
 */
function resolveRoute(policy, PINNED_ROUTES) {
  const pinned = PINNED_ROUTES[policy.provider];
  if (pinned) return pinned;
  if (/openrouter/i.test(String(policy.provider))) throw new Error(`Forbidden provider '${policy.provider}': OpenRouter and opaque gateways are never admitted`);
  const userRoute = userConfiguredRoute(policy);
  if (!userRoute) throw new Error(`Unsupported execution boundary: provider '${policy.provider}' is not a verified admitted route, so its routing, retries and output limits cannot be enforced`);
  return userRoute;
}

/**
 * The only policy validator. A caller can never lower the reserve, rename the route,
 * re-price the pinned snapshot, or relocate the ledger.
 */
export function validatePolicy(policy) {
  if (!policy || Array.isArray(policy) || typeof policy !== 'object' || policy.schemaVersion !== 1) throw new Error('Invalid bounded admission policy schema');
  if (Object.keys(policy).some(key => !POLICY_FIELDS.includes(key) && !DERIVED_FIELDS.includes(key))) throw new Error('Invalid bounded admission policy schema: unknown field');
  const PINNED_ROUTES = {
    [PINNED_PROVIDER]: { model: PINNED_MODEL, endpoint: PINNED_ENDPOINT, contextTokens: PINNED_CONTEXT_TOKENS, tariffs: PINNED_TARIFFS_USD_PER_MILLION },
    [GATEWAY_PROVIDER]: { model: GATEWAY_MODEL, endpoint: GATEWAY_ENDPOINT, contextTokens: GATEWAY_CONTEXT_TOKENS, tariffs: GATEWAY_TARIFFS_USD_PER_MILLION },
  };
  const route = resolveRoute(policy, PINNED_ROUTES);
  if (policy.transport !== EXECUTOR) throw new Error(`Unsupported execution boundary: transport must be exactly '${EXECUTOR}'`);
  if (policy.endpoint !== route.endpoint) throw new Error('Unverified endpoint route refused; endpoint must match the admitted route');
  if (policy.model !== route.model) throw new Error(`Admission policy model must be the verified exact snapshot '${route.model}'`);
  if (typeof policy.ceilingUsd !== 'number' || !Number.isFinite(policy.ceilingUsd) || policy.ceilingUsd <= 0) throw new Error('Invalid admission policy ceiling');
  const ceilingNanoUsd = Math.floor(policy.ceilingUsd * NANO_PER_USD);
  if (!Number.isSafeInteger(ceilingNanoUsd) || ceilingNanoUsd < 1) throw new Error('Invalid admission policy ceiling');
  const maxRequests = boundedInteger(policy.maxRequests, 'maxRequests');
  const maxContextBytes = boundedInteger(policy.maxContextBytes, 'maxContextBytes');
  const maxResponseBytes = boundedInteger(policy.maxResponseBytes, 'maxResponseBytes');
  const maxOutputTokens = boundedInteger(policy.maxOutputTokens, 'maxOutputTokens');
  const timeoutMs = boundedInteger(policy.timeoutMs, 'timeoutMs');
  if (maxOutputTokens > PINNED_MAX_OUTPUT_TOKENS) throw new Error(`Admission policy maxOutputTokens exceeds the published descriptor limit ${PINNED_MAX_OUTPUT_TOKENS}`);
  if (policy.maxInputTokens !== undefined && policy.maxInputTokens !== route.contextTokens) throw new Error(`Admission policy maxInputTokens cannot lower the verified window; it must be absent or exactly ${route.contextTokens}`);
  const rates = policy.tariffsUsdPerMillion;
  if (!rates || typeof rates !== 'object' || Array.isArray(rates) || Object.keys(rates).length !== COUNTERS.length
    || COUNTERS.some(key => rates[key] !== route.tariffs[key])) throw new Error('Unknown or invalid fixed admission tariff; unknown cost is not zero');
  const tariffsNanoPerToken = Object.fromEntries(COUNTERS.map(key => [key, rateNanoPerToken(rates[key])]));
  // Full authorized session at the verified window and highest input tariff plus capped output.
  // A zero-tariff subscription route still reserves a nonzero floor so the ledger stays meaningful.
  const pricedReserve = maxRequests * (route.contextTokens * tariffsNanoPerToken.input + maxOutputTokens * tariffsNanoPerToken.output);
  const reserveNanoUsd = pricedReserve > 0 ? pricedReserve : maxRequests;
  if (!Number.isSafeInteger(reserveNanoUsd) || reserveNanoUsd < 1) throw new Error('Invalid admission policy reserve');
  return Object.freeze({ schemaVersion: 1, provider: policy.provider, model: route.model, transport: EXECUTOR, endpoint: route.endpoint,
    ceilingUsd: policy.ceilingUsd, ceilingNanoUsd, maxRequests, maxContextBytes, maxResponseBytes, maxOutputTokens, timeoutMs,
    tariffsUsdPerMillion: { ...route.tariffs }, tariffsNanoPerToken, reserveNanoUsd,
    ...(route.credentialEnv ? { credentialEnv: route.credentialEnv, contextTokens: route.contextTokens } : {}) });
}

/** Observed provider usage priced at the ORIGINAL captured tariff. Never assumes zero. */
export function usageCostNanoUsd(usage, tariffsNanoPerToken) {
  if (!usage || typeof usage !== 'object') throw new Error('Missing observed usage; unknown spend is not zero');
  if (!tariffsNanoPerToken || COUNTERS.some(key => !Number.isSafeInteger(tariffsNanoPerToken[key]))) throw new Error('Missing captured tariff contract; refusing to price unknown usage as zero');
  const values = {};
  for (const key of COUNTERS) values[key] = boundedInteger(usage[key] ?? 0, key, 0);
  if (values.cacheRead > values.input) throw new Error('Observed cached tokens exceed observed prompt tokens');
  return (values.input - values.cacheRead) * tariffsNanoPerToken.input + values.cacheRead * tariffsNanoPerToken.cacheRead
    + values.output * tariffsNanoPerToken.output + values.cacheWrite * tariffsNanoPerToken.cacheWrite;
}

function hasGitMarker(root) {
  for (let dir = root; ;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * A budget authority directory must be a real directory whose ancestors are not links.
 * A symlinked authority could redirect every read/write to another project's ledger.
 */
function assertPlainAuthority(dir, canonicalRoot, label) {
  if (!existsSync(dir)) {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) throw new Error(`${label} '${dir}' is a dangling link; refusing an unverified budget authority`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const parent = dirname(dir);
    if (parent !== dir) assertPlainAuthority(parent, canonicalRoot, label);
    return;
  }
  if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) throw new Error(`${label} '${dir}' is a link or not a directory; refusing an unverified budget authority`);
  for (let current = dir; current !== dirname(current); current = dirname(current)) {
    if (current === canonicalRoot) break;
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`${label} '${dir}' has a link/junction ancestor '${current}'; refusing an unverified budget authority`);
  }
}

/** The ledger leaf itself must never be a link, and its parent must be a real directory. */
function assertPlainLeaf(ledgerPath) {
  if (existsSync(ledgerPath) && lstatSync(ledgerPath).isSymbolicLink()) throw new Error(`Budget ledger '${ledgerPath}' is a link/junction; refusing to read or write through it`);
  const parent = dirname(ledgerPath);
  if (existsSync(parent) && (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory())) throw new Error(`Budget ledger directory '${parent}' is a link or not a directory; refusing to read or write`);
}

function runGitDiscovery(root) {
  // Ambient GIT_* must never redirect the authority to a foreign repository.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' };
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (result.error) return { ok: false, establishedNonGit: false, detail: `git discovery failed (${result.error.code || result.error.message})` };
  if (result.status === 0) return { ok: true, commonDir: String(result.stdout || '').trim() };
  const notARepository = /not a git repository/i.test(`${result.stdout || ''}${result.stderr || ''}`);
  return { ok: false, establishedNonGit: notARepository, detail: notARepository ? 'git reports no repository' : `git discovery failed (exit ${result.status})` };
}

/**
 * Canonical, trusted budget authority. Non-Git fallback is permitted only when
 * non-Git status is established; an existing .git marker plus failed discovery is
 * a hard failure, never a second root-level ceiling.
 */
export function resolveBudgetAuthority(root) {
  const canonicalRoot = realpathSync(validateRootPath(root));
  const fallbackLedger = join(canonicalRoot, BUDGET_LEDGER_DIR, BUDGET_LEDGER_FILE);
  // R1: Reject foreign or non-directory .git at the root BEFORE discovery.
  const rootGit = join(canonicalRoot, '.git');
  try {
    const rootGitStat = lstatSync(rootGit);
    if (rootGitStat.isSymbolicLink()) throw new Error(`Root '.git' is a link; refusing an unverified budget authority (foreign metadata)`);
    if (!rootGitStat.isDirectory()) {
      // gitfile (worktree): resolve gitdir, then commondir if present, verify real Git metadata
      const gitfileContent = readFileSync(rootGit, 'utf8').trim();
      if (gitfileContent.startsWith('gitdir:')) {
        let gitdir = resolve(canonicalRoot, gitfileContent.slice(7).trim());
        const commondirFile = join(gitdir, 'commondir');
        if (existsSync(commondirFile)) {
          gitdir = resolve(gitdir, readFileSync(commondirFile, 'utf8').trim());
        }
        const gitdirStat = lstatSync(gitdir);
        if (gitdirStat.isSymbolicLink()) throw new Error(`Resolved gitdir '${gitdir}' is a link; refusing an unverified budget authority`);
        if (!statSync(gitdir).isDirectory()) throw new Error(`Resolved gitdir '${gitdir}' is not a directory; refusing an unverified budget authority`);
        if (basename(gitdir) !== '.git') {
          const hasGitMetadata = existsSync(join(gitdir, 'HEAD')) && existsSync(join(gitdir, 'objects')) && existsSync(join(gitdir, 'refs'));
          if (!hasGitMetadata) throw new Error(`Resolved gitdir '${gitdir}' is not a real Git metadata directory; refusing an unverified budget authority`);
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const discovery = runGitDiscovery(canonicalRoot);
  if (discovery.ok) {
    if (!discovery.commonDir) throw new Error('Git discovery returned an empty common directory; refusing an unverified budget authority (fail closed)');
    const commonDir = realpathSync(resolve(canonicalRoot, discovery.commonDir));
    assertPlainAuthority(commonDir, canonicalRoot, 'Git common directory');
    // The shared authority is the repository's own Git metadata directory, nothing else.
    if (basename(commonDir) !== '.git') throw new Error(`Git common directory '${commonDir}' is not a '.git' metadata directory; refusing an unscoped budget authority`);
    const ledgerPath = join(commonDir, BUDGET_LEDGER_FILE);
    // A fallback ledger that predates `git init` must never be silently abandoned for a
    // fresh, empty Git-side ceiling: the second admission would succeed under the same
    // ceiling and the earlier spend would vanish.
    if (existsSync(fallbackLedger) && !existsSync(ledgerPath)) {
      throw new Error(`A non-Git fallback budget ledger exists at ${fallbackLedger} while this root is now Git-managed. Refusing to start a second, empty ceiling: move the ledger explicitly to ${ledgerPath}, then retry.`);
    }
    assertPlainLeaf(ledgerPath);
    return { kind: 'git-common', authority: commonDir, ledgerPath };
  }
  if (hasGitMarker(canonicalRoot) || !discovery.establishedNonGit) {
    throw new Error(`Git discovery failed for ${canonicalRoot} (${discovery.detail}); refusing to create a second root-level budget ledger (fail closed). Resolve the Git metadata failure; never delete or evict shared ledger state to recover.`);
  }
  const stateDir = join(canonicalRoot, BUDGET_LEDGER_DIR);
  const ledgerPath = join(stateDir, BUDGET_LEDGER_FILE);
  try {
    const stateDirStat = lstatSync(stateDir);
    if (stateDirStat.isSymbolicLink()) throw new Error(`Budget state directory '${stateDir}' is a link; refusing an unverified budget authority`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  assertPlainAuthority(stateDir, canonicalRoot, 'Budget state directory');
  assertPlainLeaf(ledgerPath);
  return { kind: 'root', authority: canonicalRoot, stateDir, ledgerPath };
}

const MAX_LEDGER_BYTES = 1024 * 1024; // 1 MiB documented bound
const MAX_HELD_REASON_CHARS = 512;
const REQUEST_RECORD_GROWTH_BYTES = 128;
const TERMINAL_METADATA_GROWTH_BYTES = (MAX_HELD_REASON_CHARS * 6) + 128;
function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return { settledNanoUsd: 0, reservations: [] };
  const fileSize = statSync(ledgerPath).size;
  if (fileSize > MAX_LEDGER_BYTES) throw new Error(`Budget ledger '${ledgerPath}' is ${fileSize} bytes, exceeding the ${MAX_LEDGER_BYTES}-byte bound; refusing to parse`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { throw new Error('Corrupted review budget ledger; refusing to spend against unknown state'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Number.isSafeInteger(parsed.settledNanoUsd) || parsed.settledNanoUsd < 0 || !Array.isArray(parsed.reservations)) {
    throw new Error('Corrupted review budget ledger; refusing to spend against unknown state');
  }
  const seen = new Set();
  let rollup = 0;
  for (const row of parsed.reservations) {
    if (!row || typeof row.reservationId !== 'string' || !row.reservationId || seen.has(row.reservationId)) throw new Error('Corrupted review budget ledger; refusing to spend against unknown state');
    seen.add(row.reservationId);
    if (!['reserved', 'settled', 'held'].includes(row.status)) throw new Error('Corrupted review budget ledger; refusing to spend against unknown state');
    if (!Number.isSafeInteger(row.reservedNanoUsd) || row.reservedNanoUsd < 1) throw new Error('Corrupted review budget ledger; refusing to spend against unknown state');
    if (!Number.isSafeInteger(row.maxRequests) || row.maxRequests < 1) throw new Error('Corrupted review budget ledger; a reservation must record its allocated request bound');
    if (!Array.isArray(row.requests) || row.requests.length > row.maxRequests) throw new Error('Corrupted review budget ledger; recorded requests exceed the allocated bound');
    row.requests.forEach((entry, index) => { if (!entry || entry.ordinal !== index + 1) throw new Error('Corrupted review budget ledger; request ordinals must be contiguous from 1'); });
    if (row.status === 'settled') {
      if (!Number.isSafeInteger(row.settledNanoUsd) || row.settledNanoUsd < 0 || row.settledNanoUsd > row.reservedNanoUsd) throw new Error('Corrupted review budget ledger; a settled charge must be a safe integer within its reservation');
      rollup += row.settledNanoUsd;
    }
  }
  if (rollup !== parsed.settledNanoUsd) throw new Error('Corrupted review budget ledger; the settled rollup disagrees with its reservations (past charges must never be dropped)');
  return parsed;
}

function writeLedger(ledgerPath, ledger) {
  const formatted = `${JSON.stringify(ledger, null, 2)}\n`;
  const byteLength = Buffer.byteLength(formatted, 'utf8');
  if (byteLength > MAX_LEDGER_BYTES) {
    throw new Error(`Budget ledger '${ledgerPath}' is ${byteLength} bytes, exceeding the ${MAX_LEDGER_BYTES}-byte bound; refusing to write`);
  }
  const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, formatted); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, ledgerPath);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(ledgerPath), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temporary, { force: true }); }
}

// Cross-process serialization. A held lock is never auto-evicted, including after a crash.
function withLedgerLock(authority, run) {
  // The lock lives beside the ledger it guards, so a non-Git root's .workflow state
  // directory is created once and both files always share a directory.
  const stateDir = dirname(authority.ledgerPath);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (lstatSync(stateDir).isSymbolicLink()) throw new Error(`Budget state directory '${stateDir}' is a link; refusing to create or use a linked authority directory`);
  const path = join(stateDir, LOCK_FILE);
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { writeFileSync(path, payload, { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        let owner = 'unreadable/malformed record; owner identity uncertain';
        try { const { pid, token: held, createdAt } = JSON.parse(readFileSync(path, 'utf8')); owner = `pid=${pid}, token=${held}, createdAt=${createdAt}`; } catch {}
        throw new Error(`Review budget ledger is locked: ${path}. Owner: ${owner}. Never auto-evicted.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return run(); }
  finally {
    // Releasing our own lock must never mask the run's real result. A lock that is already gone
    // (externally removed, crash recovery) is expected; any other IO error still surfaces.
    try { if (readFileSync(path, 'utf8') === payload) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}


function outstandingNanoUsd(ledger) {
  return ledger.reservations.filter(row => row.status !== 'settled').reduce((total, row) => total + row.reservedNanoUsd, 0);
}

/** Reserve a full authorized session before any child exists. */
export function admitSession({ root, policy }) {
  const normalized = validatePolicy(policy);
  const authority = resolveBudgetAuthority(root);
  return withLedgerLock(authority, () => {
    const ledger = readLedger(authority.ledgerPath);
    const outstanding = outstandingNanoUsd(ledger);
    const held = ledger.reservations.filter(row => row.status === 'held').length;
    if (held > 0) {
      throw new Error(`Review budget refused: ${held} reservation(s) are held for unknown spend and block fresh admission regardless of ceiling`);
    }
    if (ledger.settledNanoUsd + outstanding + normalized.reserveNanoUsd > normalized.ceilingNanoUsd) {
      throw new Error(`Review budget refused: settled ${ledger.settledNanoUsd} + outstanding ${outstanding} + reserve ${normalized.reserveNanoUsd} exceeds ceiling ${normalized.ceilingNanoUsd} nanoUSD`);
    }
    // Construct the actual new reservation in memory first
    const reservation = {
      reservationId: randomUUID(),
      status: 'reserved',
      reservedNanoUsd: normalized.reserveNanoUsd,
      requests: [],
      maxRequests: normalized.maxRequests,
      createdAt: new Date().toISOString(),
      model: normalized.model,
      tariffsNanoPerToken: { ...normalized.tariffsNanoPerToken }
    };

    // Canonical serialized size with the new reservation included (canonicalizes compact existing bytes)
    const candidateLedger = { ...ledger, reservations: [...ledger.reservations, reservation] };
    const baseSerializedBytes = Buffer.byteLength(`${JSON.stringify(candidateLedger, null, 2)}\n`, 'utf8');

    // Conservatively account remaining request records and terminal growth for ALL outstanding reserved rows
    let maxFutureGrowth = 0;
    for (const row of candidateLedger.reservations) {
      if (row.status === 'reserved') {
        const remainingRequests = Math.max(0, (row.maxRequests || 0) - (row.requests?.length || 0));
        maxFutureGrowth += (remainingRequests * REQUEST_RECORD_GROWTH_BYTES) + TERMINAL_METADATA_GROWTH_BYTES;
      }
    }

    const projectedMaxBytes = baseSerializedBytes + maxFutureGrowth;
    if (projectedMaxBytes > MAX_LEDGER_BYTES) {
      throw new Error(`Review budget refused: ledger persistence capacity exceeded (${projectedMaxBytes} projected > ${MAX_LEDGER_BYTES} byte limit); refusing to authorize session whose accounting cannot remain writable through settlement`);
    }

    ledger.reservations.push(reservation);
    writeLedger(authority.ledgerPath, ledger);
    return { reservationId: reservation.reservationId, reservedNanoUsd: reservation.reservedNanoUsd, kind: authority.kind, authority: authority.authority, ledgerPath: authority.ledgerPath };
  });
}

/** Every mutation re-resolves authority and re-reads the ledger under the cross-process lock. */
function withReservation(root, reservationId, apply) {
  const authority = resolveBudgetAuthority(root);
  return withLedgerLock(authority, () => {
    const ledger = readLedger(authority.ledgerPath);
    const reservation = ledger.reservations.find(row => row.reservationId === reservationId);
    if (!reservation) throw new Error('Unknown review reservation; refusing to touch missing durable authority');
    if (reservation.status !== 'reserved') throw new Error(`Review reservation is already ${reservation.status}`);
    const result = apply(reservation, ledger);
    writeLedger(authority.ledgerPath, ledger);
    return result;
  });
}

/** Each physical wire call consumes one reserved request BEFORE it is sent. */
export function recordRequest({ root, reservationId }) {
  return withReservation(root, reservationId, reservation => {
    // The allocated bound is durable state, not a caller promise.
    if (reservation.requests.length >= reservation.maxRequests) throw new Error(`Review reservation exhausted its allocated ${reservation.maxRequests} request(s); refusing another physical request`);
    reservation.requests.push({ ordinal: reservation.requests.length + 1, at: new Date().toISOString() });
    return reservation.requests.length;
  });
}

/** Settle only trustworthy observed usage, priced at the reservation's captured tariff. */
export function settleReservation({ root, reservationId, usage }) {
  return withReservation(root, reservationId, (reservation, ledger) => {
    const settledNanoUsd = usageCostNanoUsd(usage, reservation.tariffsNanoPerToken);
    // Observed usage can never exceed what the full-window reservation authorized.
    if (!Number.isSafeInteger(settledNanoUsd) || settledNanoUsd < 0 || settledNanoUsd > reservation.reservedNanoUsd) {
      throw new Error(`Observed spend ${settledNanoUsd} nanoUSD is outside the reserved ${reservation.reservedNanoUsd}; holding instead of settling an unbounded charge`);
    }
    reservation.settledNanoUsd = settledNanoUsd;
    reservation.settledAt = new Date().toISOString();
    reservation.status = 'settled';
    const newTotal = ledger.settledNanoUsd + settledNanoUsd;
    if (!Number.isSafeInteger(newTotal)) throw new Error('Settlement would produce unsafe integer; refusing');
    ledger.settledNanoUsd = newTotal;
    return { reservationId, settledNanoUsd, totalSettledNanoUsd: ledger.settledNanoUsd };
  });
}

export function holdReservation({ root, reservationId, reason, policy = null }) {
  return withReservation(root, reservationId, reservation => {
    reservation.status = 'held';
    reservation.heldReason = redactPolicySecrets(String(reason || 'unknown outcome'), policy).slice(0, MAX_HELD_REASON_CHARS);
    reservation.heldAt = new Date().toISOString();
    return { reservationId, heldNanoUsd: reservation.reservedNanoUsd };
  });
}

/**
 * Read-only budget inspection: resolve authority and report totals without
 * creating directories, acquiring locks, or mutating ledger state.
 * Returns { totalSettledNanoUsd, requiredReserveNanoUsd, reservationCount, kind }.
 */
export function inspectBudget({ root, policy = null }) {
  const normalized = policy ? validatePolicy(policy) : null;
  const authority = resolveBudgetAuthority(root);
  const ledger = readLedger(authority.ledgerPath);
  return {
    totalSettledNanoUsd: ledger.settledNanoUsd,
    requiredReserveNanoUsd: normalized ? normalized.reserveNanoUsd : null,
    reservationCount: ledger.reservations.length,
    kind: authority.kind,
    authority: authority.authority,
    ...(normalized ? {} : { available: false, reason: 'No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON' }),
  };
}

export const SPEND_LEDGER_FILE = 'nullform-spend-ledger.json';

export const DEFAULT_TIER_CEILINGS_NANO_USD = Object.freeze({
  T1: 10_000_000_000,
  T2: 50_000_000_000,
  T3: 100_000_000_000,
});
export const DEFAULT_TIER_CEILINGS = DEFAULT_TIER_CEILINGS_NANO_USD;
export const DEFAULT_CEILINGS_NANO = DEFAULT_TIER_CEILINGS_NANO_USD;

function resolveSpendLedgerPath(dir) {
  if (typeof dir !== 'string' || !dir) throw new Error('Invalid directory path for spend ledger');
  if (dir.endsWith('.json')) return resolve(dir);

  const directSpend = join(dir, SPEND_LEDGER_FILE);
  if (existsSync(directSpend)) return resolve(directSpend);

  const altSpend = join(dir, 'spend-ledger.json');
  if (existsSync(altSpend)) return resolve(altSpend);

  const wfSpend = join(dir, BUDGET_LEDGER_DIR, SPEND_LEDGER_FILE);
  if (existsSync(wfSpend)) return resolve(wfSpend);

  const wfAltSpend = join(dir, BUDGET_LEDGER_DIR, 'spend-ledger.json');
  if (existsSync(wfAltSpend)) return resolve(wfAltSpend);

  if (existsSync(join(dir, BUDGET_LEDGER_DIR))) {
    return resolve(join(dir, BUDGET_LEDGER_DIR, SPEND_LEDGER_FILE));
  }

  return resolve(directSpend);
}

export function loadSpendLedger(dir) {
  if (typeof dir !== 'string' || !dir) throw new Error('Invalid directory path for loadSpendLedger');
  const ledgerPath = resolveSpendLedgerPath(dir);
  if (!existsSync(ledgerPath)) {
    return {
      ceilings: { ...DEFAULT_TIER_CEILINGS_NANO_USD },
      used: { T1: 0, T2: 0, T3: 0 },
      receipts: [],
    };
  }

  return withLedgerLock({ ledgerPath }, () => {
    const fileSize = statSync(ledgerPath).size;
    if (fileSize > MAX_LEDGER_BYTES) {
      throw new Error(`Spend ledger '${ledgerPath}' is ${fileSize} bytes, exceeding the ${MAX_LEDGER_BYTES}-byte bound; refusing to parse`);
    }
    const raw = readFileSync(ledgerPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupted spend ledger '${ledgerPath}'; refusing to spend against unknown state`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Corrupted spend ledger '${ledgerPath}'; invalid root object`);
    }
    return {
      ...parsed,
      ceilings: {
        ...DEFAULT_TIER_CEILINGS_NANO_USD,
        ...(parsed.ceilings && typeof parsed.ceilings === 'object' ? parsed.ceilings : {}),
      },
      used: {
        T1: 0,
        T2: 0,
        T3: 0,
        ...(parsed.used && typeof parsed.used === 'object' ? parsed.used : {}),
      },
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    };
  });
}

export function saveSpendLedger(dir, ledger) {
  if (typeof dir !== 'string' || !dir) throw new Error('Invalid directory path for saveSpendLedger');
  if (!ledger || typeof ledger !== 'object') throw new Error('Invalid ledger for saveSpendLedger');

  const normalized = {
    ...ledger,
    ceilings: {
      ...DEFAULT_TIER_CEILINGS_NANO_USD,
      ...(ledger.ceilings && typeof ledger.ceilings === 'object' ? ledger.ceilings : {}),
    },
    used: {
      T1: 0,
      T2: 0,
      T3: 0,
      ...(ledger.used && typeof ledger.used === 'object' ? ledger.used : {}),
    },
    receipts: Array.isArray(ledger.receipts) ? ledger.receipts : [],
  };

  const ledgerPath = resolveSpendLedgerPath(dir);
  const targetDir = dirname(ledgerPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  withLedgerLock({ ledgerPath }, () => {
    writeLedger(ledgerPath, normalized);
  });

  return normalized;
}

export function recordReceipt(ledger, receipt) {
  if (!ledger || typeof ledger !== 'object') throw new Error('Invalid ledger');
  if (!receipt || typeof receipt !== 'object') throw new Error('Invalid receipt');
  if (typeof receipt.id !== 'string' || !receipt.id.trim()) {
    throw new Error('Receipt must have a non-empty string id');
  }
  const tier = receipt.tier;
  if (!['T1', 'T2', 'T3'].includes(tier)) {
    throw new Error(`Invalid receipt tier '${tier}'; must be T1, T2, or T3`);
  }
  if (!Number.isSafeInteger(receipt.costNano) || receipt.costNano < 0) {
    throw new Error(`Invalid receipt costNano '${receipt.costNano}'; must be a non-negative safe integer`);
  }

  if (!Array.isArray(ledger.receipts)) {
    ledger.receipts = [];
  }
  if (!ledger.used || typeof ledger.used !== 'object') {
    ledger.used = { T1: 0, T2: 0, T3: 0 };
  }

  const existing = ledger.receipts.find(r => r && r.id === receipt.id);
  if (existing) {
    return ledger;
  }

  const newUsed = (ledger.used[tier] || 0) + receipt.costNano;
  if (!Number.isSafeInteger(newUsed)) {
    throw new Error(`Recording receipt would exceed safe integer range for tier ${tier}`);
  }

  ledger.receipts.push({
    ...receipt,
  });
  ledger.used[tier] = newUsed;

  return ledger;
}

 export function admit(ledger, tier, costNano = 0) {
  if (!ledger || typeof ledger !== 'object') throw new Error('Invalid ledger');
  if (!['T1', 'T2', 'T3'].includes(tier)) throw new Error(`Invalid tier '${tier}'; must be T1, T2, or T3`);
  if (!Number.isSafeInteger(costNano) || costNano < 0) {
    throw new Error(`Invalid costNano '${costNano}'; must be a non-negative safe integer`);
  }

  const used = (ledger.used && Number.isSafeInteger(ledger.used[tier])) ? ledger.used[tier] : 0;
  const ceiling = (ledger.ceilings && Number.isSafeInteger(ledger.ceilings[tier]))
    ? ledger.ceilings[tier]
    : (DEFAULT_TIER_CEILINGS_NANO_USD[tier] ?? 0);

  if (used + costNano > ceiling) {
    throw new Error(`Spend ceiling exceeded for tier ${tier}: used ${used} + requested ${costNano} = ${used + costNano} exceeds ceiling ${ceiling} nanoUSD`);
  }

  return true;
}
