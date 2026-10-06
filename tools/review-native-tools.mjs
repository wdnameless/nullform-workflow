import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanWorktree, sourceDigest, isRealPathInsideRoot, isPathInsideRoot, isSecretOrCredentialPath, isStructuralExcludedPath, isAcceptancePath } from './worktree-snapshot.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const MAX_AGGREGATE_CHUNK_BYTES = 28 * 1024;

function sliceUtf8Page(buffer, offset, budget) {
  const total = buffer.length;
  if (offset >= total) return { text: '', nextOffset: null };
  const target = Math.min(offset + budget, total);
  if (target >= total) {
    return { text: buffer.subarray(offset, total).toString('utf8'), nextOffset: null };
  }
  let boundary = target;
  while (boundary > offset && (buffer[boundary] & 0xC0) === 0x80) boundary--;
  if (boundary > offset) {
    const lead = buffer[boundary];
    let len = 1;
    if ((lead & 0x80) === 0) len = 1;
    else if ((lead & 0xE0) === 0xC0) len = 2;
    else if ((lead & 0xF0) === 0xE0) len = 3;
    else if ((lead & 0xF8) === 0xF0) len = 4;
    if (boundary + len <= target) boundary += len;
  }
  if (boundary <= offset) {
    const lead = buffer[offset];
    let len = 1;
    if ((lead & 0x80) === 0) len = 1;
    else if ((lead & 0xE0) === 0xC0) len = 2;
    else if ((lead & 0xF0) === 0xE0) len = 3;
    else if ((lead & 0xF8) === 0xF0) len = 4;
    boundary = Math.min(offset + len, total);
  }
  return {
    text: buffer.subarray(offset, boundary).toString('utf8'),
    nextOffset: boundary < total ? boundary : null,
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

  const budgetPerRequest = Math.floor(MAX_AGGREGATE_CHUNK_BYTES / requests.length);
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
    const contentHash = createHash('sha256').update(rawBuffer).digest('hex');
    const { text, nextOffset } = sliceUtf8Page(rawBuffer, offset, budgetPerRequest);
    pages.push({ path, kind, offset, nextOffset, totalBytes, contentHash, text });
  }
  return pages;
}
export function executeProduct({ root, productCommand }) {
  if (!Array.isArray(productCommand) || !productCommand.length || productCommand.some(x => typeof x !== 'string' || x.includes('\0')) || !productCommand[0].trim()) throw new Error('No operator-authorized product command');
  const before = sourceDigest(root);
  const result = spawnSync(productCommand[0], productCommand.slice(1), { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (sourceDigest(root) !== before) throw new Error('Product command mutated source; read-only execution violated');
  if (result.error || result.status === null) throw new Error('Product execution failed or timed out');
  return JSON.stringify({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
}
export default function (pi) {
  const options = JSON.parse(process.env.WORKFLOW_REVIEW_OPTIONS || '{}');
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
    description: 'Execute the fixed operator-authorized consumer/test command; no arbitrary commands or arguments.',
    approval: 'read',
    loadMode: 'essential',
    parameters: pi.zod.object({}),
    async execute() {
      const startedAt = new Date().toISOString();
      const text = executeProduct(options);
      const result = JSON.parse(text);
      pi.appendEntry('workflow-product-execution', { commandHash: options.provenance.productCommandHash, sourceDigest: sourceDigest(options.root), exitCode: result.exitCode, startedAt, completedAt: new Date().toISOString(), outputHash: createHash('sha256').update(text).digest('hex') });
      return { content: [{ type: 'text', text }] };
    },
  });
  pi.on('tool_call', event => {
    if (!['inspect_product', 'exercise_product'].includes(event.toolName)) return { block: true, reason: 'Review execution permits only read-only product tools' };
  });
  pi.on('session_start', () => { pi.appendEntry('workflow-review-context', options.provenance); });
}
