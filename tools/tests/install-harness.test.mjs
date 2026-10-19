import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, dirname, basename } from "node:path";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "tools/install-harness.mjs");
const SH_PATH = resolve(REPO_ROOT, "install.sh");
import { createTempDir } from "./test-helpers.mjs";
import { detectHarness } from "../install-harness.mjs";
import { preflightJson5Config, preflightJsoncConfig, applyManagedSection, loadYaml } from "../installation/config.mjs";
import { resolveHostHome } from "../installation/profiles.mjs";
function getBashPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash.exe", "bash"]
    : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "bash"];
  for (const c of candidates) {
    try {
      const res = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (res.status === 0 && (res.stdout || "").includes("bash")) {
        if (c === "bash" || c === "bash.exe") {
          const whichRes = spawnSync(process.platform === "win32" ? "where" : "which", [c], { encoding: "utf8" });
          if (whichRes.status === 0 && whichRes.stdout.trim()) return whichRes.stdout.trim().split(/\r?\n/)[0];
        }
        return c;
      }
    } catch {}
  }
  return null;
}

/**
 * Isolated child env for root-only installer children: gives each test its own home so
 * parallel tests never share the real `~/.nullform` deployment journal or lock. Root-only
 * mode is preserved by NOT passing `--user-home` (which would enable home-adapter writes).
 */
function isolatedChildEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HERMES_")) delete env[key];
  return { ...env, HOME: home, USERPROFILE: home, NULLFORM_USER_HOME: home, LOCALAPPDATA: join(home, "AppData", "Local"), HERMES_HOME: join(home, "hermes"), HERMES_IGNORE_RULES: "" };
}

test("dry-run does not write files or directories to root", () => {
  const tempRoot = join(tmpdir(), `harness-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tempHome = createTempDir("harness-dry-home-");
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, "--dry-run", "--harness", "claude", "--root", tempRoot], { encoding: "utf8", env: isolatedChildEnv(tempHome), windowsHide: true });
    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /dry-run/i);
    assert.equal(existsSync(tempRoot), false, "Dry-run should not create the target root directory");
  } finally {
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("installation creates Claude, Codex, OpenCode, and Cursor adapters with substituted <HARNESS>", () => {
  for (const h of ["claude", "codex", "opencode", "cursor"]) {
    const tempRoot = createTempDir(`harness-${h}-`);
    const tempHome = createTempDir(`harness-${h}-home-`);
    try {
      const res = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", h, "--root", tempRoot], { encoding: "utf8", env: isolatedChildEnv(tempHome), windowsHide: true });
      assert.equal(res.status, 0, `Failed (${h}): ${res.stderr}`);
      const slashRoot = tempRoot.replace(/\\/g, "/");

      if (h === "claude") {
        const content = readFileSync(join(tempRoot, "CLAUDE.md"), "utf8");
        assert.equal(content.includes("<HARNESS>"), false);
        assert.ok(content.includes(slashRoot));
      } else if (h === "codex") {
        const content = readFileSync(join(tempRoot, "AGENTS.md"), "utf8");
        assert.equal(content.includes("<HARNESS>"), false);
        assert.ok(content.includes(slashRoot));
      } else if (h === "opencode") {
        assert.equal(existsSync(join(tempRoot, "AGENTS.md")), true);
        const jsonContent = JSON.parse(readFileSync(join(tempRoot, "opencode.json"), "utf8"));
        assert.ok(jsonContent["$schema"]);
      } else if (h === "cursor") {
        const content = readFileSync(join(tempRoot, ".cursor", "rules", "00-workflow.mdc"), "utf8");
        assert.ok(content.startsWith("---"));
        assert.equal(content.includes("<HARNESS>"), false);
        assert.ok(content.includes(slashRoot));
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  }
});
test("non-OMP installation keeps identity surfaces clean without native-home skill copies", () => {
  for (const harness of ["openclaw", "hermes", "openhuman"]) {
    const temp = createTempDir(`minimal-${harness}-`);
    const root = join(temp, "workflow");
    const home = join(temp, "user");
    const hostHome = join(home, "selected-profile");
    try {
      const result = spawnSync(process.execPath, [
        SCRIPT_PATH, "--harness", harness, "--root", root, "--user-home", home, "--host-home", hostHome, "--json",
      ], { encoding: "utf8", env: isolatedChildEnv(home) });
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.hostHome, hostHome);
      assert.equal(existsSync(join(root, "SOUL.md")), false);
      assert.equal(existsSync(join(root, "USER.md")), false);
      assert.equal(existsSync(join(hostHome, "SOUL.md")), false);
      assert.equal(existsSync(join(hostHome, "skills")), false);
      if (harness === "hermes") {
        const settings = loadYaml().parse(readFileSync(join(hostHome, "config.yaml"), "utf8"));
        assert.equal(settings.mcp_servers, undefined);
        assert.equal(plan.activation.status, "configured");
      } else {
        if (harness === "openclaw") {
          const config = preflightJson5Config(join(hostHome, "openclaw.json"));
          assert.equal(config.agents.entries.workflow.workspace, root.replace(/\\/g, "/"));
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
});

test("detectHarness and dry-run plans for openclaw, hermes, and openhuman", () => {
  const tempHome = createTempDir("harness-detect-home-");
  const tempRoot = createTempDir("harness-dry-spec-");
  const childHome = createTempDir("harness-dry-spec-home-");
  try {
    // Discovery must be driven by the fixture home, never by the real machine PATH: the
    // host may have OMP/Claude installed, which would (correctly) make detection ambiguous.
    const containedEnv = { ...isolatedChildEnv(tempHome), PATH: "", Path: "" };
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OMP_CONFIG_DIR", "OPENCLAW_STATE_DIR"]) {
      delete containedEnv[key];
    }
    mkdirSync(join(tempHome, ".openclaw"), { recursive: true });
    writeFileSync(join(tempHome, ".openclaw", "openclaw.json"), "{}", "utf8");
    assert.equal(detectHarness({ userHome: tempHome, projectRoot: tempRoot, env: containedEnv }), "openclaw");
    rmSync(join(tempHome, ".openclaw"), { recursive: true, force: true });

    const env = containedEnv;
    const selectedHermes = resolveHostHome({ harness: "hermes", userHome: tempHome, env }).path;
    mkdirSync(selectedHermes, { recursive: true });
    writeFileSync(join(selectedHermes, "config.yaml"), "skills:\n  auto_load: []\n", "utf8");
    assert.equal(detectHarness({ userHome: tempHome, projectRoot: tempRoot, env }), "hermes");
    rmSync(selectedHermes, { recursive: true, force: true });

    mkdirSync(join(tempHome, ".openhuman"), { recursive: true });
    assert.equal(detectHarness({ userHome: tempHome, projectRoot: tempRoot, env: containedEnv }), "openhuman");
    for (const [h, adapterSuffix] of [["openclaw", "openclaw.json"], ["hermes", "config.yaml"], ["openhuman", "AGENTS.md"]]) {
      const res = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", h, "--root", tempRoot, "--dry-run", "--json"], { encoding: "utf8", env: isolatedChildEnv(childHome), windowsHide: true });
      assert.equal(res.status, 0, res.stderr);
      const plan = JSON.parse(res.stdout);
      assert.equal(plan.harness, h);
      assert.ok(plan.adapters.some((p) => p.endsWith(adapterSuffix)));
      assert.ok(plan.filesToCopy.some((p) => p.includes("skills")));
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(childHome, { recursive: true, force: true });
  }
});

/** True when a harness prerequisite (`omp`, `openspec`) is runnable on this host. */
function hasCommand(name) {
  const probe = spawnSync(name, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 10000,
  });
  return !probe.error && probe.status === 0;
}

// The installer's contract is machine-independent: it must succeed with nothing
// but Node, leaving a tree the shipped verifier can inspect. The verifier then
// reports the OMP-only prerequisites (`openspec`, `omp`) as FAIL when the host
// lacks them — honest prerequisites, not install defects. Asserting a blanket
// exit 0 made a clean CI runner look broken.
test("OMP sandbox install is usable by the shipped verifier", () => {
  const temp = createTempDir("omp portable ");
  const root = join(temp, "live");
  const userHome = join(temp, "home");
  try {
    const installed = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "omp", "--root", root, "--user-home", userHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);

    const law = readFileSync(join(userHome, ".omp", "agent", "AGENTS.md"), "utf8");
    assert.ok(law.includes(root.replace(/\\/g, "/")));
    assert.ok(!law.includes("<HARNESS>"));
    assert.equal(readFileSync(join(userHome, ".omp", "agent", ".harness-root"), "utf8").trim(), root);
    assert.ok(existsSync(join(root, "tools", "sync.mjs")));
    assert.ok(existsSync(join(root, "tools", "sync-manifest.json")));

    const verified = spawnSync(process.execPath, [
      join(root, "tools", "verify.mjs"),
      "--profile", "verify", "--root", root, "--harness", root,
      "--user-home", userHome, "--json",
    ], { encoding: "utf8" });
    // A truncated document means stdout was cut mid-write (process.exit()
    // discarding a queued pipe write). Report the raw bytes: without them the
    // failure is indistinguishable from a genuine parse bug.
    let report;
    try {
      report = JSON.parse(verified.stdout);
    } catch (err) {
      throw new Error(
        `verify --json did not emit one parseable document (${err.message}); ` +
          `exit ${verified.status}, stdout ${Buffer.byteLength(verified.stdout)} bytes, ` +
          `stderr ${JSON.stringify((verified.stderr || "").slice(0, 400))}, ` +
          `tail ${JSON.stringify(verified.stdout.slice(-200))}`
      );
    }
    const statusOf = (label) =>
      report.results.find((result) => result.label.startsWith(label))?.status;
    // Installation-owned checks that do not depend on a native home catalogue: a fresh OMP
    // install keeps skills/rules/agent under the portable root, so the verifier's home-catalogue
    // checks are not part of this install's contract.
    for (const label of [
      "node present",
      "no unsubstituted placeholders",
      "prompt surfaces have no volatile literals",
      "prompt surfaces match baseline",
      "tier gate enforces artifacts",
      "portable core specification",
    ]) {
      assert.equal(statusOf(label), "PASS", `${label}: ${JSON.stringify(report.results)}`);
    }

    // Host prerequisites: FAIL is the correct answer when the tool is absent.
    assert.equal(
      statusOf("openspec present"),
      hasCommand("openspec") ? "PASS" : "FAIL",
      "openspec presence must be reported honestly"
    );
    assert.equal(
      statusOf("install doctor"),
      hasCommand("omp") ? "PASS" : "FAIL",
      "omp-dependent doctor must be reported honestly"
    );

    // Exit code must agree with the reported failures — no silent green.
    assert.equal(
      verified.status,
      report.results.some((r) => r.status === "FAIL") ? 1 : 0,
      verified.stderr
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("installation is idempotent on repeated execution and rejects unknown --harness", () => {
  const tempRoot = createTempDir("harness-idempotent-");
  const tempHome = createTempDir("harness-idempotent-home-");
  try {
    const res1 = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "claude", "--root", tempRoot], { encoding: "utf8", env: isolatedChildEnv(tempHome), windowsHide: true });
    assert.equal(res1.status, 0);
    const claudeMd1 = readFileSync(join(tempRoot, "CLAUDE.md"), "utf8");
    const fileCount1 = readdirSync(tempRoot).length;

    const res2 = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "claude", "--root", tempRoot], { encoding: "utf8", env: isolatedChildEnv(tempHome), windowsHide: true });
    assert.equal(res2.status, 0);
    assert.equal(readFileSync(join(tempRoot, "CLAUDE.md"), "utf8"), claudeMd1);
    assert.equal(readdirSync(tempRoot).length, fileCount1);

    const errRes = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "unknown_harness_xyz", "--root", tempRoot], { encoding: "utf8", env: isolatedChildEnv(tempHome), windowsHide: true });
    assert.equal(errRes.status, 2);
    assert.match(errRes.stderr, /unknown harness/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("install.sh without node in PATH gives instruction without stack trace", (t) => {
  const bashBin = getBashPath();
  if (!bashBin) { t?.skip?.("bash is unavailable on this host"); return; }
  const realBashPath = resolve(bashBin);
  const bashDir = dirname(realBashPath);
  const isolatedDir = createTempDir("isolated-bash-");
  try {
    let isolatedPath = bashDir;
    if (process.platform !== "win32") {
      try { symlinkSync(realBashPath, join(isolatedDir, "bash")); isolatedPath = isolatedDir; } catch {}
    }
    const res = spawnSync(realBashPath, [SH_PATH, "--help"], {
      encoding: "utf8",
      env: { PATH: isolatedPath, SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" },
    });
    assert.equal(res.error, undefined);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /node.*not found|requires node/i);
    assert.doesNotMatch(res.stderr, /at Module\._resolveFilename/i);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("isolated OMP install writes only native surfaces and preserves pre-existing legacy extras", () => {
  const temp = createTempDir("omp-rules-baseline-");
  const root = join(temp, "live");
  const userHome = join(temp, "home");
  const homeAgent = join(userHome, ".omp", "agent");
  const legacyMcp = join(homeAgent, "mcp.json");
  const legacyRule = join(userHome, ".agents", "rules", "enterprise-directives.md");
  mkdirSync(dirname(legacyMcp), { recursive: true });
  mkdirSync(dirname(legacyRule), { recursive: true });
  writeFileSync(legacyMcp, '{\n  "mcpServers": { "humanOwned": { "command": "node" } }\n}\n', "utf8");
  writeFileSync(legacyRule, "# Human rule, never adopted\n", "utf8");
  try {
    const installed = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "omp", "--root", root, "--user-home", userHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const plan = JSON.parse(installed.stdout);

    // Native surfaces only: law + pointer in the host home.
    const law = readFileSync(join(homeAgent, "AGENTS.md"), "utf8");
    assert.ok(law.includes(root.replace(/\\/g, "/")));
    assert.equal(law.includes("<HARNESS>"), false);
    assert.equal(readFileSync(join(homeAgent, ".harness-root"), "utf8").trim(), root);

    // No global catalogue or home config copies are created by a fresh install.
    assert.equal(existsSync(join(homeAgent, "rules")), false, "no agent-dir rules copy");
    assert.equal(existsSync(join(userHome, ".agents", "skills")), false, "no global skill catalogue");

    // Portable assets stay under the installation root.
    assert.ok(existsSync(join(root, ".code-size.baseline.json")));
    assert.ok(existsSync(join(root, "rules", "enterprise-directives.md")));
    assert.ok(existsSync(join(root, "skills")));

    // Pre-existing human/legacy extras are preserved byte-identically and reported as preserved.
    assert.equal(readFileSync(legacyMcp, "utf8"), '{\n  "mcpServers": { "humanOwned": { "command": "node" } }\n}\n');
    assert.ok(plan.warnings.some((w) => w.includes(basename(legacyMcp))), `warning must reference the preserved asset: ${JSON.stringify(plan.warnings)}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("translateStdioEntry and nested --root repository refusal", async () => {
  const mod = await import("../install-harness.mjs");
  const translate = mod.translateStdioEntry || mod.translateMcpEntry;
  assert.equal(typeof translate, "function");
  const winInput = { command: "cmd.exe", args: ["/c", "npx", "-y", "chrome-devtools-mcp@1.9.0"], env: {} };
  assert.equal(translate(winInput, "win32").command, "cmd.exe");
  assert.equal(translate(winInput, "linux").command, "npx");
  assert.deepEqual(translate(winInput, "linux").args, ["-y", "chrome-devtools-mcp@1.9.0"]);
  const posixInput = { command: "npx", args: ["-y", "chrome-devtools-mcp@1.9.0"], env: {} };
  assert.equal(translate(posixInput, "win32").command, "cmd.exe");

  const nestedDir = resolve(REPO_ROOT, "tools", `test-nested-refused-${Date.now()}`);
  const nestedHome = createTempDir("harness-nested-home-");
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "claude", "--root", nestedDir], { encoding: "utf8", timeout: 3000, env: isolatedChildEnv(nestedHome), windowsHide: true });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /subdirector|repo|inside|refus/i);
    assert.equal(existsSync(nestedDir), false);
  } finally {
    if (existsSync(nestedDir)) rmSync(nestedDir, { recursive: true, force: true });
    rmSync(nestedHome, { recursive: true, force: true });
  }
});

test("verifier with --user-home inspects sandbox .omp/agent and ignores external stale law", () => {
  const temp = createTempDir("omp-verify-userhome-");
  const root = join(temp, "live");
  const userHome = join(temp, "home");
  const externalHome = join(temp, "external-home");
  try {
    const installed = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "omp", "--root", root, "--user-home", userHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);

    const externalAgentDir = join(externalHome, ".omp", "agent");
    mkdirSync(externalAgentDir, { recursive: true });
    writeFileSync(join(externalAgentDir, "AGENTS.md"), "stale divergent law that should be ignored\n");

    const verified = spawnSync(process.execPath, [
      join(root, "tools", "verify.mjs"),
      "--profile", "verify", "--root", REPO_ROOT, "--harness", root,
      "--user-home", userHome, "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, AGENT_DIR: externalAgentDir, AGENTS_ROOT: join(externalHome, ".agents") },
    });

    let report;
    try {
      report = JSON.parse(verified.stdout);
    } catch (err) {
      throw new Error(`verify --json failed to parse: ${err.message}; stdout: ${verified.stdout}`);
    }

    const driftResult = report.results.find((r) => r.label.includes("drift"));
    assert.ok(driftResult, "drift check must be present in verify report");
    assert.equal(driftResult.status, "PASS", `sandbox law matching harness must pass drift: ${JSON.stringify(driftResult)}`);

    writeFileSync(join(userHome, ".omp", "agent", "AGENTS.md"), "corrupted sandbox law\n");
    const verifiedDrifted = spawnSync(process.execPath, [
      join(root, "tools", "verify.mjs"),
      "--profile", "verify", "--root", REPO_ROOT, "--harness", root,
      "--user-home", userHome, "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, AGENT_DIR: externalAgentDir, AGENTS_ROOT: join(externalHome, ".agents") },
    });
    let reportDrifted;
    try {
      reportDrifted = JSON.parse(verifiedDrifted.stdout);
    } catch (err) {
      throw new Error(`verify --json failed to parse: ${err.message}; stdout: ${verifiedDrifted.stdout}`);
    }
    const driftDrifted = reportDrifted.results.find((r) => r.label.includes("drift"));
    assert.ok(driftDrifted, "drift check must be present in verify report");
    assert.equal(driftDrifted.status, "FAIL", "must detect drift when sandbox law itself is modified");

    // OMP law copy containment assertion: sync preflight refuses when law copy escapes declared root
    const syncScript = join(REPO_ROOT, "tools", "sync.mjs");
    const sandboxAgentDir = join(userHome, ".omp", "agent");
    const outsideLaw = join(temp, "outside-law.md");
    writeFileSync(outsideLaw, "escaped law\n");

    let fileLinkOk = false;
    try {
      rmSync(join(sandboxAgentDir, "AGENTS.md"), { force: true });
      symlinkSync(outsideLaw, join(sandboxAgentDir, "AGENTS.md"), "file");
      fileLinkOk = true;
    } catch (err) {
      if (err.code !== "EPERM") throw err;
    }

    if (fileLinkOk) {
      const resEscaped = spawnSync(process.execPath, [
        syncScript, "--repo", REPO_ROOT, "--harness", root,
        "--agent-dir", sandboxAgentDir, "--check", "--only", "AGENTS.md",
      ], { encoding: "utf8" });
      assert.notEqual(resEscaped.status, 0, "sync must refuse when agent law copy escapes declared agentDir");
      assert.match(resEscaped.stderr + resEscaped.stdout, /REFUSED.*agent law path/i);
      rmSync(join(sandboxAgentDir, "AGENTS.md"), { force: true });
      writeFileSync(join(sandboxAgentDir, "AGENTS.md"), "restored clean law\n");
    }

    const outsideAgent = join(temp, "outside-agent");
    mkdirSync(outsideAgent, { recursive: true });
    writeFileSync(join(outsideAgent, "AGENTS.md"), "escaped harness law\n");
    rmSync(join(root, "agent"), { recursive: true, force: true });
    symlinkSync(outsideAgent, join(root, "agent"), "junction");
    const resHarnessEscaped = spawnSync(process.execPath, [
      syncScript, "--repo", REPO_ROOT, "--harness", root,
      "--agent-dir", sandboxAgentDir, "--check", "--only", "agentsX",
    ], { encoding: "utf8" });
    assert.notEqual(resHarnessEscaped.status, 0, "sync must refuse when harness law copy escapes declared root");
    assert.match(resHarnessEscaped.stderr + resHarnessEscaped.stdout, /REFUSED.*harness law path/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("install-harness preserves pre-existing OMP legacy extras and user markdown instructions idempotently", () => {
  const temp = createTempDir("omp-install-legacy-ext-");
  const root = join(temp, "harness");
  const userHome = join(temp, "home");
  const customExtDir = join(userHome, ".omp", "agent", "extensions");
  mkdirSync(customExtDir, { recursive: true });
  const unrelatedExtPath = join(customExtDir, "unrelated-custom.ts");
  const unrelatedExtBytes = "// custom extension\nexport default () => {};\n";
  writeFileSync(unrelatedExtPath, unrelatedExtBytes, "utf8");

  try {
    for (let run = 1; run <= 2; run++) {
      const res = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "omp", "--root", root, "--user-home", userHome, "--json"], { encoding: "utf8" });
      assert.equal(res.status, 0, res.stderr);
      // Human extension is neither replaced nor extended by an auto-installed one.
      assert.equal(readFileSync(unrelatedExtPath, "utf8"), unrelatedExtBytes);
      assert.equal(existsSync(join(customExtDir, "nullform-jev.ts")), false, "installer must not auto-install JEV into a human extensions dir");
      assert.equal(readFileSync(join(userHome, ".omp", "agent", ".harness-root"), "utf8").trim(), root);
    }

    const claudeRoot = join(temp, "claude-root");
    mkdirSync(claudeRoot, { recursive: true });
    const claudePath = join(claudeRoot, "CLAUDE.md");
    writeFileSync(claudePath, "# My Custom Instructions\nAlways run tests.\n", "utf8");

    const res1 = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "claude", "--root", claudeRoot, "--user-home", userHome, "--json"], { encoding: "utf8" });
    assert.equal(res1.status, 0, res1.stderr);
    const plan1 = JSON.parse(res1.stdout);
    assert.ok(plan1.managedFiles?.[claudePath]);

    let content = readFileSync(claudePath, "utf8");
    assert.ok(content.includes("# My Custom Instructions") && content.includes("<!-- BEGIN NULLFORM WORKFLOW -->"));
    writeFileSync(claudePath, content.replace("Always run tests.", "Always run tests twice."), "utf8");

    const res2 = spawnSync(process.execPath, [SCRIPT_PATH, "--harness", "claude", "--root", claudeRoot, "--user-home", userHome, "--json"], { encoding: "utf8" });
    assert.equal(res2.status, 0, res2.stderr);
    const content2 = readFileSync(claudePath, "utf8");
    assert.ok(content2.includes("Always run tests twice."));
    assert.equal((content2.match(/<!-- BEGIN NULLFORM WORKFLOW -->/g) || []).length, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("reinstallation preserves JSONC comments/trailing commas, respects opencode.jsonc, copies 3 parser deps, and rejects invalid JSON5 in JSONC", () => {
  const tempRoot = createTempDir("harness-preserve-cfg-root-");
  const tempHome = createTempDir("harness-preserve-cfg-home-");
  try {
    const opencodeJsoncPath = join(tempRoot, "opencode.jsonc");
    writeFileSync(opencodeJsoncPath, [
      "{",
      "  // User JSONC comment preserved",
      '  "customUserSecret": "super-secret-123",',
      '  "customSetting": 42,',
      "}",
      "",
    ].join("\n"), "utf8");

    const hermesHome = join(tempHome, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    const hermesConfig = join(hermesHome, "config.yaml");
    writeFileSync(hermesConfig, "model: custom-model-v1\napi_key: sk-user-hermes-secret\n", "utf8");

    const opencodeRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "opencode", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(opencodeRes.status, 0, `OpenCode install failed: ${opencodeRes.stderr}`);

    assert.equal(existsSync(opencodeJsoncPath), true, "opencode.jsonc must be preserved");
    assert.equal(existsSync(join(tempRoot, "opencode.json")), false, "opencode.jsonc must not be shadowed by a fresh opencode.json");
    const rawSavedJsonc = readFileSync(opencodeJsoncPath, "utf8");
    assert.ok(rawSavedJsonc.includes("// User JSONC comment preserved"), "JSONC comment must be preserved via modify/applyEdits");
    const savedOpencode = preflightJsoncConfig(opencodeJsoncPath);
    assert.equal(savedOpencode.customUserSecret, "super-secret-123", "User secret must be preserved in JSONC");
    assert.equal(savedOpencode.customSetting, 42, "User custom setting must be preserved in JSONC");
    assert.ok(savedOpencode["$schema"], "$schema must exist");

    for (const dep of ["yaml", "json5", "jsonc-parser"]) {
      assert.equal(existsSync(join(tempRoot, "tools", "node_modules", dep, "package.json")), true, `Runtime parser ${dep} must be copied to tools/node_modules`);
    }

    const hermesRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "hermes", "--root", tempRoot, "--user-home", tempHome, "--host-home", hermesHome, "--json",
    ], { encoding: "utf8", env: isolatedChildEnv(tempHome) });
    assert.equal(hermesRes.status, 0, `Hermes install failed: ${hermesRes.stderr}`);

    const savedHermes = readFileSync(hermesConfig, "utf8");
    assert.ok(savedHermes.includes("api_key: sk-user-hermes-secret"), "Hermes API key must be preserved");
    assert.ok(savedHermes.includes("model: custom-model-v1"), "Hermes model setting must be preserved");
    assert.equal(loadYaml().parse(savedHermes).mcp_servers, undefined);

    const secretCanary = "sk-canary-never-echo-777";
    writeFileSync(opencodeJsoncPath, `{ unquotedJson5Key: "${secretCanary}" }`, "utf8");
    const corruptRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "opencode", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.notEqual(corruptRes.status, 0, "Install must fail on invalid JSON5 syntax in OpenCode JSONC");
    assert.match(corruptRes.stderr, /Preflight failed: malformed JSONC/i);
    assert.equal((corruptRes.stderr + corruptRes.stdout).includes(secretCanary), false, "Preflight error must not leak secret values");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("consumer regression: appended legacy human note is preserved across adapter and OMP law migration", () => {
  const tempRoot = createTempDir("harness-legacy-note-root-");
  const tempHome = createTempDir("harness-legacy-note-home-");
  try {
    const agentsMdPath = join(tempRoot, "AGENTS.md");
    writeFileSync(agentsMdPath, [
      "# Codex NULLFORM WORKFLOW Adapter",
      "",
      "Полный свод законов и протокол оркестратора: /path/agent/AGENTS.md",
      "- Возвратный контракт (≤25 строк): STATUS | FILES | TESTS было->стало | CONCERNS.",
      "",
      "## Human Private Notes",
      "Important user directive: never modify DB directly.",
    ].join("\n"), "utf8");

    const res = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "codex", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(res.status, 0, `Install failed: ${res.stderr}`);

    const content = readFileSync(agentsMdPath, "utf8");
    assert.ok(content.includes("<!-- BEGIN NULLFORM WORKFLOW -->"), "Managed block must be installed");
    assert.ok(content.includes("## Human Private Notes"), "Appended human notes heading must be preserved");
    assert.ok(content.includes("Important user directive: never modify DB directly."), "Appended human text must be preserved");

    const ompAgentDir = join(tempHome, ".omp", "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    const ompLawPath = join(ompAgentDir, "AGENTS.md");
    // Unmarked human-only law file: ownership is unproven, so the installer must preserve the
    // human bytes and add its own managed block rather than rewriting or deleting them.
    writeFileSync(ompLawPath, "# My Local OMP Notes\n\n## Custom OMP Operator Rule\nKeep local telemetry off.\n", "utf8");

    const ompRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "omp", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(ompRes.status, 0, `OMP install failed: ${ompRes.stderr}`);
    const migratedOmpLaw = readFileSync(ompLawPath, "utf8");
    assert.equal(migratedOmpLaw.split("<!-- BEGIN NULLFORM WORKFLOW -->").length - 1, 1, "OMP law must carry exactly one managed block");
    assert.equal(migratedOmpLaw.split("<!-- END NULLFORM WORKFLOW -->").length - 1, 1, "OMP law managed block must be complete");
    assert.ok(migratedOmpLaw.includes("# My Local OMP Notes"), "Unmarked human law heading must be preserved");
    assert.ok(migratedOmpLaw.includes("Keep local telemetry off."), "Appended human OMP rule must be preserved");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("consumer regression: malformed markers, malformed YAML, and complex YAML anchors/comments", () => {
  const tempRoot = createTempDir("harness-yaml-marker-root-");
  const tempHome = createTempDir("harness-yaml-marker-home-");
  try {
    const claudePath = join(tempRoot, "CLAUDE.md");
    writeFileSync(claudePath, "# Instructions\n<!-- BEGIN NULLFORM WORKFLOW -->\nIncomplete block\n", "utf8");
    const badMarkerRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "claude", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.notEqual(badMarkerRes.status, 0);
    assert.match(badMarkerRes.stderr, /Preflight failed: malformed managed markers/i);
    assert.equal(existsSync(join(tempRoot, "tools")), false, "Zero writes on preflight failure");
    rmSync(claudePath, { force: true });

    const hermesHome = join(tempHome, ".hermes");
    mkdirSync(hermesHome, { recursive: true });
    const hermesConfig = join(hermesHome, "config.yaml");
    writeFileSync(hermesConfig, "invalid: [unclosed list\n", "utf8");
    const badYamlRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "hermes", "--root", tempRoot, "--user-home", tempHome, "--host-home", hermesHome, "--json",
    ], { encoding: "utf8", env: isolatedChildEnv(tempHome) });
    assert.notEqual(badYamlRes.status, 0);
    assert.match(badYamlRes.stderr, /Preflight failed: malformed YAML/i);
    assert.equal(existsSync(join(tempRoot, "tools")), false, "Zero files copied on YAML preflight failure");

    writeFileSync(hermesConfig, [
      "# Top level comment",
      "default_endpoint: &default_ep 'https://api.example.com/v1/#endpoint'",
      "multiline_note: |",
      "  Line one with # not a comment",
      "  Line two",
      "backup_endpoint: *default_ep",
      "custom_user_setting: 12345",
      "",
    ].join("\n"), "utf8");
    const okYamlRes = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "hermes", "--root", tempRoot, "--user-home", tempHome, "--host-home", hermesHome, "--json",
    ], { encoding: "utf8", env: isolatedChildEnv(tempHome) });
    assert.equal(okYamlRes.status, 0, okYamlRes.stderr);
    const afterYaml = readFileSync(hermesConfig, "utf8");
    assert.ok(afterYaml.includes("default_endpoint: &default_ep") && afterYaml.includes("backup_endpoint: *default_ep"));
    assert.ok(afterYaml.includes("Line one with # not a comment") && afterYaml.includes("custom_user_setting: 12345"));
    assert.equal(loadYaml().parse(afterYaml).mcp_servers, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

