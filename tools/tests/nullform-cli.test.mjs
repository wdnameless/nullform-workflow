import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  HARNESS_CHOICES,
  HARNESS_MENU_ITEMS,
  readPackageVersion,
  parseCliArgs,
  resolveMenuSelection,
  getStateFilePath,
  readInstallationState,
  writeInstallationState,
  main,
} from "../../bin/nullform.mjs";

function createTempDir(prefix = "nullform-cli-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createIO(inputText = null, isTTY = false) {
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

test("parseCliArgs and resolveMenuSelection cover 8 named harnesses plus declarative custom and reject bad flags", () => {
  assert.equal(HARNESS_CHOICES.length, 9);
  assert.equal(HARNESS_MENU_ITEMS.length, 8);

  for (let i = 1; i <= 8; i++) {
    const expected = HARNESS_MENU_ITEMS[i - 1].id;
    assert.equal(resolveMenuSelection(String(i)), expected);
    assert.equal(resolveMenuSelection(expected.toUpperCase()), expected);
  }
  assert.equal(resolveMenuSelection("custom"), "custom");
  assert.equal(resolveMenuSelection("9"), null);
  const opencodeItem = HARNESS_MENU_ITEMS.find((item) => item.id === "opencode");
  const cursorItem = HARNESS_MENU_ITEMS.find((item) => item.id === "cursor");
  assert.match(opencodeItem.description, /Native configuration and adaptive AGENTS\.md/);
  assert.doesNotMatch(opencodeItem.description, /~\/\.opencode\//);
  assert.match(cursorItem.description, /<project>\/\.cursor\/rules\/00-workflow\.mdc/);
  assert.match(cursorItem.description, /project-scoped/);
  assert.doesNotMatch(cursorItem.description, /~\/\.cursor\/rules/);
  assert.equal(resolveMenuSelection("0"), null);
  assert.equal(resolveMenuSelection("auto"), null);
  assert.equal(resolveMenuSelection("all"), null);
  assert.equal(resolveMenuSelection("q"), null);

  const parsed = parseCliArgs([
    "init",
    "--harness",
    "opencode",
    "--root",
    "/tmp/root",
    "--project-root",
    "/tmp/project",
    "--user-home",
    "/tmp/home",
    "--yes",
    "--dry-run",
    "--json",
  ]);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.harness, "opencode");
  assert.equal(parsed.root, "/tmp/root");
  assert.equal(parsed.projectRoot, "/tmp/project");
  assert.equal(parsed.userHome, "/tmp/home");
  assert.equal(parsed.yes, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.json, true);
  assert.throws(() => parseCliArgs(["--unknown-flag"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["init", "--harness"]), /Missing value for --harness/);
  assert.throws(() => parseCliArgs(["init", "doctor"]), /Unexpected command/);
});

test("CLI --version and --help return 0 without touching user home", async () => {
  const ioVer = createIO("");
  const codeVer = await main(["--version"], ioVer);
  assert.equal(codeVer, 0);
  assert.match(ioVer.getStdout().trim(), /^\d+\.\d+\.\d+/);

  const ioHelp = createIO("");
  const codeHelp = await main(["--help"], ioHelp);
  assert.equal(codeHelp, 0);
  assert.match(ioHelp.getStdout(), /nullform init/);
  assert.match(ioHelp.getStdout(), /nullform doctor/);
  assert.match(ioHelp.getStdout(), /nullform update/);

  const emptyDir = createTempDir("empty-ver-");
  try {
    assert.throws(() => readPackageVersion(emptyDir), /Package version metadata missing or corrupt/);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("init interactive menu selects harness, previews plan, confirms and persists state", async () => {
  const tmpHome = createTempDir("cli-menu-");
  const customRoot = join(tmpHome, "custom-opencode");
  try {
    const installCalls = [];
    let doctorArgs = null;
    const io = createIO("3\ny\n", true);

    const code = await main(["init", "--root", customRoot, "--user-home", tmpHome], {
      ...io,
      installHarness(opts) {
        installCalls.push(opts);
        return {
          harness: opts.harness,
          root: opts.root,
          userHome: opts.userHome,
          dryRun: opts.dryRun,
          filesToCopy: [join(opts.root, "VERSION")],
          adapters: [join(opts.userHome, ".config", "opencode", "opencode.json")],
          managedFiles: { [join(opts.userHome, ".config", "opencode", "opencode.json")]: "hash123" },
        };
      },
      runDoctor(opts) {
        doctorArgs = opts;
        return {
          ok: true,
          checks: [{ id: "host-binary", status: "setup", detail: "opencode binary not found in PATH" }],
          summary: { pass: 4, fail: 0, warn: 0, skip: 0, setup: 1 },
        };
      },
    });

    assert.equal(code, 0);
    assert.equal(installCalls.length, 2);
    assert.equal(installCalls[0].dryRun, true);
    assert.equal(installCalls[1].dryRun, false);
    assert.equal(installCalls[1].harness, "opencode");
    assert.equal(doctorArgs.targetHarness, "opencode");
    assert.equal(doctorArgs.harness, customRoot);

    const state = readInstallationState(tmpHome);
    assert.ok(state);
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.harness, "opencode");
    assert.equal(state.root, customRoot);
    assert.equal(state.userHome, tmpHome);
    assert.deepEqual(state.managedFiles, { [join(tmpHome, ".config", "opencode", "opencode.json")]: "hash123" });
    assert.match(io.getStdout(), /Native configuration and adaptive AGENTS\.md/);
    assert.match(io.getStdout(), /<project>\/\.cursor\/rules\/00-workflow\.mdc/);
    assert.match(io.getStdout(), /SETUP \/ host configuration needed/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("init cancellation, non-TTY missing input, bad harness and dry-run never mutate state or target", async () => {
  const tmpHome = createTempDir("cli-nomutate-");
  const targetRoot = join(tmpHome, "target-root");
  try {
    let writeInstallCalled = false;
    const mockInstall = (opts) => {
      if (!opts.dryRun) writeInstallCalled = true;
      return {
        harness: opts.harness,
        root: opts.root,
        userHome: opts.userHome,
        dryRun: opts.dryRun,
        filesToCopy: [join(opts.root, "VERSION")],
        adapters: [join(opts.root, "CLAUDE.md")],
      };
    };

    // 1. Cancelled confirmation ("1\nn\n")
    const ioCancel = createIO("1\nn\n", true);
    const cancelCode = await main(["init", "--root", targetRoot, "--user-home", tmpHome], {
      ...ioCancel,
      installHarness: mockInstall,
    });
    assert.equal(cancelCode, 1);
    assert.equal(writeInstallCalled, false);
    assert.equal(existsSync(getStateFilePath(tmpHome)), false);

    // 2. Non-TTY with no input and no --yes
    const ioEof = createIO("", false);
    const eofCode = await main(["init", "--user-home", tmpHome], {
      ...ioEof,
      installHarness: mockInstall,
    });
    assert.notEqual(eofCode, 0);
    assert.equal(writeInstallCalled, false);
    assert.equal(existsSync(getStateFilePath(tmpHome)), false);
    // 3. Rejects --harness auto (only 8 concrete choices allowed)
    const ioAuto = createIO("", false);
    const autoCode = await main(["init", "--harness", "auto", "--user-home", tmpHome, "--yes"], {
      ...ioAuto,
      installHarness: mockInstall,
    });
    assert.equal(autoCode, 2);
    assert.equal(writeInstallCalled, false);
    assert.equal(existsSync(getStateFilePath(tmpHome)), false);

    // 4. --dry-run previews without writing state or target
    const ioDry = createIO("", false);
    const dryCode = await main(
      ["init", "--harness", "claude", "--root", targetRoot, "--user-home", tmpHome, "--dry-run", "--json"],
      { ...ioDry, installHarness: mockInstall }
    );
    assert.equal(dryCode, 0);
    assert.equal(writeInstallCalled, false);
    assert.equal(existsSync(getStateFilePath(tmpHome)), false);
    const dryJson = JSON.parse(ioDry.getStdout());
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.harness, "claude");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("doctor and update reuse saved installation state and fail closed on corrupt state", async () => {
  const tmpHome = createTempDir("cli-reuse-");
  const customRoot = join(tmpHome, "saved-hermes-root");
  try {
    writeInstallationState(tmpHome, {
      schemaVersion: 1,
      harness: "hermes",
      root: customRoot,
      userHome: tmpHome,
      version: "1.1.0",
    });

    let capturedDoctor = null;
    const ioDoc = createIO("", false);
    const docCode = await main(["doctor", "--user-home", tmpHome, "--json"], {
      ...ioDoc,
      runDoctor(opts) {
        capturedDoctor = opts;
        return {
          ok: true,
          checks: [{ id: "hermes-config", status: "pass", detail: "config.yaml valid" }],
          summary: { pass: 1, fail: 0, warn: 0, skip: 0 },
        };
      },
    });
    assert.equal(docCode, 0);
    assert.equal(capturedDoctor.targetHarness, "hermes");
    assert.equal(capturedDoctor.harness, customRoot);
    assert.equal(capturedDoctor.userHome, tmpHome);

    let capturedUpdate = null;
    const ioUp = createIO("", false);
    const upCode = await main(
      ["update", "--user-home", tmpHome, "--registry", "http://127.0.0.1:4873", "--yes", "--json"],
      {
        ...ioUp,
        async executeUpdate(opts) {
          capturedUpdate = opts;
          return {
            ok: true,
            updated: true,
            from: "1.1.0",
            to: "1.2.0",
            harness: "hermes",
            root: customRoot,
          };
        },
      }
    );
    assert.equal(upCode, 0);
    assert.equal(capturedUpdate.userHome, tmpHome);
    assert.equal(capturedUpdate.registry, "http://127.0.0.1:4873");

    // Corrupt installation.json -> doctor fails closed
    mkdirSync(join(tmpHome, ".nullform"), { recursive: true });
    writeFileSync(getStateFilePath(tmpHome), JSON.stringify({ schemaVersion: 99 }), "utf8");
    const ioCorrupt = createIO("", false);
    const corruptCode = await main(["doctor", "--user-home", tmpHome, "--json"], ioCorrupt);
    assert.equal(corruptCode, 1);
    const corruptJson = JSON.parse(ioCorrupt.getStdout());
    assert.equal(corruptJson.ok, false);
    assert.equal(corruptJson.error, "invalid_state");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("init handles explicit --project-root and Cursor defaults to cwd when fresh", async () => {
  const tmpHome = createTempDir("cli-project-root-");
  const customProject = join(tmpHome, "custom-project");
  const customRoot = join(tmpHome, "custom-root");
  try {
    let installedOpts = null;
    let doctorOpts = null;
    const io = createIO("", false);

    // 1. Explicit --project-root
    const code = await main(
      ["init", "--harness", "cursor", "--root", customRoot, "--project-root", customProject, "--user-home", tmpHome, "--yes", "--json"],
      {
        ...io,
        installHarness(opts) {
          installedOpts = opts;
          return { harness: opts.harness, root: opts.root, projectRoot: opts.projectRoot, userHome: opts.userHome, filesToCopy: [], adapters: [] };
        },
        runDoctor(opts) {
          doctorOpts = opts;
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );
    assert.equal(code, 0);
    assert.equal(resolve(installedOpts.projectRoot), resolve(customProject));
    assert.equal(resolve(doctorOpts.projectRoot), resolve(customProject));
    const state = readInstallationState(tmpHome);
    assert.equal(resolve(state.projectRoot), resolve(customProject));

    // 2. Fresh Cursor with no saved state defaults projectRoot to cwd
    const tmpFreshHome = createTempDir("cli-fresh-cursor-");
    try {
      let freshInstallOpts = null;
      const freshIo = createIO("", false);
      const freshCode = await main(
        ["init", "--harness", "cursor", "--root", customRoot, "--user-home", tmpFreshHome, "--yes", "--json"],
        {
          ...freshIo,
          installHarness(opts) {
            freshInstallOpts = opts;
            return { harness: opts.harness, root: opts.root, projectRoot: opts.projectRoot, userHome: opts.userHome, filesToCopy: [], adapters: [] };
          },
          runDoctor() {
            return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
          },
        }
      );
      assert.equal(freshCode, 0);
      assert.equal(resolve(freshInstallOpts.projectRoot), resolve(process.cwd()));
    } finally {
      rmSync(tmpFreshHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("init preserves prior verified state when structural doctor validation fails", async () => {
  const tmpHome = createTempDir("cli-doctor-fail-");
  const initialRoot = join(tmpHome, "initial-claude");
  const newRoot = join(tmpHome, "new-hermes");
  try {
    writeInstallationState(tmpHome, {
      schemaVersion: 1,
      harness: "claude",
      root: initialRoot,
      userHome: tmpHome,
      version: "1.1.0",
    });

    // Attempt init with hermes, but structural doctor fails (fail status check)
    const ioFail = createIO("", false);
    const failCode = await main(
      ["init", "--harness", "hermes", "--root", newRoot, "--user-home", tmpHome, "--yes", "--json"],
      {
        ...ioFail,
        installHarness(opts) {
          return { harness: opts.harness, root: opts.root, userHome: opts.userHome, filesToCopy: [], adapters: [] };
        },
        runDoctor() {
          return {
            ok: false,
            checks: [{ id: "harness-files", status: "fail", detail: "Missing required files" }],
            summary: { pass: 1, fail: 1, warn: 0, skip: 0 },
          };
        },
      }
    );
    assert.equal(failCode, 1);
    const preservedState = readInstallationState(tmpHome);
    assert.equal(preservedState.harness, "claude", "Prior verified state harness must be preserved");
    assert.equal(preservedState.root, initialRoot, "Prior verified state root must be preserved");

    // Now doctor passes with explicit SETUP check -> state successfully updates
    const ioSetup = createIO("", false);
    const setupCode = await main(
      ["init", "--harness", "hermes", "--root", newRoot, "--user-home", tmpHome, "--yes", "--json"],
      {
        ...ioSetup,
        installHarness(opts) {
          return { harness: opts.harness, root: opts.root, userHome: opts.userHome, filesToCopy: [], adapters: [] };
        },
        runDoctor() {
          return {
            ok: true,
            checks: [{ id: "host-binary", status: "setup", detail: "hermes binary not in PATH" }],
            summary: { pass: 1, fail: 0, warn: 0, skip: 0, setup: 1 },
          };
        },
      }
    );
    assert.equal(setupCode, 0);
    const updatedState = readInstallationState(tmpHome);
    assert.equal(updatedState.harness, "hermes", "State must update when doctor checks pass (including setup)");
    assert.equal(updatedState.root, newRoot);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("doctor CLI rejects invalid --harness (auto, all, typo) with exit code 2 and invalid_harness error", async () => {
  const tmpHome = createTempDir("nullform-doctor-bad-harness-");
  try {
    writeInstallationState(tmpHome, {
      schemaVersion: 1,
      harness: "omp",
      root: join(tmpHome, "omp-root"),
      userHome: tmpHome,
      version: "1.0.0",
    });

    for (const badHarness of ["auto", "all", "typo"]) {
      const ioJson = createIO("", false);
      const codeJson = await main(
        ["doctor", "--harness", badHarness, "--root", join(tmpHome, "custom-root"), "--user-home", tmpHome, "--json"],
        ioJson
      );
      assert.equal(codeJson, 2, `Invalid harness "${badHarness}" must exit with code 2 in JSON mode`);
      const parsed = JSON.parse(ioJson.getStdout());
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error, "invalid_harness");

      const ioText = createIO("", false);
      const codeText = await main(
        ["doctor", "--harness", badHarness, "--user-home", tmpHome],
        ioText
      );
      assert.equal(codeText, 2, `Invalid harness "${badHarness}" must exit with code 2 in text mode`);
      assert.ok(ioText.getStderr().includes("invalid_harness") || ioText.getStderr().includes(`Invalid --harness "${badHarness}"`));
    }
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("init does not persist old projectRoot or borrow managedFiles when switching harness", async () => {
  const tmpHome = createTempDir("nullform-init-switch-");
  const cursorProject = join(tmpHome, "cursor-project");
  mkdirSync(cursorProject, { recursive: true });

  try {
    writeInstallationState(tmpHome, {
      schemaVersion: 1,
      harness: "cursor",
      root: join(tmpHome, "cursor-root"),
      projectRoot: cursorProject,
      userHome: tmpHome,
      version: "1.0.0",
      managedFiles: {
        [join(cursorProject, ".cursor", "rules", "00-workflow.mdc")]: "hash-cursor-123",
      },
    });

    let capturedPlanOptions = null;
    const ioSwitch = createIO("", false);
    const codeSwitch = await main(
      ["init", "--harness", "opencode", "--user-home", tmpHome, "--yes", "--json"],
      {
        ...ioSwitch,
        installHarness(opts) {
          capturedPlanOptions = opts;
          return {
            harness: opts.harness,
            root: opts.root,
            ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
            userHome: opts.userHome,
            filesToCopy: [],
            adapters: [],
            managedFiles: { [join(opts.root, "AGENTS.md")]: "hash-opencode-456" },
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );
    assert.equal(codeSwitch, 0);
    assert.equal(capturedPlanOptions.projectRoot, undefined, "installHarness must not receive old host projectRoot");
    assert.equal(capturedPlanOptions.managedFiles, undefined, "installHarness must not borrow old host managedFiles");

    const newState = readInstallationState(tmpHome);
    assert.equal(newState.harness, "opencode");
    assert.equal(newState.projectRoot, undefined, "New installation state must not persist old cursor projectRoot");
    assert.deepEqual(newState.managedFiles, { [join(capturedPlanOptions.root, "AGENTS.md")]: "hash-opencode-456" });

    const opencodeProject = join(tmpHome, "opencode-explicit-project");
    mkdirSync(opencodeProject, { recursive: true });
    let capturedExplicitOptions = null;
    const ioExplicit = createIO("", false);
    const codeExplicit = await main(
      ["init", "--harness", "opencode", "--project-root", opencodeProject, "--user-home", tmpHome, "--yes", "--json"],
      {
        ...ioExplicit,
        installHarness(opts) {
          capturedExplicitOptions = opts;
          return {
            harness: opts.harness,
            root: opts.root,
            projectRoot: opts.projectRoot,
            userHome: opts.userHome,
            filesToCopy: [],
            adapters: [],
            managedFiles: { [join(opts.root, "AGENTS.md")]: "hash-opencode-789" },
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );
    assert.equal(codeExplicit, 0);
    assert.equal(capturedExplicitOptions.projectRoot, resolve(opencodeProject));
    const explicitState = readInstallationState(tmpHome);
    assert.equal(explicitState.projectRoot, resolve(opencodeProject));

    let capturedSameHostOptions = null;
    const ioSame = createIO("", false);
    const codeSame = await main(
      ["init", "--harness", "opencode", "--user-home", tmpHome, "--yes", "--json"],
      {
        ...ioSame,
        installHarness(opts) {
          capturedSameHostOptions = opts;
          return {
            harness: opts.harness,
            root: opts.root,
            projectRoot: opts.projectRoot,
            userHome: opts.userHome,
            filesToCopy: [],
            adapters: [],
            managedFiles: opts.managedFiles,
          };
        },
        runDoctor() {
          return { ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } };
        },
      }
    );
    assert.equal(codeSame, 0);
    assert.equal(capturedSameHostOptions.projectRoot, resolve(opencodeProject), "Same harness must preserve saved projectRoot");
    assert.deepEqual(capturedSameHostOptions.managedFiles, { [join(capturedExplicitOptions.root, "AGENTS.md")]: "hash-opencode-789" }, "Same harness must preserve managedFiles");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("user CLI errors redact synthetic canary tokens", async () => {
  const canaryToken = "SYNTHETIC_CANARY_SECRET_FAIL_12345";
  const io = createIO("", false);
  const code = await main(
    ["init", "--harness", "omp", "--root", `/nonexistent/${canaryToken}`, "--user-home", `/home/${canaryToken}/_authToken=${canaryToken}`, "--yes"],
    {
      ...io,
      installHarness() {
        throw new Error(`Authentication failure with token: ${canaryToken}`);
      },
    }
  );
  assert.equal(code, 1);
  assert.ok(!io.getStderr().includes(canaryToken), "Synthetic canary must not appear in CLI error output");
  ;
});

test("nullform update CLI redacts credential URL in JSON and text error outputs", async () => {
  const tmp = createTempDir("cli-update-auth-");
  const tmpRoot = join(tmp, "app-root");
  const tmpHome = join(tmp, "synthetic-home");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(tmpHome, { recursive: true });
  writeFileSync(join(tmpRoot, "VERSION"), "1.1.0\n", "utf8");

  writeInstallationState(tmpHome, {
    schemaVersion: 1,
    harness: "claude",
    root: tmpRoot,
    userHome: tmpHome,
    version: "1.1.0",
  });

  const canaryPass = "CANARY_SYNTHETIC_NOT_A_SECRET";
  const badRegistry = `https://audituser:${canaryPass}@registry.invalid/a b`;

  try {
    // 1. JSON mode
    const ioJson = createIO("", false);
    const codeJson = await main(
      ["update", "--registry", badRegistry, "--user-home", tmpHome, "--json"],
      ioJson
    );
    assert.equal(codeJson, 1);
    const stdoutJson = ioJson.getStdout();
    const stderrJson = ioJson.getStderr();
    assert.ok(!stdoutJson.includes(canaryPass), "JSON stdout must not leak password");
    assert.ok(!stderrJson.includes(canaryPass), "JSON stderr must not leak password");
    ;
    const parsed = JSON.parse(stdoutJson.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "invalid_arguments");
    ;

    // 2. Text mode
    const ioText = createIO("", false);
    const codeText = await main(
      ["update", "--registry", badRegistry, "--user-home", tmpHome],
      ioText
    );
    assert.equal(codeText, 1);
    const stdoutText = ioText.getStdout();
    const stderrText = ioText.getStderr();
    assert.ok(!stdoutText.includes(canaryPass), "Text stdout must not leak password");
    assert.ok(!stderrText.includes(canaryPass), "Text stderr must not leak password");
    ;
    ;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("init headless --yes --json prints exactly one JSON document (certify parses stdout)", async () => {
  const tmpHome = createTempDir("cli-single-json-");
  const customRoot = join(tmpHome, "custom-root");
  try {
    const io = createIO("", false);
    const code = await main(
      ["init", "--harness", "codex", "--root", customRoot, "--user-home", tmpHome, "--yes", "--json"],
      {
        ...io,
        installHarness: (opts) => ({ harness: opts.harness, root: opts.root, userHome: opts.userHome, filesToCopy: [], adapters: [] }),
        runDoctor: () => ({ ok: true, checks: [], summary: { pass: 1, fail: 0, warn: 0, skip: 0 } }),
      }
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(io.getStdout());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.stage, "complete");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
