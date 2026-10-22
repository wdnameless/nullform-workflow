import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_COST_TIERS = Object.freeze({
  notice: 1.0,
  warning: 5.0,
  critical: 10.0,
});

export function writeSnapshot(dir, costs) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'snapshot.json');
  const tmp = join(dir, `snapshot.json.tmp.${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(costs, null, 2), 'utf8');
  renameSync(tmp, target);
  return target;
}

export function checkAlerts(state, costs, options = {}) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('state must be an object');
  }
  if (!(state.fired instanceof Set)) {
    state.fired = new Set(state.fired || []);
  }

  const tiers = options.tiers || DEFAULT_COST_TIERS;
  const total = typeof costs?.total === 'number' ? costs.total : 0;
  const sortedTiers = Object.entries(tiers).sort(([, a], [, b]) => Number(a) - Number(b));

  const alerts = [];
  for (const [tier, threshold] of sortedTiers) {
    const limit = Number(threshold);
    if (total >= limit) {
      if (!state.fired.has(tier)) {
        state.fired.add(tier);
        alerts.push(tier);
      }
    } else {
      state.fired.delete(tier);
    }
  }

  return alerts;
}
