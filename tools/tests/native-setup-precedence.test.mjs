import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTempDir } from "./test-helpers.mjs";
import { runInit } from "../../bin/nullform.mjs";
import { discoverCandidates, detectHarness, installHarness } from "../install-harness.mjs";
import { inspectHarness } from "../harness-profiles.mjs";
import { writeInstallationState } from "../installation-state.mjs";

const CLI_PATH = fileURLToPath(new URL("../../bin/nullform.mjs", import.meta.url));

function controlledEnv(home, binDir = null) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HERMES_|NULLFORM_|NPM_CONFIG_|npm_config_|OMP_|CLAUDE_|CODEX_|OPENCODE_|OPENCLAW_|OPENHUMAN_)/i.test(key)) {
      delete env[key];
    }
  }
  const cleanBin = binDir || join(home, "clean-bin");
  mkdirSync(cleanBin, { recursive: true });
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    NULLFORM_USER_HOME: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    HERMES_HOME: join(home, ".hermes"),
    PATH: cleanBin,
    Path: cleanBin,
    NF_NO_DASHBOARD: "1",
    NF_NO_OPEN: "1",
  });
}

function captureStreams() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    stdout: { write: (msg) => { stdoutChunks.push(msg); } },
    stderr: { write: (msg) => { stderrChunks.push(msg); } },
    readStdout: () => stdoutChunks.join(""),
    readStderr: () => stderrChunks.join(""),
  };
}

test("detectHarness and discoverCandidates with controlled env (none, unique, ambiguous)", () => {
  const temp = createTempDir("cand-detect-");
  const env = controlledEnv(temp);
  try {
    // 0 candidates
    assert.deepEqual(discoverCandidates({ userHome: temp, env }), []);
    assert.equal(detectHarness({ userHome: temp, env }), null);

    // 1 candidate: codex
    mkdirSync(join(temp, ".codex"), { recursive: true });
    assert.deepEqual(discoverCandidates({ userHome: temp, env }), ["codex"]);
    assert.equal(detectHarness({ userHome: temp, env }), "codex");

    // 2 candidates: codex + claude
    mkdirSync(join(temp, ".claude"), { recursive: true });
    const multi = discoverCandidates({ userHome: temp, env });
    assert.equal(multi.length, 2);
    assert.ok(multi.includes("codex"));
    assert.ok(multi.includes("claude"));
    assert.equal(detectHarness({ userHome: temp, env }), null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("installHarness throws on ambiguous or missing harness when harness='auto'", () => {
  const temp = createTempDir("install-auto-refusal-");
  const env = controlledEnv(temp);
  try {
    assert.throws(
      () => installHarness({ harness: "auto", userHome: temp, root: join(temp, "w"), env }),
      /No supported harness detected/
    );

    mkdirSync(join(temp, ".claude"), { recursive: true });
    mkdirSync(join(temp, ".codex"), { recursive: true });
    assert.throws(
      () => installHarness({ harness: "auto", userHome: temp, root: join(temp, "w"), env }),
      /Multiple candidate harnesses detected/
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runInit precedence: explicit --harness wins over saved state and discovered candidate", async () => {
  const temp = createTempDir("precedence-explicit-");
  const env = controlledEnv(temp);
  const streams = captureStreams();
  try {
    // Saved state for hermes
    writeInstallationState(temp, { schemaVersion: 1, harness: "hermes", root: join(temp, "saved-root"), userHome: temp, version: "1.0.0" });
    // Candidate for codex
    mkdirSync(join(temp, ".codex"), { recursive: true });

    // Explicit --harness claude
    const code = await runInit(
      { harness: "claude", dryRun: true, json: true, yes: true, userHome: temp, root: join(temp, "w") },
      { env, stdout: streams.stdout, stderr: streams.stderr, isTTY: false }
    );
    assert.equal(code, 0);
    const payload = JSON.parse(streams.readStdout());
    assert.equal(payload.ok, true);
    assert.equal(payload.harness, "claude");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runInit precedence: saved state reused without prompt on init", async () => {
  const temp = createTempDir("precedence-saved-");
  const env = controlledEnv(temp);
  const streams = captureStreams();
  try {
    writeInstallationState(temp, { schemaVersion: 1, harness: "hermes", root: join(temp, "saved-root"), userHome: temp, version: "1.0.0" });
    mkdirSync(join(temp, ".codex"), { recursive: true });

    const code = await runInit(
      { dryRun: true, json: true, yes: true, userHome: temp },
      { env, stdout: streams.stdout, stderr: streams.stderr, isTTY: false }
    );
    assert.equal(code, 0);
    const payload = JSON.parse(streams.readStdout());
    assert.equal(payload.ok, true);
    assert.equal(payload.harness, "hermes");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runInit precedence: single candidate selected without prompt when no saved state", async () => {
  const temp = createTempDir("precedence-candidate-");
  const env = controlledEnv(temp);
  const streams = captureStreams();
  try {
    mkdirSync(join(temp, ".codex"), { recursive: true });

    const code = await runInit(
      { dryRun: true, json: true, yes: true, userHome: temp, root: join(temp, "w") },
      { env, stdout: streams.stdout, stderr: streams.stderr, isTTY: false }
    );
    assert.equal(code, 0);
    const payload = JSON.parse(streams.readStdout());
    assert.equal(payload.ok, true);
    assert.equal(payload.harness, "codex");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runInit precedence: headless refusal on ambiguity or no candidates with zero writes", async () => {
  const temp = createTempDir("precedence-headless-refusal-");
  const env = controlledEnv(temp);
  try {
    // Case 1: 0 candidates
    const s1 = captureStreams();
    const code1 = await runInit(
      { yes: true, json: true, userHome: temp, root: join(temp, "w1") },
      { env, stdout: s1.stdout, stderr: s1.stderr, isTTY: false }
    );
    assert.equal(code1, 2);
    const p1 = JSON.parse(s1.readStdout());
    assert.equal(p1.ok, false);
    assert.equal(p1.error, "missing_harness");
    assert.equal(existsSync(join(temp, "w1")), false);

    // Case 2: Ambiguous candidates (both .claude and .codex exist)
    mkdirSync(join(temp, ".claude"), { recursive: true });
    mkdirSync(join(temp, ".codex"), { recursive: true });

    const s2 = captureStreams();
    const code2 = await runInit(
      { yes: true, json: true, userHome: temp, root: join(temp, "w2") },
      { env, stdout: s2.stdout, stderr: s2.stderr, isTTY: false }
    );
    assert.equal(code2, 2);
    const p2 = JSON.parse(s2.readStdout());
    assert.equal(p2.ok, false);
    assert.equal(p2.error, "ambiguous_harness");
    assert.equal(existsSync(join(temp, "w2")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("public CLI init refusal on headless ambiguity does zero writes", () => {
  const temp = createTempDir("cli-ambig-");
  const home = join(temp, "home");
  const root = join(temp, "workflow");
  const env = controlledEnv(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  try {
    const res = spawnSync(process.execPath, [
      CLI_PATH, "init", "--root", root, "--user-home", home, "--yes", "--json",
    ], { encoding: "utf8", env });
    assert.equal(res.status, 2);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "ambiguous_harness");
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(home, ".nullform")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex adapter preserves existing AGENTS.override.md and discloses shadowing in plan warnings", () => {
  const temp = createTempDir("codex-override-md-");
  const home = join(temp, "home");
  const root = join(temp, "workflow");
  const env = controlledEnv(home);
  mkdirSync(home, { recursive: true });
  const overrideContent = "# Human AGENTS.override.md\nKeep this exactly.\n";
  writeFileSync(join(home, "AGENTS.override.md"), overrideContent, "utf8");
  try {
    const plan = installHarness({
      harness: "codex",
      root,
      userHome: home,
      hostHome: home,
      dryRun: false,
      env,
    });
    assert.equal(readFileSync(join(home, "AGENTS.override.md"), "utf8"), overrideContent);
    assert.ok(plan.warnings.some((w) => w.includes("AGENTS.override.md")));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("OpenHuman inspector reports manual/not-verified runtime status", () => {
  const temp = createTempDir("openhuman-inspect-");
  const home = join(temp, "home");
  const env = controlledEnv(home);
  try {
    const report = inspectHarness({ harness: "openhuman", userHome: home, env });
    assert.equal(report.runtimeReady.status, "not-verified");
    assert.equal(report.capabilities.taskState.status, "unknown");
    assert.equal(report.modules.taskState.decision, "manual");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fresh minimal OMP init preserves human .harness-root and legacy extras with active warning", () => {
  const temp = createTempDir("omp-preservation-");
  const home = join(temp, "home");
  const agentDir = join(home, ".omp", "agent");
  const root = join(temp, "workflow");
  const env = controlledEnv(home);
  mkdirSync(agentDir, { recursive: true });

  const humanPointer = "/human/custom/pointer\n";
  writeFileSync(join(agentDir, ".harness-root"), humanPointer, "utf8");
  writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n', "utf8");

  try {
    const plan = installHarness({
      harness: "omp",
      root,
      userHome: home,
      hostHome: agentDir,
      dryRun: false,
      env,
    });

    assert.equal(readFileSync(join(agentDir, ".harness-root"), "utf8"), humanPointer);
    assert.equal(existsSync(join(agentDir, "mcp.json")), true);
    assert.ok(plan.warnings.length > 0);
    assert.equal(existsSync(join(home, ".agents", "skills")), false);
    assert.equal(existsSync(join(root, "skills")), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
