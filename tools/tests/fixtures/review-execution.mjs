import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runReviewRecord, recordStageB, loadReviewEvidence, saveReviewEvidence } from '../../review-evidence.mjs';
import { executeProduct } from '../../review-native-tools.mjs';

// Synthetic model replies are parser fixtures, never production proof.
// Context and product events follow the installed native JSONL session schema;
// consumer commands and Stage-B greens actually execute on the fixture source.
export function nativeRunner(sessionId = randomUUID(), usage = { input: 100, output: 50 }, verdict = 'correct', extra = {}) {
  return ({ root, changeId, productCommand, provenance } = {}) => {
    const startedAt = new Date().toISOString();
    const provider = extra.provider || 'anthropic', model = extra.model || 'claude-3-5-sonnet';
    const entries = [
      { type: 'session', version: 3, id: sessionId, timestamp: startedAt, cwd: root },
      { type: 'model_change', model: `${provider}/${model}`, role: 'default', resolvedModelIsFallback: Boolean(extra.isFallback), timestamp: startedAt },
      { type: 'custom', customType: 'workflow-review-context', timestamp: startedAt, data: provenance },
    ];
    if (provenance?.role === 'oracle') {
      const command = productCommand || (existsSync(join(root, 'tests', 'consumer.cjs')) ? [process.execPath, 'tests/consumer.cjs'] : [process.execPath, 'tests/product.test.cjs', `openspec/changes/${changeId}/manifest.md`]);
      const executionStartedAt = new Date().toISOString();
      const text = executeProduct({ root, productCommand: command });
      const completedAt = new Date().toISOString();
      entries.push({ type: 'custom', customType: 'workflow-product-execution', timestamp: completedAt, data: { commandHash: provenance.productCommandHash, sourceDigest: provenance.sourceDigest, exitCode: JSON.parse(text).exitCode, startedAt: executionStartedAt, completedAt, outputHash: createHash('sha256').update(text).digest('hex') } });
    }
    const timestamp = new Date().toISOString();
    entries.push({ type: 'message', timestamp, message: { role: 'assistant', timestamp: new Date(timestamp).getTime(), provider, model, stopReason: extra.stopReason || 'stop', usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, totalTokens: usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead || 0) + (usage.cacheWrite || 0), cost: { total: extra.costUsd ?? 0.001 } }, content: extra.content || [{ type: 'text', text: extra.text || (provenance?.role === 'oracle' ? `Verdict: ${verdict === 'correct' ? 'ACCEPT' : 'REJECT'}` : JSON.stringify({ findings: [], overall_correctness: verdict, overall_explanation: 'Fixture terminal findings retained', overall_confidence_score: 0.9 })) }] } });
    let parentId = null;
    for (const entry of entries.slice(1)) { entry.id = randomUUID(); entry.parentId = parentId; parentId = entry.id; }
    return { status: extra.status ?? 0, stdout: entries.map(e => JSON.stringify(e)).join('\n') };
  };
}
export function prepareEvidence(root, changeId) {
  const agents = join(root, 'agent', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const role of ['reviewer', 'oracle']) if (!existsSync(join(agents, `${role}.md`))) writeFileSync(join(agents, `${role}.md`), `# ${role}\n`);
  mkdirSync(join(root, 'tests'), { recursive: true });
  const path = join(root, 'tests', 'product.test.cjs');
  if (!existsSync(path)) writeFileSync(path, "const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nassert.match(fs.readFileSync(process.argv[2], 'utf8'), /R\\d\\d/);\n");
}
export function writeEvidence(root, changeDir, changeId, overrides = {}) {
  prepareEvidence(root, changeId);
  const productCommand = existsSync(join(root, 'tests', 'consumer.cjs')) ? [process.execPath, 'tests/consumer.cjs'] : [process.execPath, 'tests/product.test.cjs', `openspec/changes/${changeId}/manifest.md`];
  const testCmd = productCommand.map(p => `"${p}"`).join(' ');
  runReviewRecord({ root, changeId, role: 'reviewer', redo: true, productCommand, ompRunner: nativeRunner() });
  recordStageB({ root, changeId, phase: 'before', testCmd });
  recordStageB({ root, changeId, phase: 'after', testCmd });
  runReviewRecord({ root, changeId, role: 'oracle', productCommand, ompRunner: nativeRunner(undefined, undefined, 'correct', { text: 'Verdict: ACCEPT\nFixture product requirement verified.' }) });
  const data = loadReviewEvidence(changeDir);
  Object.assign(data.reviewer, overrides.reviewer);
  Object.assign(data.stageB, overrides.stageB);
  if (overrides.oracles) data.oracles = overrides.oracles;
  else Object.assign(data.oracles[0], overrides.oracle);
  saveReviewEvidence(changeDir, data);
  return data;
}
