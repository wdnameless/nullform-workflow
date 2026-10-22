import assert from 'node:assert/strict';

export const TIER_CEILINGS = Object.freeze({
  T0: 200,
  T1: 500,
  T2: 2000,
  T3: 8000,
});

export function checkTripwire(diffStat, tier) {
  const ceiling = TIER_CEILINGS[tier];
  if (ceiling === undefined) {
    throw new Error(`Unknown tier '${tier}': expected one of ${Object.keys(TIER_CEILINGS).join(', ')}`);
  }

  let actual = 0;
  if (typeof diffStat === 'number') {
    actual = diffStat;
  } else if (diffStat && typeof diffStat === 'object') {
    if (Array.isArray(diffStat)) {
      actual = diffStat.reduce((acc, item) => {
        const add = item?.added ?? item?.additions ?? 0;
        const del = item?.deleted ?? item?.deletions ?? 0;
        return acc + add + del;
      }, 0);
    } else {
      const added = diffStat.added ?? diffStat.additions ?? 0;
      const deleted = diffStat.deleted ?? diffStat.deletions ?? 0;
      actual = added + deleted;
    }
  }

  if (actual > ceiling) {
    throw new Error(
      `Tripwire tripped for tier ${tier}: ceiling is ${ceiling} lines, but actual diff is ${actual} lines (added+deleted)`
    );
  }

  return true;
}

export function verifyGolden(fixture, actual) {
  if (!fixture || typeof fixture !== 'object') {
    throw new TypeError('Fixture must be a non-null object');
  }
  if (!('fields' in fixture)) {
    throw new Error("Fixture must declare 'fields'");
  }

  if (Array.isArray(fixture.fields)) {
    for (const field of fixture.fields) {
      const expected = (fixture.expected && field in fixture.expected)
        ? fixture.expected[field]
        : fixture[field];
      const actualVal = actual?.[field];
      assert.deepEqual(actualVal, expected);
    }
  } else if (fixture.fields && typeof fixture.fields === 'object') {
    for (const [field, expected] of Object.entries(fixture.fields)) {
      const actualVal = actual?.[field];
      assert.deepEqual(actualVal, expected);
    }
  } else {
    throw new TypeError('fixture.fields must be an array of field names or an object of expected fields');
  }

  return true;
}
