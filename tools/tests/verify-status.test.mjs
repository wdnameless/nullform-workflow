import test from "node:test";
import assert from "node:assert/strict";

import { executeCheck } from "../verify-shared.mjs";

// Measured hole: `status = res.ok === false ? "FAIL" : (res.status || "PASS")` made a
// check that returned `{}` or `{ok: undefined}` count as a pass. A verification runner
// whose default is success verifies nothing; it reports whatever the checks happen to say
// and calls the silence agreement.

test("a check that returns nothing conclusive is UNVERIFIED, not PASS", async () => {
  for (const value of [{}, { ok: undefined }, { detail: "nothing was checked" }, null, undefined]) {
    const res = await executeCheck(1, "label", async () => value);
    assert.equal(res.status, "UNVERIFIED", `${JSON.stringify(value)} must not read as PASS`);
  }
});

test("an explicit verdict still wins", async () => {
  assert.equal((await executeCheck(1, "l", async () => ({ ok: true, detail: "fine" }))).status, "PASS");
  assert.equal((await executeCheck(1, "l", async () => ({ ok: false, detail: "broken" }))).status, "FAIL");
  assert.equal((await executeCheck(1, "l", async () => ({ status: "SETUP", detail: "unconfigured" }))).status, "SETUP");
  assert.equal((await executeCheck(1, "l", async () => true)).status, "PASS");
  assert.equal((await executeCheck(1, "l", async () => false)).status, "FAIL");
  assert.equal((await executeCheck(1, "l", async () => "a human note")).status, "PASS");
});

test("a thrown error is FAIL, and NotConfiguredError is SETUP", async () => {
  assert.equal((await executeCheck(1, "l", async () => { throw new Error("boom"); })).status, "FAIL");
  const setup = new Error("not configured");
  setup.name = "NotConfiguredError";
  assert.equal((await executeCheck(1, "l", async () => { throw setup; })).status, "SETUP");
});

test("an empty status string does not fall back to a pass", async () => {
  const res = await executeCheck(1, "l", async () => ({ status: "   " }));
  assert.equal(res.status, "UNVERIFIED");
});
