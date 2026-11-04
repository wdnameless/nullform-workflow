import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRoots, SUPPORTED_VERIFY_HARNESSES } from "../verify.mjs";

test("SUPPORTED_VERIFY_HARNESSES contains exactly claude, codex, and opencode", () => {
  assert.deepEqual(SUPPORTED_VERIFY_HARNESSES, ["claude", "codex", "opencode"]);
});

test("resolveRoots resolves agentDir for claude without hardcoded omp", () => {
  const home = process.platform === "win32" ? "C:\\fake\\user" : "/fake/user";
  const roots = resolveRoots({ harness: "claude", userHome: home });
  assert.equal(roots.harness, "claude");
  assert.equal(roots.agentDir, join(home, ".claude"));
});

test("resolveRoots resolves agentDir for codex without hardcoded omp", () => {
  const home = process.platform === "win32" ? "C:\\fake\\user" : "/fake/user";
  const roots = resolveRoots({ harness: "codex", userHome: home });
  assert.equal(roots.harness, "codex");
  assert.equal(roots.agentDir, join(home, ".codex"));
});

test("resolveRoots resolves agentDir for opencode without hardcoded omp", () => {
  const home = process.platform === "win32" ? "C:\\fake\\user" : "/fake/user";
  const roots = resolveRoots({ harness: "opencode", userHome: home });
  assert.equal(roots.harness, "opencode");
  assert.equal(roots.agentDir, join(home, ".config", "opencode"));
});

test("resolveRoots rejects the other 5 harnesses (omp, cursor, hermes, openclaw, openhuman)", () => {
  const home = process.platform === "win32" ? "C:\\fake\\user" : "/fake/user";
  for (const h of ["omp", "cursor", "hermes", "openclaw", "openhuman", "unknown"]) {
    assert.throws(
      () => resolveRoots({ harness: h, userHome: home }),
      /Unsupported harness/i,
      `Expected harness '${h}' to be rejected as OUT`
    );
  }
});

test("CLI --harness rejects unsupported harness with nonzero exit", () => {
  const res = spawnSync(process.execPath, ["tools/verify.mjs", "--harness", "omp"], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /Unsupported harness/i);
});
