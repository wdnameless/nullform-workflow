/**
 * tools/review/ledger-compact.mjs — Settle-compaction folding settled rows into rollup.
 *
 * Keeps durable review budget ledger <= 1 MiB while preserving rollup invariant
 * (ledger.settledNanoUsd == sum of settled charges in reservations).
 */

export function partitionReservations(reservations) {
  const settled = [];
  const nonSettled = [];
  for (const row of reservations) {
    if (row && row.status === 'settled') settled.push(row);
    else nonSettled.push(row);
  }
  return { settled, nonSettled };
}

export function foldSettledMetadata(settled) {
  let sumSettled = 0;
  let earliestCreatedAt = null;
  let latestSettledAt = null;
  for (const row of settled) {
    sumSettled += (row.settledNanoUsd || 0);
    if (row.createdAt && (!earliestCreatedAt || row.createdAt < earliestCreatedAt)) {
      earliestCreatedAt = row.createdAt;
    }
    if (row.settledAt && (!latestSettledAt || row.settledAt > latestSettledAt)) {
      latestSettledAt = row.settledAt;
    }
  }
  return { sumSettled, earliestCreatedAt, latestSettledAt };
}

export function buildRollupReservation(sumSettled, createdAt, settledAt) {
  return {
    reservationId: 'rollup-settled',
    status: 'settled',
    reservedNanoUsd: sumSettled > 0 ? sumSettled : 1,
    settledNanoUsd: sumSettled,
    maxRequests: 1,
    requests: [],
    createdAt: createdAt || new Date().toISOString(),
    settledAt: settledAt || new Date().toISOString(),
  };
}

export function compactLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.reservations)) {
    return ledger;
  }
  const { settled, nonSettled } = partitionReservations(ledger.reservations);
  if (settled.length <= 1) {
    return ledger;
  }
  const { sumSettled, earliestCreatedAt, latestSettledAt } = foldSettledMetadata(settled);
  if (!Number.isSafeInteger(sumSettled)) {
    throw new Error('Settled rollup would exceed safe integer range');
  }
  if (ledger.settledNanoUsd !== undefined && ledger.settledNanoUsd !== sumSettled) {
    throw new Error('Corrupted review budget ledger; the settled rollup disagrees with its reservations (past charges must never be dropped)');
  }
  const rollupRow = buildRollupReservation(sumSettled, earliestCreatedAt, latestSettledAt);
  ledger.reservations = [rollupRow, ...nonSettled];
  return ledger;
}
