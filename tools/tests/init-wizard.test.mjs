import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runInit,
  loadHarnessMatrix,
  getHarnessMenuItems,
  HARNESS_MENU_ITEMS,
  HARNESS_MATRIX_PATH,
  PACKAGE_ROOT,
} from "../../bin/nullform.mjs";

function createTempDir(prefix = "init-wizard-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createPipedIO(inputText = "", isTTY = true) {
  const stdin = new PassThrough();
  if (inputText !== null) {
    stdin.end(inputText);
  }
  let stdoutText = "";
  let stderrText = "";
  const stdout = {
    isTTY,
    write(chunk) {
      stdoutText += String(chunk);
    },
  };
  const stderr = {
    write(chunk) {
      stderrText += String(chunk);
    },
  };
  return {
    stdin,
    stdout,
    stderr,
    isTTY,
    getStdout: () => stdoutText,
    getStderr: () => stderrText,
  };
}

test("harness matrix schema, 8+custom entries, MIT attribution, and openhuman unverified", () => {
  const raw = readFileSync(HARNESS_MATRIX_PATH, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(parsed.some((e) => e._comment && /MIT idea credit.*agency-agents tools\.json/.test(e._comment)));

  const matrix = loadHarnessMatrix().filter((e) => e.id);
  assert.equal(matrix.length, 9);
  const ids = matrix.map((m) => m.id);
  const expectedIds = ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman", "custom"];
  for (const id of expectedIds) {
    assert.ok(ids.includes(id), `Missing harness ${id} in matrix`);
  }

  for (const entry of matrix) {
    assert.ok(entry.id, "entry has id");
    assert.ok(entry.label, `entry ${entry.id} has label`);
    assert.ok(entry.description, `entry ${entry.id} has description`);
    assert.ok(entry.detect && typeof entry.detect === "object", `entry ${entry.id} has detect`);
    assert.ok(entry.install && typeof entry.install === "object", `entry ${entry.id} has install`);
    assert.ok(Array.isArray(entry.install.projectPaths), `entry ${entry.id} has projectPaths`);
    assert.ok(Array.isArray(entry.scopes), `entry ${entry.id} has scopes`);
    assert.ok(["verified", "declared", "unverified"].includes(entry.runtime), `entry ${entry.id} has valid runtime`);
    if (entry.versions !== undefined) {
      assert.ok(entry.versions && typeof entry.versions === "object", `entry ${entry.id} versions is object`);
      assert.equal(typeof entry.versions.min, "string", `entry ${entry.id} versions.min is string`);
      assert.ok(Array.isArray(entry.versions.args), `entry ${entry.id} versions.args is array`);
    }
    if (entry.notes !== undefined) {
      assert.ok(Array.isArray(entry.notes), `entry ${entry.id} notes is array`);
      assert.ok(entry.notes.every((n) => typeof n === "string"), `entry ${entry.id} notes are strings`);
    }
  }

  const hermes = matrix.find((m) => m.id === "hermes");
  assert.equal(hermes.versions?.min, "0.20.4");
  assert.deepEqual(hermes.versions?.args, ["--version"]);
  assert.ok(Array.isArray(hermes.notes) && hermes.notes.some((n) => n.includes("MANAGED_DIR")));

  const codex = matrix.find((m) => m.id === "codex");
  assert.ok(Array.isArray(codex.notes) && codex.notes.some((n) => n.includes("catalog")));

  const openhuman = matrix.find((m) => m.id === "openhuman");
  assert.equal(openhuman.runtime, "unverified");

  const custom = matrix.find((m) => m.id === "custom");
  assert.equal(custom.runtime, "declared");
});

test("matrix fallback when harness-matrix.json is missing or corrupted", () => {
  const dummyMissing = join(PACKAGE_ROOT, "tools", "non-existent-matrix.json");
  const fallbackItems = getHarnessMenuItems(dummyMissing);
  assert.deepEqual(fallbackItems, HARNESS_MENU_ITEMS);

  // Temporary rename test on disk (restored in finally)
  const tempBackup = `${HARNESS_MATRIX_PATH}.test-bak`;
  try {
    renameSync(HARNESS_MATRIX_PATH, tempBackup);
    assert.equal(existsSync(HARNESS_MATRIX_PATH), false);
    const items = getHarnessMenuItems();
    assert.deepEqual(items, HARNESS_MENU_ITEMS);
  } finally {
    if (existsSync(tempBackup)) {
      renameSync(tempBackup, HARNESS_MATRIX_PATH);
    }
  }
});

test("wizard quick-path: selects harness, quick flow, previews plan, installs all slices", async () => {
  const tmpHome = createTempDir("wizard-quick-");
  try {
    const installCalls = [];
    const io = createPipedIO("1\nquick\ny\n", true);
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NULLFORM_USER_HOME: tmpHome };

    const code = await runInit(
      { userHome: tmpHome },
      {
        ...io,
        env,
        installHarness(opts) {
          installCalls.push(opts);
          return {
            harness: opts.harness,
            root: opts.root,
            userHome: opts.userHome,
            dryRun: opts.dryRun,
            filesToCopy: ["file1"],
            adapters: ["CLAUDE.md"],
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );

    assert.equal(code, 0);
    assert.equal(installCalls.length, 2);
    assert.equal(installCalls[0].dryRun, true);
    assert.equal(installCalls[1].dryRun, false);
    assert.equal(installCalls[1].harness, "claude");
    assert.equal(installCalls[1].flow, "quick");
    assert.deepEqual(installCalls[1].slices, ["S0", "S1", "S2", "S3", "S4"]);
    assert.match(io.getStdout(), /Slices:\s+S0, S1, S2, S3, S4/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("wizard advanced-path with slice toggle: custom slices selected and installed", async () => {
  const tmpHome = createTempDir("wizard-adv-");
  try {
    const installCalls = [];
    // 2=codex, advanced, toggle 1 (disables S1), Enter to accept, y to confirm
    const io = createPipedIO("2\nadvanced\n1\n\ny\n", true);
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NULLFORM_USER_HOME: tmpHome };

    const code = await runInit(
      { userHome: tmpHome },
      {
        ...io,
        env,
        installHarness(opts) {
          installCalls.push(opts);
          return {
            harness: opts.harness,
            root: opts.root,
            userHome: opts.userHome,
            dryRun: opts.dryRun,
            filesToCopy: ["file1"],
            adapters: ["AGENTS.md"],
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );

    assert.equal(code, 0);
    assert.equal(installCalls.length, 2);
    assert.equal(installCalls[1].harness, "codex");
    assert.equal(installCalls[1].flow, "advanced");
    assert.deepEqual(installCalls[1].slices, ["S0", "S2", "S3", "S4"]);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("wizard back-navigation (..): from flow to harness, and from slices to flow", async () => {
  const tmpHome = createTempDir("wizard-back-");
  try {
    const installCalls = [];
    // 1 (claude) -> .. (back to harness) -> 2 (codex) -> advanced -> .. (back to flow) -> quick -> y
    const io = createPipedIO("1\n..\n2\nadvanced\n..\nquick\ny\n", true);
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NULLFORM_USER_HOME: tmpHome };

    const code = await runInit(
      { userHome: tmpHome },
      {
        ...io,
        env,
        installHarness(opts) {
          installCalls.push(opts);
          return {
            harness: opts.harness,
            root: opts.root,
            userHome: opts.userHome,
            dryRun: opts.dryRun,
            filesToCopy: [],
            adapters: [],
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );

    assert.equal(code, 0);
    assert.equal(installCalls.length, 2);
    assert.equal(installCalls[1].harness, "codex");
    assert.equal(installCalls[1].flow, "quick");
    assert.deepEqual(installCalls[1].slices, ["S0", "S1", "S2", "S3", "S4"]);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("non-TTY / CI defaults: quick+all-slices, print plan, no write without --yes", async () => {
  const tmpHome = createTempDir("wizard-nontty-");
  try {
    let writeCalled = false;
    const mockInstall = (opts) => {
      if (!opts.dryRun) writeCalled = true;
      return {
        harness: opts.harness,
        root: opts.root,
        userHome: opts.userHome,
        dryRun: opts.dryRun,
        filesToCopy: ["file1"],
        adapters: ["AGENTS.md"],
      };
    };

    // 1. Non-TTY without --yes prints plan, performs zero writes, exits non-zero
    const ioNoYes = createPipedIO("", false);
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NULLFORM_USER_HOME: tmpHome };

    const codeNoYes = await runInit(
      { userHome: tmpHome, harness: "codex" },
      {
        ...ioNoYes,
        env,
        installHarness: mockInstall,
      }
    );

    assert.equal(codeNoYes, 1);
    assert.equal(writeCalled, false);
    assert.match(ioNoYes.getStdout(), /\[dry-run\] Plan for NULLFORM WORKFLOW \(codex\):/);
    assert.match(ioNoYes.getStdout(), /Slices:\s+S0, S1, S2, S3, S4/);

    // 2. Non-TTY with --dry-run prints plan, returns 0, no write
    const ioDryRun = createPipedIO("", false);
    const codeDry = await runInit(
      { userHome: tmpHome, harness: "codex", dryRun: true },
      {
        ...ioDryRun,
        env,
        installHarness: mockInstall,
      }
    );
    assert.equal(codeDry, 0);
    assert.equal(writeCalled, false);
    assert.doesNotMatch(ioDryRun.getStdout(), /~[\\/]\.omp/);

    // 3. Non-TTY with --yes writes successfully
    const ioYes = createPipedIO("", false);
    const codeYes = await runInit(
      { userHome: tmpHome, harness: "codex", yes: true },
      {
        ...ioYes,
        env,
        installHarness: mockInstall,
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );
    assert.equal(codeYes, 0);
    assert.equal(writeCalled, true);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
