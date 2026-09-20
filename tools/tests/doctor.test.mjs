import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CORE_TOOLS, runDoctor, parseCliArgs } from "../doctor.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DOCTOR_PATH = resolve(REPO_ROOT, "tools/doctor.mjs");

function createMockHarness(baseDir, { omitFiles = [], omitTools = [] } = {}) {
  const harness = join(baseDir, "harness");
  mkdirSync(harness, { recursive: true });

  // Top-level files
  writeFileSync(join(harness, "README.md"), "# Mock README\n", "utf8");
  writeFileSync(join(harness, "CONTEXT.md"), "# Mock CONTEXT\n", "utf8");

  // Core & rules
  mkdirSync(join(harness, "core"), { recursive: true });
  writeFileSync(join(harness, "core/PORTABLE.md"), "# Portable\n", "utf8");

  mkdirSync(join(harness, "rules"), { recursive: true });
  writeFileSync(join(harness, "rules/enterprise-directives.md"), "# Directives\n", "utf8");

  // Agent dirs
  mkdirSync(join(harness, "agent/agents"), { recursive: true });
  writeFileSync(join(harness, "agent/AGENTS.md"), "# AGENTS\n", "utf8");
  const agentRoles = [
    "fixer.md", "orchestrator.md", "reviewer.md", "designer.md",
    "oracle.md", "security-reviewer.md", "sonic.md", "librarian.md",
    "explorer.md", "task.md", "scout.md"
  ];
  for (const role of agentRoles) {
    writeFileSync(join(harness, "agent/agents", role), `---
name: ${role.replace(".md", "")}
---
# Role
`, "utf8");
  }
  // Templates & paseo
  mkdirSync(join(harness, "templates"), { recursive: true });
  mkdirSync(join(harness, "paseo"), { recursive: true });

  // Skills
  mkdirSync(join(harness, "skills"), { recursive: true });

  // Tools
  mkdirSync(join(harness, "tools"), { recursive: true });
  for (const tool of CORE_TOOLS) {
    if (omitTools.includes(tool)) continue;
    // Copy real tool or create minimal valid script
    const realToolPath = join(REPO_ROOT, "tools", tool);
    try {
      copyFileSync(realToolPath, join(harness, "tools", tool));
    } catch {
      writeFileSync(join(harness, "tools", tool), "export const ok = true;\n", "utf8");
    }
  }

  for (const f of omitFiles) {
    try {
      rmSync(join(harness, f), { recursive: true, force: true });
    } catch {}
  }

  return harness;
}

test("parseCliArgs parses custom flags correctly", () => {
  const parsed = parseCliArgs([
    "--harness", "/tmp/my-harness",
    "--agent-dir", "/tmp/my-agent",
    "--agents-home", "/tmp/my-agents-home",
    "--mode", "installed",
    "--json",
    "--quiet"
  ]);

  assert.equal(parsed.mode, "installed");
  assert.equal(parsed.json, true);
  assert.equal(parsed.quiet, true);
  assert.equal(parsed.help, false);
});

test("doctor real workflow-repo in repo mode returns exit 0 and parses JSON", () => {
  const res = spawnSync(
    process.execPath,
    [DOCTOR_PATH, "--harness", REPO_ROOT, "--json"],
    { encoding: "utf8" }
  );

  assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. Output: ${res.stdout}\n${res.stderr}`);

  const json = JSON.parse(res.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.mode, "repo");
  assert.equal(json.summary.fail, 0);
  assert.ok(Array.isArray(json.checks));

  const checkIds = json.checks.map(c => c.id);
  assert.ok(checkIds.includes("node"));
  assert.ok(checkIds.includes("harness-files"));
  assert.ok(checkIds.includes("tools-syntax"));
  assert.ok(checkIds.includes("tools-smoke"));
  assert.ok(checkIds.includes("agent-wiring"));
  assert.ok(checkIds.includes("skills"));
  assert.ok(checkIds.includes("prompt-baseline"));
  assert.ok(checkIds.includes("configs"));
});

test("doctor broken fixture missing required file returns exit 1 with exact path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-fail-file-"));
  try {
    const harness = createMockHarness(tmp, { omitFiles: ["CONTEXT.md"] });

    const res = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--json"],
      { encoding: "utf8" }
    );

    assert.equal(res.status, 1, `Expected exit 1 for missing CONTEXT.md, got ${res.status}`);

    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, false);
    assert.ok(json.summary.fail > 0);

    const harnessFilesCheck = json.checks.find(c => c.id === "harness-files");
    assert.ok(harnessFilesCheck, "harness-files check must be present");
    assert.equal(harnessFilesCheck.status, "fail");
    assert.ok(harnessFilesCheck.detail.includes("CONTEXT.md"), `Expected CONTEXT.md in fail detail: ${harnessFilesCheck.detail}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor broken fixture missing core tool returns exit 1 with exact path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-fail-tool-"));
  try {
    const harness = createMockHarness(tmp, { omitTools: ["prompt-lint.mjs"] });

    const res = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--json"],
      { encoding: "utf8" }
    );

    assert.equal(res.status, 1, `Expected exit 1 for missing core tool, got ${res.status}`);

    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, false);
    assert.ok(json.summary.fail > 0);

    const toolsSyntaxCheck = json.checks.find(c => c.id === "tools-syntax");
    assert.ok(toolsSyntaxCheck, "tools-syntax check must be present");
    assert.equal(toolsSyntaxCheck.status, "fail");
    assert.ok(toolsSyntaxCheck.detail.includes("prompt-lint.mjs"), `Expected prompt-lint.mjs in fail detail: ${toolsSyntaxCheck.detail}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor full pass fixture with mock harness in installed mode", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-installed-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    const agentsHome = join(tmp, "agents-home");

    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(agentsHome, "skills"), { recursive: true });

    // Link harness-root
    writeFileSync(join(agentDir, ".harness-root"), harness + "\n", "utf8");

    // Copy agent defs and create configs
    writeFileSync(join(agentDir, "AGENTS.md"), `# AGENTS\nHarness: ${harness}\n`, "utf8");
    for (const role of [
      "fixer.md", "orchestrator.md", "reviewer.md", "designer.md",
      "oracle.md", "security-reviewer.md", "sonic.md", "librarian.md",
      "explorer.md", "task.md", "scout.md"
    ]) {
      writeFileSync(join(agentDir, "agents", role), "# Role\n", "utf8");
    }

    // Rules in agentDir and agentsHome
    mkdirSync(join(agentDir, "rules"), { recursive: true });
    writeFileSync(join(agentDir, "rules/enterprise-directives.md"), "# Directives\n", "utf8");
    mkdirSync(join(agentsHome, "rules"), { recursive: true });
    writeFileSync(join(agentsHome, "rules/enterprise-directives.md"), "# Directives\n", "utf8");
    // Configs
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    writeFileSync(join(agentDir, "models.yml"), "models: []\n", "utf8");
    writeFileSync(join(agentDir, "config.yml"), "editor: nano\n", "utf8");

    const res = spawnSync(
      process.execPath,
      [
        DOCTOR_PATH,
        "--harness", harness,
        "--agent-dir", agentDir,
        "--agents-home", agentsHome,
        "--json"
      ],
      { encoding: "utf8" }
    );

    const json = JSON.parse(res.stdout);
    assert.equal(json.mode, "installed");
    assert.equal(json.ok, true, `Expected ok: true, got failures: ${JSON.stringify(json.checks.filter(c => c.status === "fail"))}`);
    assert.equal(json.summary.fail, 0);

    const agentWiringCheck = json.checks.find(c => c.id === "agent-wiring");
    assert.equal(agentWiringCheck.status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("skills check fixture: parity drift produces warn and exit 0 (ok: true)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-parity-"));
  try {
    const harness = createMockHarness(tmp);
    const agentsHome = join(tmp, "agents-home");
    mkdirSync(join(agentsHome, "skills/mock-skill"), { recursive: true });
    writeFileSync(
      join(agentsHome, "skills/mock-skill/SKILL.md"),
      "---\nname: mock-skill\ndescription: Installed version\n---\nBody installed\n",
      "utf8"
    );

    // Repo copy differs -> parity problem
    mkdirSync(join(harness, "skills/mock-skill"), { recursive: true });
    writeFileSync(
      join(harness, "skills/mock-skill/SKILL.md"),
      "---\nname: mock-skill\ndescription: Repo version\n---\nBody repo\n",
      "utf8"
    );

    const res = spawnSync(
      process.execPath,
      [
        DOCTOR_PATH,
        "--harness", harness,
        "--agent-dir", join(tmp, "agent-dir"),
        "--agents-home", agentsHome,
        "--mode", "repo",
        "--json"
      ],
      { encoding: "utf8" }
    );

    const json = JSON.parse(res.stdout);
    const skillsCheck = json.checks.find(c => c.id === "skills");
    assert.ok(skillsCheck, "skills check exists");
    assert.equal(skillsCheck.status, "warn");
    assert.match(skillsCheck.detail, /parity/);
    assert.equal(json.ok, true);
    assert.equal(res.status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("skills check fixture: orphan in repo produces fail and exit 1 (ok: false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-"));
  try {
    const harness = createMockHarness(tmp);
    const agentsHome = join(tmp, "agents-home");
    mkdirSync(join(agentsHome, "skills"), { recursive: true });

    // Repo has a skill not in installed -> orphan
    mkdirSync(join(harness, "skills/orphan-skill"), { recursive: true });
    writeFileSync(
      join(harness, "skills/orphan-skill/SKILL.md"),
      "---\nname: orphan-skill\ndescription: Repo orphan\n---\nBody\n",
      "utf8"
    );

    const res = spawnSync(
      process.execPath,
      [
        DOCTOR_PATH,
        "--harness", harness,
        "--agent-dir", join(tmp, "agent-dir"),
        "--agents-home", agentsHome,
        "--mode", "repo",
        "--json"
      ],
      { encoding: "utf8" }
    );

    const json = JSON.parse(res.stdout);
    const skillsCheck = json.checks.find(c => c.id === "skills");
    assert.ok(skillsCheck, "skills check exists");
    assert.equal(skillsCheck.status, "fail");
    assert.match(skillsCheck.detail, /orphan/);
    assert.equal(json.ok, false);
    assert.equal(res.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("configs check handles UTF-8 BOM in mcp.json and flags invalid JSON", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-bom-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    mkdirSync(agentDir, { recursive: true });

    // 1. mcp.json with UTF-8 BOM (\uFEFF) -> PASS
    writeFileSync(join(agentDir, "mcp.json"), "\uFEFF{\n  \"mcpServers\": {}\n}\n", "utf8");

    const resBom = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--agent-dir", agentDir, "--mode", "repo", "--json"],
      { encoding: "utf8" }
    );
    const jsonBom = JSON.parse(resBom.stdout);
    const configsCheckBom = jsonBom.checks.find(c => c.id === "configs");
    assert.ok(configsCheckBom, "configs check exists");
    assert.equal(configsCheckBom.status, "pass");
    assert.match(configsCheckBom.detail, /валидный JSON/);

    // 2. mcp.json without BOM -> PASS
    writeFileSync(join(agentDir, "mcp.json"), "{\n  \"mcpServers\": {}\n}\n", "utf8");

    const resNoBom = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--agent-dir", agentDir, "--mode", "repo", "--json"],
      { encoding: "utf8" }
    );
    const jsonNoBom = JSON.parse(resNoBom.stdout);
    const configsCheckNoBom = jsonNoBom.checks.find(c => c.id === "configs");
    assert.ok(configsCheckNoBom, "configs check exists");
    assert.equal(configsCheckNoBom.status, "pass");
    assert.match(configsCheckNoBom.detail, /валидный JSON/);

    // 3. invalid JSON -> FAIL
    writeFileSync(join(agentDir, "mcp.json"), "\uFEFF{\n  invalid json,\n}\n", "utf8");

    const resInvalid = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--agent-dir", agentDir, "--mode", "repo", "--json"],
      { encoding: "utf8" }
    );
    const jsonInvalid = JSON.parse(resInvalid.stdout);
    const configsCheckInvalid = jsonInvalid.checks.find(c => c.id === "configs");
    assert.ok(configsCheckInvalid, "configs check exists");
    assert.equal(configsCheckInvalid.status, "fail");
    assert.match(configsCheckInvalid.detail, /не является валидным JSON/);
    assert.equal(jsonInvalid.ok, false);
    assert.equal(resInvalid.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
