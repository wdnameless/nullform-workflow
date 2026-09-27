import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

function getPowerShellPath() {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell.exe",
        "pwsh.exe",
        "pwsh",
      ]
    : [
        "pwsh",
        "/usr/bin/pwsh",
        "/usr/local/bin/pwsh",
        "/opt/microsoft/powershell/7/pwsh",
      ];
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ["-NoProfile", "-Command", "Write-Output ps-ok"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      if (res.status === 0 && (res.stdout || "").includes("ps-ok")) {
        return c;
      }
    } catch {}
  }
  return null;
}

const POWERSHELL_PATH = getPowerShellPath();

function pathWithoutOmp() {
  const nodeDir = dirname(process.execPath);
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const psDir = POWERSHELL_PATH && (POWERSHELL_PATH.includes("\\") || POWERSHELL_PATH.includes("/"))
    ? dirname(POWERSHELL_PATH)
    : "";
  const sysDirs = process.platform === "win32"
    ? [
        join(sysRoot, "System32"),
        join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
        sysRoot,
        psDir,
      ].filter(Boolean)
    : [
        "/bin",
        "/usr/bin",
        psDir,
      ].filter(Boolean);
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

test("setup-paseo.ps1: standalone setup without -Model fails actionably when new profile needed", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-test-fresh-"));
  try {
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
    ], { encoding: "utf8" });

    assert.notEqual(res.status, 0, "Standalone setup without -Model must fail for fresh profile");
    const combinedOutput = (res.stdout || "") + (res.stderr || "");
    assert.match(combinedOutput, /Cannot add new profile\s+'agent_profile_orchestrator'\s+without a\s+model/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("setup-paseo.ps1: standalone setup with -Model creates profile and expands <HarnessRoot> in notes", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
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

test("setup-paseo.ps1: preserves existing model when called without -Model and expands <HarnessRoot>", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
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

test("setup-paseo.ps1: synthetic config remains valid and untouched after injected failure (R07 atomic replacement)", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-atomic-fail-"));
  try {
    const paseoDir = join(tmpHome, ".paseo");
    mkdirSync(paseoDir, { recursive: true });

    const initialConfig = {
      theme: "custom-dark",
      telemetry: false,
      unrelatedSection: { foo: "bar", list: [1, 2, 3] },
      daemon: {
        port: 8080,
        agentProfiles: [
          {
            id: "agent_profile_orchestrator",
            name: "Orchestrator",
            provider: "omp",
            model: "original-provider/original-model",
            notes: "Original notes <HarnessRoot>",
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
    const cfgPath = join(paseoDir, "config.json");
    const originalJson = JSON.stringify(initialConfig, null, 2);
    writeFileSync(cfgPath, originalJson, "utf8");

    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
      "-Model", "new-provider/new-model",
    ], {
      encoding: "utf8",
      env: { ...process.env, PASEO_SETUP_FAILPOINT: "before-replace" },
    });

    assert.notEqual(res.status, 0, "Execution must fail when failpoint is triggered");

    // Config file must still exist and be completely intact and valid
    assert.ok(existsSync(cfgPath), "Config file must still exist");
    const currentRaw = readFileSync(cfgPath, "utf8");
    assert.equal(currentRaw, originalJson, "Original config content must be unchanged byte-for-byte");
    const parsed = JSON.parse(currentRaw);
    assert.equal(parsed.theme, "custom-dark");
    assert.equal(parsed.unrelatedSection.foo, "bar");
    assert.equal(parsed.daemon.port, 8080);
    assert.equal(parsed.daemon.agentProfiles[0].model, "original-provider/original-model");

    // No leftover temporary files in .paseo directory
    const leftovers = readdirSync(paseoDir).filter((f) => f.includes("tmp"));
    assert.equal(leftovers.length, 0, `No temporary files must remain, found: ${leftovers.join(", ")}`);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("setup-paseo.ps1: atomic replacement preserves unrelated fields and writes without BOM", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "paseo-atomic-success-"));
  try {
    const paseoDir = join(tmpHome, ".paseo");
    mkdirSync(paseoDir, { recursive: true });

    const initialConfig = {
      theme: "custom-theme",
      customKey: "preserved",
      daemon: {
        port: 1234,
        agentProfiles: [
          {
            id: "unrelated_existing",
            name: "Unrelated",
            provider: "test",
            model: "test/model",
          },
        ],
      },
    };
    const cfgPath = join(paseoDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", SETUP_PASEO_PATH,
      "-UserProfileDir", tmpHome,
      "-Model", "test-provider/test-model",
      "-HarnessRoot", "C:/harness",
    ], { encoding: "utf8" });

    assert.equal(res.status, 0, `Expected success, got: ${res.stderr}\n${res.stdout}`);

    // Verify BOM: file must NOT start with UTF-8 BOM (0xEF, 0xBB, 0xBF)
    const rawBuffer = readFileSync(cfgPath);
    assert.ok(
       !(rawBuffer[0] === 0xef && rawBuffer[1] === 0xbb && rawBuffer[2] === 0xbf),
      "File must not have UTF-8 BOM"
    );

    // Verify unrelated fields preserved
    const cfg = JSON.parse(rawBuffer.toString("utf8"));
    assert.equal(cfg.theme, "custom-theme");
    assert.equal(cfg.customKey, "preserved");
    assert.equal(cfg.daemon.port, 1234);
    assert.ok(cfg.daemon.agentProfiles.some((p) => p.id === "unrelated_existing"));
    assert.ok(cfg.daemon.agentProfiles.some((p) => p.id === "agent_profile_orchestrator"));

    // No leftover temporary files
    const leftovers = readdirSync(paseoDir).filter((f) => f.includes("tmp"));
    assert.equal(leftovers.length, 0, "No temporary files must remain");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: -SetupPaseo without provider model warns and skips Paseo without aborting install", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
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

test("install.ps1: fails if omp is missing and -SkipPlugins not passed", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
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

test("install.ps1: succeeds without omp if -SkipPlugins is passed", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
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

    const markerPath = join(tmpHarness, "agent", "plugins.skipped");
    assert.ok(existsSync(markerPath), "plugins.skipped marker must exist after install with -SkipPlugins");

    const docRes = spawnSync(process.execPath, [
      join(tmpHarness, "tools", "doctor.mjs"),
      "--harness", tmpHarness,
      "--json",
    ], { encoding: "utf8" });
    const docJson = JSON.parse(docRes.stdout);
    const pCheck = docJson.checks.find((c) => c.id === "plugins");
    assert.ok(pCheck, "plugins check must exist in doctor report");
    assert.equal(pCheck.status, "skip");
    assert.match(pCheck.detail, /плагины пропущены при установке \(-SkipPlugins\)/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: substitutes supplied GITHUB_PERSONAL_ACCESS_TOKEN and POSTGRES_URL into mcp.json (R04)", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "install-mcp-secrets-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  const secretsPath = join(tmpHome, "test-secrets.env");
  const canaryToken = "ghp_synthetic_canary_secret_token_12345";
  const canaryPgUrl = "postgresql://synthuser:synthpass@127.0.0.1:5432/synthdb";
  writeFileSync(secretsPath, `GITHUB_PERSONAL_ACCESS_TOKEN=${canaryToken}\nPOSTGRES_URL=${canaryPgUrl}\n`, "utf8");

  try {
    const env = { ...process.env, PATH: pathWithoutOmp() };
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-SecretsFile", secretsPath,
      "-SkipPlugins",
      "-NonInteractive",
    ], { encoding: "utf8", env });

    assert.equal(res.status, 0, `Installer must succeed: ${res.stderr}\n${res.stdout}`);
    const output = (res.stdout || "") + (res.stderr || "");
    assert.ok(!output.includes(canaryToken), "Installer must never print secret token");
    assert.ok(!output.includes(canaryPgUrl), "Installer must never print database URL with credentials");

    const mcpPath = join(tmpHome, ".omp", "agent", "mcp.json");
    assert.ok(existsSync(mcpPath), "mcp.json must be written");
    const rawMcp = readFileSync(mcpPath, "utf8");
    assert.ok(!rawMcp.includes("__GITHUB_PAT__"), "mcp.json must not retain __GITHUB_PAT__");
    assert.ok(!rawMcp.includes("__POSTGRES_URL__"), "mcp.json must not retain __POSTGRES_URL__");

    const mcpJson = JSON.parse(rawMcp);
    assert.ok(mcpJson.mcpServers.github, "github server must be present");
    assert.equal(mcpJson.mcpServers.github.env?.GITHUB_PERSONAL_ACCESS_TOKEN, canaryToken);

    assert.ok(mcpJson.mcpServers.postgres, "postgres server must be present");
    assert.ok(
      Array.isArray(mcpJson.mcpServers.postgres.args) && mcpJson.mcpServers.postgres.args.includes(canaryPgUrl),
      `postgres server args must include supplied URL: ${JSON.stringify(mcpJson.mcpServers.postgres.args)}`
    );
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: drops github and postgres servers when credentials are not supplied (R04)", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "install-mcp-no-secrets-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  const secretsPath = join(tmpHome, "empty-secrets.env");
  writeFileSync(secretsPath, "# empty secrets file\n", "utf8");

  try {
    const env = { ...process.env, PATH: pathWithoutOmp() };
    const res = spawnSync(POWERSHELL_PATH, [
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALL_PATH,
      "-UserHome", tmpHome,
      "-HarnessRoot", tmpHarness,
      "-SecretsFile", secretsPath,
      "-SkipPlugins",
      "-NonInteractive",
    ], { encoding: "utf8", env });

    assert.equal(res.status, 0, `Installer must succeed: ${res.stderr}\n${res.stdout}`);
    const mcpPath = join(tmpHome, ".omp", "agent", "mcp.json");
    assert.ok(existsSync(mcpPath), "mcp.json must be written");
    const rawMcp = readFileSync(mcpPath, "utf8");
    const mcpJson = JSON.parse(rawMcp);

    assert.equal(mcpJson.mcpServers?.github, undefined, "github server must be dropped when token is absent");
    assert.equal(mcpJson.mcpServers?.postgres, undefined, "postgres server must be dropped when URL is absent");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("install.ps1: preserves pre-existing unrelated mcp.json untouched (R04)", (t) => {
  if (!POWERSHELL_PATH) {
    t.skip("PowerShell is not available on this host");
    return;
  }
  const tmpHome = mkdtempSync(join(tmpdir(), "install-mcp-preserve-"));
  const tmpHarness = join(tmpHome, "omp-workflow");
  const agentDir = join(tmpHome, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  const mcpPath = join(agentDir, "mcp.json");
  const customMcp = JSON.stringify({
    mcpServers: {
      "custom-service": {
        command: "custom-tool",
        args: ["--port", "9999"],
      },
    },
  }, null, 2);
  writeFileSync(mcpPath, customMcp, "utf8");

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

    assert.equal(res.status, 0, `Installer must succeed: ${res.stderr}\n${res.stdout}`);
    const output = (res.stdout || "") + (res.stderr || "");
    assert.match(output, /mcp\.json exists -> left untouched/);

    const actualMcp = readFileSync(mcpPath, "utf8");
    assert.equal(actualMcp, customMcp, "Pre-existing mcp.json must remain identical and untouched");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
