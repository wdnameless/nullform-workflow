import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanWorktree, sourceDigest, isRealPathInsideRoot, isSecretOrCredentialPath } from './worktree-snapshot.mjs';

export function inspectProduct({ root, role, changeId }, path = '') {
  const snapshot = scanWorktree(root);
  const files = snapshot.isGit ? { ...snapshot.tracked, ...snapshot.untracked } : snapshot.files;
  const allowed = p => !isSecretOrCredentialPath(p) && !files[p]?.isSecret && (role !== 'oracle' || !p.startsWith('openspec/') || p === `openspec/changes/${changeId}/manifest.md`) && !/review-evidence.*\.json$/.test(p);
  if (!path) return Object.keys(files).filter(allowed).sort().join('\n');
  if (!Object.hasOwn(files, path) || !allowed(path) || !isRealPathInsideRoot(root, path)) throw new Error('Inspection path is outside allowed product source');
  return readFileSync(join(root, path), 'utf8');
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
  pi.registerTool({ name: 'inspect_product', label: 'Inspect product', description: 'Read product source or list available files. Credentials and oracle planning documents are inaccessible.', approval: 'read', loadMode: 'essential', parameters: pi.zod.object({ path: pi.zod.string().default('') }), async execute(_id, params) { return { content: [{ type: 'text', text: inspectProduct(options, params.path) }] }; } });
  pi.registerTool({ name: 'exercise_product', label: 'Exercise product', description: 'Execute the fixed operator-authorized consumer/test command; no arbitrary commands or arguments.', approval: 'read', loadMode: 'essential', parameters: pi.zod.object({}), async execute() {
    const startedAt = new Date().toISOString();
    const text = executeProduct(options);
    const result = JSON.parse(text);
    pi.appendEntry('workflow-product-execution', { commandHash: options.provenance.productCommandHash, sourceDigest: sourceDigest(options.root), exitCode: result.exitCode, startedAt, completedAt: new Date().toISOString(), outputHash: createHash('sha256').update(text).digest('hex') });
    return { content: [{ type: 'text', text }] };
  } });
  pi.on('tool_call', event => {
    if (!['inspect_product', 'exercise_product'].includes(event.toolName)) return { block: true, reason: 'Review execution permits only read-only product tools' };
  });
  pi.on('session_start', () => { pi.appendEntry('workflow-review-context', options.provenance); });
}
