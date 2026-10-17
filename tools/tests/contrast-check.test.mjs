import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkPair, selftest, REFERENCE_TABLE } from "../contrast-check.mjs";

test("contrast ratio matches WCAG reference extremes", () => {
  assert.equal(checkPair("#000000", "#FFFFFF").ratio.toFixed(2), "21.00");
  assert.deepEqual([checkPair("#000000", "#FFFFFF").normal, checkPair("#000000", "#FFFFFF").large], [true, true]);
});

test("near-threshold pairing prints 4.50 but fails 4.5:1 (unrounded compare)", () => {
  const r = checkPair("#777777", "#070707");
  assert.equal(r.ratio.toFixed(2), "4.50");
  assert.equal(r.normal, false);
  assert.equal(r.large, true);
});

test("selftest recomputes every reference row with zero drift", () => {
  assert.deepEqual(selftest(), []);
  assert.ok(REFERENCE_TABLE.length >= 9);
});

test("CLI exits nonzero on failing pair and 2 on bad input", () => {
  const fail = spawnSync(process.execPath, ["tools/contrast-check.mjs", "#777777", "#FFFFFF"], { encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /FAIL/);
  const bad = spawnSync(process.execPath, ["tools/contrast-check.mjs", "nope", "#fff"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const self = spawnSync(process.execPath, ["tools/contrast-check.mjs", "--selftest"], { encoding: "utf8" });
  assert.equal(self.status, 0);
  assert.match(self.stdout, /reference pairs OK/);
});
