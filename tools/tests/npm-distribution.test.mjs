import test from "node:test";
import assert from "node:assert/strict";
import { runSmoke } from "../npm-smoke.mjs";

test("npm distribution end-to-end smoke (pack, real deps, global install, 8 harnesses, boundaries, doctor, registry update)", async () => {
  const result = await runSmoke();
  assert.equal(result.status, "success");
  assert.equal(result.version, "1.2.0", "Installed and verified version must be 1.2.0");
  assert.ok(result.tarballSha256 && result.tarballSha256.length === 64, "tarballSha256 must be present");
  assert.ok(result.tarballSha512 && result.tarballSha512.length === 128, "tarballSha512 must be present");
  assert.equal(result.outcomes?.globalInstall, "passed");
  assert.equal(result.outcomes?.registryUpgrade, "passed");
});
