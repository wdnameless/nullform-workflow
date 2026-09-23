import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SETUP_PASEO_PATH = resolve(REPO_ROOT, "paseo/setup-paseo.ps1");
const PLUGINS_MANIFEST_PATH = resolve(REPO_ROOT, "agent/plugins.json");
const PROFILES_MANIFEST_PATH = resolve(REPO_ROOT, "paseo/profiles.json");
const INSTALL_PATH = resolve(REPO_ROOT, "install.ps1");

const POWERSHELL_PATH = process.platform === "win32"
  ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "pwsh";

function pathWithoutOmp() {
  const nodeDir = dirname(process.execPath);
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sysDirs = [
    join(sysRoot, "System32"),
    join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
    sysRoot,
  ];
  return [nodeDir, ...sysDirs].join(process.platform === "win32" ? ";" : ":");
}

test("agent/plugins.json: versions are pinned exact and required plugins marked", () => {
  const content = JSON.parse(readFileSync(PLUGINS_MANIFEST_PATH, "utf8"));
  assert.ok(Array.isArray(content.plugins));

  const morph = content.plugins.find((p) => p.name === "oh-my-pi-plugin-morph");
  const lens = content.plugins.find((p) => p.name === "pi-lens");

  assert.ok(morph, "oh-my-pi-plugin-morph must be present");
  assert.equal(morph.required, true, "oh-my-pi-plugin-morph must be classified as required");
  assert.ok(!morph.spec.includes("^"), `spec must not have ^: ${morph.spec}`);

  assert.ok(lens, "pi-lens must be present");
  assert.equal(lens.required, true, "pi-lens must be classified as required");
  assert.ok(!lens.spec.includes("^"), `spec must not have ^: ${lens.spec}`);

  for (const p of content.plugins) {
    assert.ok(!p.spec.includes("^"), `Plugin ${p.name} spec must have exact version: ${p.spec}`);
  }
});

test("paseo/profiles.json: profile contains notes with <HarnessRoot> template", () => {
  const profiles = JSON.parse(readFileSync(PROFILES_MANIFEST_PATH, "utf8"));
  assert.ok(Array.isArray(profiles));
  const orchestrator = profiles.find((p) => p.id === "agent_profile_orchestrator");
  assert.ok(orchestrator);
  assert.match(orchestrator.notes, /<HarnessRoot>/);
});

test("setup-paseo.ps1: standalone setup without -Model fails actionably when new profile needed", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-test-fresh-"));
  try {
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
    ], { encoding: "utf8" });

    assert.notEqual(res.status, 0, "Standalone setup without -Model must fail for fresh profile");
    const combinedOutput = (res.stdout || "") + (res.stderr || "");
    assert.match(combinedOutput, /Cannot add new profile 'agent_profile_orchestrator' without a model/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("setup-paseo.ps1: standalone setup with -Model creates profile and expands <HarnessRoot> in notes", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-test-with-model-"));
  const fakeHarness = "C:/test/my-harness-root";
  try {
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
      "-Model", "provider/test-model",
      "-HarnessRoot", fakeHarness,
    ], { encoding: "utf8" });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);

    const cfgPath = join(tmpHome, ".paseo", "config.json");
    assert.ok(existsSync(cfgPath));
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const prof = cfg.daemon.agentProfiles.find((p) => p.id === "agent_profile_orchestrator");
    assert.ok(prof, "Profile must be created");
    assert.equal(prof.model, "provider/test-model");
    assert.ok(!prof.notes.includes("<HarnessRoot>"), "Notes must not contain unexpanded <HarnessRoot>");
    assert.ok(prof.notes.includes(fakeHarness), `Notes must contain expanded harness root: ${prof.notes}`);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("setup-paseo.ps1: preserves existing model when called without -Model and expands <HarnessRoot>", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-test-existing-"));
  const fakeHarness = "D:/test/expanded-harness";
  try {
    const paseoDir = join(tmpHome, ".paseo");
    mkdirSync(paseoDir, { recursive: true });

    const initialConfig = {
      daemon: {
        agentProfiles: [
          {
            id: "agent_profile_orchestrator",
            name: "Orchestrator",
            provider: "omp",
            model: "existing-provider/existing-model-123",
            notes: "Previous notes referencing <HarnessRoot>/agent/agents/orchestrator.md",
          },
          {
            id: "unrelated_profile",
            name: "Other",
            provider: "custom",
            model: "other/model",
          },
        ],
      },
    };
    writeFileSync(join(paseoDir, "config.json"), JSON.stringify(initialConfig, null, 2), "utf8");

    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
      "-HarnessRoot", fakeHarness,
    ], { encoding: "utf8" });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);

    const cfg = JSON.parse(readFileSync(join(paseoDir, "config.json"), "utf8"));
    const prof = cfg.daemon.agentProfiles.find((p) => p.id === "agent_profile_orchestrator");
    assert.ok(prof);
    assert.equal(prof.model, "existing-provider/existing-model-123", "Existing model must be preserved");
    assert.ok(!prof.notes.includes("<HarnessRoot>"));
    assert.ok(prof.notes.includes(fakeHarness));

    const unrelated = cfg.daemon.agentProfiles.find((p) => p.id === "unrelated_profile");
    assert.ok(unrelated, "Unrelated profile must be untouched");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: -SetupPaseo without provider model warns and skips Paseo without aborting install", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "install-paseo-fresh-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  try {
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-SetupPaseo",
      "-SkipPlugins",
      "-NonInteractive",
    ], { encoding: "utf8" });

    assert.equal(res.status, 0, `Install must succeed without aborting: ${res.stderr}\n${res.stdout}`);
    const output = (res.stdout || "") + (res.stderr || "");
    assert.match(output, /Paseo setup skipped: no provider model configured/);
    assert.ok(existsSync(join(tmpHarness, "agent", "AGENTS.md")), "Base install files must be created");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: fails if omp is missing and -SkipPlugins not passed", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "install-no-omp-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  try {
    const env = { ...process.env, PATH: pathWithoutOmp() };
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-NonInteractive",
    ], { encoding: "utf8", env });

    assert.notEqual(res.status, 0, "Installer must fail when omp is missing without -SkipPlugins");
    const output = (res.stdout || "") + (res.stderr || "");
    assert.match(output, /omp not found in PATH/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: succeeds without omp if -SkipPlugins is passed", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "install-skip-plugins-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  try {
    const env = { ...process.env, PATH: pathWithoutOmp() };
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-SkipPlugins",
      "-NonInteractive",
    ], { encoding: "utf8", env });

    assert.equal(res.status, 0, `Installer must succeed with -SkipPlugins: ${res.stderr}\n${res.stdout}`);
    const output = (res.stdout || "") + (res.stderr || "");
    assert.match(output, /plugins: skipped \(-SkipPlugins\)/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
