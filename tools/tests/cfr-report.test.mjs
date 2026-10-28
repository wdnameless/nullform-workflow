/**
 * tools/tests/cfr-report.test.mjs — tests for Change Failure Rate (CFR) calculator.
 *
 * Covers:
 *   - computeCfr on empty string / empty array returns zero rate and counts
 *   - computeCfr detects conventional fix( within 48h of feat( as post-merge fix
 *   - computeCfr ignores fix( after >48h from feat(
 *   - computeCfr handles multiple feats and fixes properly
 *   - computeCfr handles fix before any feat (not a post-merge fix)
 *   - computeCfr accepts commit objects array or raw git log string fixture
 *   - computeCfr handles various conventional commit formats (feat:, feat(scope):, etc.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { computeCfr, parseGitLog } from "../cfr-report.mjs";

test("computeCfr on empty or invalid input returns zero values", () => {
  const emptyStrRes = computeCfr("");
  assert.equal(emptyStrRes.rate, 0);
  assert.equal(emptyStrRes.ratePercent, 0);
  assert.equal(emptyStrRes.totalFeats, 0);
  assert.equal(emptyStrRes.totalFixes, 0);
  assert.deepEqual(emptyStrRes.postMergeFixes, []);

  const emptyArrRes = computeCfr([]);
  assert.equal(emptyArrRes.rate, 0);
  assert.equal(emptyArrRes.totalFeats, 0);

  const nullRes = computeCfr(null);
  assert.equal(nullRes.rate, 0);
});

test("computeCfr identifies post-merge fix within 48 hours of a feat", () => {
  // Feat at T = 1729600000, Fix 12h later (43200s later = 1729643200)
  const fixture = [
    "c2|1729643200|fix(core): patch bug introduced in feature",
    "c1|1729600000|feat(core): introduce new feature",
  ].join("\n");

  const res = computeCfr(fixture);
  assert.equal(res.totalCommits, 2);
  assert.equal(res.totalFeats, 1);
  assert.equal(res.totalFixes, 1);
  assert.equal(res.postMergeFixes.length, 1);
  assert.equal(res.postMergeFixes[0].hash, "c2");
  assert.equal(res.rate, 1);
  assert.equal(res.ratePercent, 100);
});

test("computeCfr does not count fix landing >48h after feat", () => {
  // Feat at T = 1729600000, Fix 50h later (180000s later = 1729780000)
  const fixture = [
    "c2|1729780000|fix(core): late fix outside 48h window",
    "c1|1729600000|feat(core): initial feature",
  ].join("\n");

  const res = computeCfr(fixture);
  assert.equal(res.totalFeats, 1);
  assert.equal(res.totalFixes, 1);
  assert.equal(res.postMergeFixes.length, 0);
  assert.equal(res.rate, 0);
  assert.equal(res.ratePercent, 0);
});

test("computeCfr calculates rate correctly across multiple feats and fixes", () => {
  // 4 feats, 1 post-merge fix within 48h, 1 fix outside 48h
  const fixture = [
    "c6|1729950000|fix: old unrelated bug", // >48h (55.5h) after c5
    "c5|1729750000|feat(dashboard): add charts",
    "c4|1729720000|feat(metrics): add metrics",
    "c3|1729650000|fix(auth): fix token refresh", // 14h after c1 (within 48h)
    "c2|1729620000|feat(billing): subscription checkout",
    "c1|1729600000|feat(auth): add auth module",
  ].join("\n");

  const res = computeCfr(fixture);
  assert.equal(res.totalCommits, 6);
  assert.equal(res.totalFeats, 4);
  assert.equal(res.totalFixes, 2);
  assert.equal(res.postMergeFixes.length, 1);
  assert.equal(res.postMergeFixes[0].hash, "c3");
  // 1 post-merge fix / 4 feats = 0.25 (25%)
  assert.equal(res.rate, 0.25);
  assert.equal(res.ratePercent, 25);
});

test("computeCfr ignores fix before any feat", () => {
  const fixture = [
    "c2|1729650000|feat: new feature",
    "c1|1729600000|fix: standalone prior fix",
  ].join("\n");

  const res = computeCfr(fixture);
  assert.equal(res.totalFeats, 1);
  assert.equal(res.totalFixes, 1);
  assert.equal(res.postMergeFixes.length, 0);
  assert.equal(res.rate, 0);
});

test("computeCfr accepts commit objects array", () => {
  const commits = [
    { hash: "f1", at: 1729600000, subject: "feat: something" },
    { hash: "x1", at: 1729620000, subject: "fix: quick fix" },
  ];
  const res = computeCfr(commits);
  assert.equal(res.totalFeats, 1);
  assert.equal(res.totalFixes, 1);
  assert.equal(res.postMergeFixes.length, 1);
  assert.equal(res.rate, 1);
});

test("parseGitLog parses raw git log string into structured commit objects", () => {
  const raw = "abc1234|1729600000|feat(core): initial commit\n\nxyz9876|1729610000|fix: edge case\n";
  const parsed = parseGitLog(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].hash, "abc1234");
  assert.equal(parsed[0].at, 1729600000);
  assert.equal(parsed[0].subject, "feat(core): initial commit");
});

test("computeCfr: string/ms timestamps and invalid guards", () => {
  // numeric strings (git %at as text) behave like numbers
  const strRes = computeCfr("c2|1729643200|fix: s\nc1|1729600000|feat: s\n");
  assert.equal(strRes.postMergeFixes.length, 1);
  // millisecond numbers are not re-scaled (kills num<1e11 flip: 1729600000000 stays ms)
  const msRes = computeCfr([
    { hash: "f1", at: 1729600000000, subject: "feat: ms" },
    { hash: "x1", at: 1729600000000 + 12 * 3600 * 1000, subject: "fix: ms" },
  ]);
  assert.equal(msRes.postMergeFixes.length, 1);
  // ISO date strings parse via Date
  const isoRes = computeCfr([
    { hash: "f1", at: "2024-10-22T10:00:00.000Z", subject: "feat: iso" },
    { hash: "x1", at: "2024-10-22T20:00:00.000Z", subject: "fix: iso" },
  ]);
  assert.equal(isoRes.postMergeFixes.length, 1);
  // garbage timestamps → 0, never crash (kills return-0→1: delta stays 0h)
  const badRes = computeCfr([
    { hash: "f1", at: "not-a-date", subject: "feat: bad" },
    { hash: "x1", at: "also-bad", subject: "fix: bad" },
  ]);
  assert.equal(badRes.postMergeFixes.length, 1);
  assert.equal(badRes.postMergeFixes[0].deltaHours, 0);
  // null/undefined timestamp → 0, not a crash
  const nullRes = computeCfr([{ hash: "f1", at: null, subject: "feat: n" }]);
  assert.equal(nullRes.totalFeats, 1);
  // non-string parseGitLog input → []
  assert.deepEqual(parseGitLog(null), []);
  assert.deepEqual(parseGitLog(42), []);
});
