import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "./test-helpers.mjs";

const CLI = fileURLToPath(new URL("../../bin/nullform.mjs", import.meta.url));

function home(t) {
  const dir = createTempDir("nf-setup-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Isolated env: never inherit the operator's real harness profiles or registry config. */
function envFor(userHome) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HERMES_|NULLFORM_|NPM_CONFIG_|npm_config_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: userHome, USERPROFILE: userHome, NULLFORM_USER_HOME: userHome,
    NF_NO_DASHBOARD: "1", NF_NO_OPEN: "1",
  });
  return env;
}

function run(userHome, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--user-home", userHome, "--json"], {
    env: envFor(userHome), encoding: "utf8", timeout: 180000, windowsHide: true, shell: false,
  });
}

test("setup --dry-run prints a plan with detection reasons and writes nothing", (t) => {
  const userHome = home(t);
  const probe = join(userHome, "probe");
  mkdirSync(probe, { recursive: true });
  const result = run(userHome, ["setup", "--dry-run", "--harness", "codex", "--root", join(userHome, "root")]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.chosen, "codex");
  assert.ok(Array.isArray(plan.actions) && plan.actions.length > 0, "plan must list actions");
  assert.equal(existsSync(join(userHome, "root")), false, "dry run must not create the install root");
  assert.equal(existsSync(join(userHome, ".nullform", "installation.json")), false, "dry run must not save state");
});

test("setup fails closed on ambiguous detection without --harness or --yes", (t) => {
  const userHome = home(t);
  // Two PATH candidates guarantee ambiguity regardless of the host's real setup.
  const bin = join(userHome, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = process.platform === "win32" ? "stub.cmd" : "stub";
  for (const name of ["claude", "codex"]) writeFileSync(join(bin, name + (process.platform === "win32" ? ".cmd" : "")), "@echo off\n", "utf8");
  const env = envFor(userHome);
  env.PATH = bin + (process.platform === "win32" ? ";" : ":") + (env.PATH || "");
  const result = spawnSync(process.execPath, [CLI, "setup", "--json", "--user-home", userHome], {
    env, encoding: "utf8", timeout: 180000, windowsHide: true,
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(result.status, 2, "ambiguity without --harness/--yes must exit 2");
  assert.equal(payload.error, "ambiguous_harness");
  assert.ok(Array.isArray(payload.candidates) && payload.candidates.length >= 2);
  assert.ok(stub.length > 0);
});

test("setup --yes saves installation state that heal can resolve", (t) => {
  const userHome = home(t);
  const root = join(userHome, "root");
  const result = run(userHome, ["setup", "--harness", "codex", "--yes", "--root", root]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const statePath = join(userHome, ".nullform", "installation.json");
  assert.equal(existsSync(statePath), true, "setup must persist installation identity");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.harness, "codex");
  assert.equal(state.root, root);
});

test("heal is a no-op on a healthy installation", (t) => {
  const userHome = home(t);
  const root = join(userHome, "root");
  assert.equal(run(userHome, ["setup", "--harness", "codex", "--yes", "--root", root]).status, 0);
  const result = run(userHome, ["heal", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(typeof payload.before.fail, "number");
  assert.equal(typeof payload.before.warn, "number");
});

test("heal reports missing state instead of guessing a target", (t) => {
  const userHome = home(t);
  const result = run(userHome, ["heal", "--dry-run"]);
  const payload = JSON.parse(result.stdout);
  assert.notEqual(result.status, 0);
  assert.equal(payload.error, "missing_state");
});
