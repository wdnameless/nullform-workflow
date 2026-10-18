import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveNpmRunner } from './installation-state.mjs';
import { scanWorktree, sourceDigest, isRealPathInsideRoot, isPathInsideRoot, isSecretOrCredentialPath, isStructuralExcludedPath, isAcceptancePath, cleanGitEnv } from './worktree-snapshot.mjs';
import { withoutProviderCredential } from './review-budget.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_AGGREGATE_JSON_BYTES = 30 * 1024;

function sliceUtf8Page(buffer, offset, budget, meta) {
  const total = buffer.length;
  if (offset >= total) return { text: '', nextOffset: null };
  if (offset > 0 && (buffer[offset] & 0xC0) === 0x80) {
    throw new Error(`Invalid UTF-8 offset: ${offset} lands inside a multi-byte sequence`);
  }

  const fullRemText = UTF8_DECODER.decode(buffer.subarray(offset, total));
  const testPage = { ...meta, offset, nextOffset: null, totalBytes: total, text: fullRemText };
  if (Buffer.byteLength(JSON.stringify(testPage, null, 2), 'utf8') <= budget) {
    return { text: fullRemText, nextOffset: null };
  }

  let low = offset + 1;
  let high = Math.min(offset + budget, total);
  let bestEnd = offset;
  let bestText = '';

  while (low <= high) {
    let mid = Math.floor((low + high) / 2);
    while (mid > offset && (buffer[mid] & 0xC0) === 0x80) mid--;
    if (mid <= offset) {
      mid = offset + 1;
      while (mid < total && (buffer[mid] & 0xC0) === 0x80) mid++;
    }

    const candidateText = UTF8_DECODER.decode(buffer.subarray(offset, mid));
    const testCandidate = { ...meta, offset, nextOffset: mid < total ? mid : null, totalBytes: total, text: candidateText };
    const renderedBytes = Buffer.byteLength(JSON.stringify(testCandidate, null, 2), 'utf8');
    if (renderedBytes <= budget) {
      bestEnd = mid;
      bestText = candidateText;
      low = mid + 1;
      while (low < total && (buffer[low] & 0xC0) === 0x80) low++;
    } else {
      high = mid - 1;
    }
  }

  if (bestEnd <= offset) {
    throw new Error('Page budget too small to fit entry metadata and first character');
  }

  return {
    text: bestText,
    nextOffset: bestEnd < total ? bestEnd : null,
  };
}
export function inspectProduct(options, requests) {
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 8) {
    throw new Error('inspectProduct requires an array of 1 to 8 request objects');
  }
  const { root, role, changeId } = options || {};
  const baseRef = options?.baseRef || options?.provenance?.baseRef || null;
  const snapshot = scanWorktree(root);
  const files = snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files;
  const allowed = p => !isSecretOrCredentialPath(p) && !isStructuralExcludedPath(p) && !isAcceptancePath(p) && !files[p]?.isSecret && (role !== 'oracle' || !p.startsWith('openspec/') || p === `openspec/changes/${changeId}/manifest.md`) && !/review-evidence.*\.json$/.test(p);

  const budgetPerRequest = Math.floor(MAX_AGGREGATE_JSON_BYTES / requests.length);
  let changedList = null;
  const getChanged = () => {
    if (!changedList) {
      changedList = git(root, ['diff', '--name-only', '-z', baseRef, '--', '.']).split('\0').filter(p => p && allowed(p));
    }
    return changedList;
  };

  const pages = [];
  for (const req of requests) {
    if (!req || typeof req !== 'object') throw new Error('Each request must be an object');
    const path = typeof req.path === 'string' ? req.path : '';
    const kind = req.kind || 'source';
    const offset = req.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid request offset: ${offset}`);
    if (!['source', 'diff'].includes(kind)) throw new Error(`Invalid request kind: ${kind}`);

    let rawBuffer;
    if (kind === 'diff') {
      if (role !== 'reviewer') throw new Error('Diff inspection is available only to implementation reviewer');
      if (!baseRef) throw new Error('Diff inspection requires an explicit base revision');
      if (!path) {
        rawBuffer = Buffer.from(getChanged().sort().join('\n'), 'utf8');
      } else {
        if (!isPathInsideRoot(root, path) || !allowed(path)) throw new Error('Inspection path is outside allowed product source');
        if (!getChanged().includes(path)) throw new Error(`Inspection path has no diff against base revision: ${path}`);
        if (existsSync(join(root, path)) && !isRealPathInsideRoot(root, path)) throw new Error('Inspection path is outside allowed product source');
        rawBuffer = Buffer.from(git(root, ['--literal-pathspecs', 'diff', baseRef, '--', path]), 'utf8');
      }
    } else {
      if (!path) {
        rawBuffer = Buffer.from(Object.keys(files).filter(allowed).sort().join('\n'), 'utf8');
      } else {
        if (!Object.hasOwn(files, path) || !allowed(path) || !isRealPathInsideRoot(root, path)) throw new Error('Inspection path is outside allowed product source');
        rawBuffer = readFileSync(join(root, path));
      }
    }
    const totalBytes = rawBuffer.length;
    if (offset > totalBytes) throw new Error(`Request offset ${offset} exceeds total bytes ${totalBytes}`);
    UTF8_DECODER.decode(rawBuffer);
    const contentHash = createHash('sha256').update(rawBuffer).digest('hex');
    const meta = { path, kind, contentHash };
    const { text, nextOffset } = sliceUtf8Page(rawBuffer, offset, budgetPerRequest, meta);
    pages.push({ path, kind, offset, nextOffset, totalBytes, contentHash, text });
  }
  const totalRendered = Buffer.byteLength(JSON.stringify(pages, null, 2), 'utf8');
  if (totalRendered > 32 * 1024) throw new Error(`Aggregate rendered JSON (${totalRendered} bytes) exceeds 32KiB budget`);
  return pages;
}
/**
 * Fixed product command execution. `safeEnv` defaults to the ambient environment with
 * the provider credential removed: an operator-authorized command is outside the model
 * money ceiling, but it must never inherit (and leak) the provider key.
 */
export function executeProduct({ root, productCommand, safeEnv = null }) {
  if (!Array.isArray(productCommand) || !productCommand.length || productCommand.some(x => typeof x !== 'string' || x.includes('\0')) || !productCommand[0].trim()) throw new Error('No operator-authorized product command');
  const before = sourceDigest(root);
  let command = productCommand[0], args = productCommand.slice(1);
  if (process.platform === 'win32' && /^(?:npm|npx)(?:\.cmd)?$/i.test(command)) {
    const runner = resolveNpmRunner();
    if (!runner.usesNode) throw new Error('Native npm execution requires npm-cli.js; install npm alongside Node.js');
    const cli = /^npx/i.test(command) ? runner.prefixArgs[0].replace(/npm-cli\.js$/i, 'npx-cli.js') : runner.prefixArgs[0];
    if (!existsSync(cli)) throw new Error('Native npm entrypoint is missing');
    command = runner.command;
    args = [cli, ...args];
  }
  const env = safeEnv || withoutProviderCredential(process.env);
  const result = spawnSync(command, args, { cwd: root, env, shell: false, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (sourceDigest(root) !== before) throw new Error('Product command mutated source; read-only execution violated');
  if (result.error || result.status === null) throw new Error(`Product execution failed or timed out${result.error?.code ? ` (${result.error.code})` : ''}`);
  return JSON.stringify({ cwd: resolve(root), exitCode: result.status, stdout: UTF8_DECODER.decode(result.stdout), stderr: UTF8_DECODER.decode(result.stderr) });
}

/**
 * The single once-per-session product reader. Both the native OMP plugin path and the
 * controlled HTTP loop use this, so "execute once, then page" cannot diverge.
 * `state` carries { buffer, meta } across calls; the command runs only on offset 0 of a
 * fresh state, and every later offset (including a repeated 0) is served from the cache.
 */
export function readProductPage(state, { root, productCommand, provenance, offset = 0 }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid output offset: ${offset}`);
  if (sourceDigest(root) !== provenance.sourceDigest) throw new Error('Product source changed from review context');
  if (!state.buffer) {
    if (offset !== 0) throw new Error('Output continuation requires an initial execution at offset=0');
    const startedAt = new Date().toISOString();
    const text = executeProduct({ root, productCommand });
    const completedAt = new Date().toISOString();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('Product execution returned unparsable output'); }
    const buffer = Buffer.from(text, 'utf8');
    state.buffer = buffer;
    state.meta = { cwd: result.cwd, commandHash: provenance.productCommandHash, sourceDigest: provenance.sourceDigest,
      exitCode: result.exitCode, startedAt, completedAt, contentHash: createHash('sha256').update(buffer).digest('hex') };
  }
  const { buffer, meta } = state;
  if (offset > buffer.length) throw new Error(`Output offset ${offset} exceeds total bytes ${buffer.length}`);
  const { text, nextOffset } = sliceUtf8Page(buffer, offset, MAX_AGGREGATE_JSON_BYTES, meta);
  return { page: { ...meta, offset, nextOffset, totalBytes: buffer.length, text }, meta, execution: state.execution };
}
export default function (pi) {
  const options = JSON.parse(process.env.WORKFLOW_REVIEW_OPTIONS || '{}');
  let productOutput = null;
  let executionError = null;
  pi.registerTool({
    name: 'inspect_product',
    label: 'Inspect product',
    description: 'Read product source or inspect git diffs in bounded batches (max 8 requests) with recoverable paging. If nextOffset is not null, request subsequent page with offset=nextOffset.',
    approval: 'read',
    loadMode: 'essential',
    parameters: pi.zod.object({
      requests: pi.zod.array(pi.zod.object({
        path: pi.zod.string().default(''),
        kind: pi.zod.enum(['source', 'diff']).default('source'),
        offset: pi.zod.number().int().min(0).default(0),
      })).min(1).max(8),
    }),
    async execute(_id, params) {
      const pages = inspectProduct(options, params?.requests);
      return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
    },
  });
  pi.registerTool({
    name: 'exercise_product',
    label: 'Exercise product',
    description: 'Run the fixed operator-authorized command once per session and read its complete UTF-8 JSON output in bounded pages. Start with offset=0; follow nextOffset until null. Continuations (including offset=0 rereads) never rerun the command. Pages include cwd, exitCode, provenance and the full contentHash. No arbitrary commands, arguments, files, URLs or artifact URIs.',
    approval: 'read',
    loadMode: 'essential',
    parameters: pi.zod.object({
      offset: pi.zod.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    }).strict(),
    async execute(_id, params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'offset')) throw new Error('exercise_product accepts only an offset; command overrides are forbidden');
      const offset = Object.hasOwn(params, 'offset') ? params.offset : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid output offset: ${offset}`);
      if (executionError) throw executionError;
      if (sourceDigest(options.root) !== options.provenance.sourceDigest) throw new Error('Product source changed from native review context');
      if (!productOutput) {
        if (offset !== 0) throw new Error('Output continuation requires an initial execution at offset=0');
        try {
          const startedAt = new Date().toISOString();
          const text = executeProduct(options);
          const completedAt = new Date().toISOString();
          const result = JSON.parse(text);
          const buffer = Buffer.from(text, 'utf8');
          const contentHash = createHash('sha256').update(buffer).digest('hex');
          const meta = { cwd: result.cwd, commandHash: options.provenance.productCommandHash, sourceDigest: options.provenance.sourceDigest, exitCode: result.exitCode, startedAt, completedAt, contentHash };
          pi.appendEntry('workflow-product-execution', { commandHash: meta.commandHash, sourceDigest: meta.sourceDigest, exitCode: meta.exitCode, startedAt, completedAt, outputHash: contentHash });
          productOutput = { buffer, meta };
        } catch (error) {
          executionError = error;
          throw error;
        }
      }
      const { buffer, meta } = productOutput;
      if (offset > buffer.length) throw new Error(`Output offset ${offset} exceeds total bytes ${buffer.length}`);
      const { text, nextOffset } = sliceUtf8Page(buffer, offset, MAX_AGGREGATE_JSON_BYTES, meta);
      const page = { ...meta, offset, nextOffset, totalBytes: buffer.length, text };
      return { content: [{ type: 'text', text: JSON.stringify(page, null, 2) }], isError: meta.exitCode !== 0 };
    },
  });
  pi.on('tool_call', event => {
    if (!['inspect_product', 'exercise_product'].includes(event.toolName)) return { block: true, reason: 'Review execution permits only read-only product tools' };
  });
  pi.on('session_start', () => { pi.appendEntry('workflow-review-context', options.provenance); });
}
