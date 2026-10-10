import test from "node:test";
import assert from "node:assert/strict";
import { runSmoke } from "../npm-smoke.mjs";

test("npm distribution end-to-end smoke (pack, real deps, global install, 8 harnesses, boundaries, doctor, registry update)", async () => {
  const result = await runSmoke();
  assert.equal(result.status, "success");
});
