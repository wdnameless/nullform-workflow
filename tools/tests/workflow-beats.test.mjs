import test from "node:test";
import assert from "node:assert/strict";
import { honestTime } from "../journal.mjs";

test("honestTime: beats-delta minus waits (2 beats 10m apart, 3m wait => 7m)", () => {
  const t0 = Date.parse("2026-10-27T10:00:00.000Z");
  const journal = {
    beats: [
      new Date(t0).toISOString(),
      new Date(t0 + 10 * 60 * 1000).toISOString(),
    ],
    waits: [{
      kind: "ask",
      from: new Date(t0 + 2 * 60 * 1000).toISOString(),
      to: new Date(t0 + 5 * 60 * 1000).toISOString(),
    }],
  };
  assert.equal(honestTime(journal), 7 * 60 * 1000);
});

test("honestTime: gaps over 45m are cut as idle", () => {
  const t0 = Date.parse("2026-10-27T10:00:00.000Z");
  const journal = {
    beats: [
      new Date(t0).toISOString(),
      new Date(t0 + 10 * 60 * 1000).toISOString(),
      new Date(t0 + 130 * 60 * 1000).toISOString(),
    ],
    waits: [],
  };
  assert.equal(honestTime(journal), 10 * 60 * 1000);
});
