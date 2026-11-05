import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createTempDir } from "./test-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "..", "install-harness.mjs");

test("real isolated install smoke across supported harnesses with target verification (R02)", () => {
  const temp = createTempDir("smoke-isolated-r02-");
  try {
    for (const h of ["claude", "codex", "opencode"]) {
      const root = join(temp, h, "target");
      const userHome = join(temp, h, "home");
      mkdirSync(root, { recursive: true });
      mkdirSync(userHome, { recursive: true });

      const installRes = spawnSync(process.execPath, [
        SCRIPT_PATH, "--harness", h, "--root", root, "--user-home", userHome, "--json"
      ], { encoding: "utf8" });
      assert.equal(installRes.status, 0, installRes.stderr);

      assert.ok(existsSync(join(root, "tools", "verify.mjs")));
      assert.ok(existsSync(join(root, "tools", "doctor.mjs")));

      const docRes = spawnSync(process.execPath, [
        join(root, "tools", "doctor.mjs"), "--harness", root
      ], { encoding: "utf8" });
      assert.equal(docRes.status, 0, docRes.stderr);
      assert.match(docRes.stdout, /OK/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
