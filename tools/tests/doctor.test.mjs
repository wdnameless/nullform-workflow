import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  CORE_TOOLS,
  REQUIRED_ROLES,
  runDoctor,
  parseRoleModels,
  probeProviders,
  discoverRepoClone,
  isRepoTree,
  compareAgentDefs,
  roleNamesIn,
  missingRequiredRoles,
} from "../doctor.mjs";

import { checkConfigs } from "../doctor-checks.mjs";
import { doctorLite } from "../doctor-lite.mjs";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DOCTOR_PATH = resolve(REPO_ROOT, "tools/doctor.mjs");

function setupOmpShim() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-omp-shim-"));
  const pluginsJson = JSON.stringify({
    npm: [
      { name: "@dietrichgebert/ponytail", version: "4.10.0" },
      { name: "@plannotator/pi-extension", version: "0.27.16" },
      { name: "oh-my-pi-plugin-grok-build", version: "0.2.2" },
      { name: "oh-my-pi-plugin-morph", version: "0.6.0" },
      { name: "omp-plugin-duplicate-detector", version: "0.3.0" },
      { name: "omp-typescript-complexity-evaluator", version: "1.0.3" },
      { name: "omp-url-pin", version: "1.2.0" },
      { name: "pi-bar", version: "0.3.44" },
      { name: "pi-gh-cli", version: "0.2.5" },
      { name: "pi-goal-x", version: "0.31.6" },
      { name: "pi-lens", version: "4.2.1" },
      { name: "pi-linter", version: "0.2.7" },
      { name: "pi-prompt-shelf", version: "1.1.2" },
      { name: "pi-qq", version: "0.1.17" },
    ],
  });

  const nodeScript = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'plugin' && args[1] === 'list') {",
    `  process.stdout.write(${JSON.stringify(pluginsJson)});`,
    "  process.exit(0);",
    "}",
    "if (args[0] === 'plugin' && args[1] === 'doctor') {",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
  ].join("\n");

  const ompPath = join(dir, "omp");
  writeFileSync(ompPath, nodeScript, { encoding: "utf8", mode: 0o755 });
  chmodSync(ompPath, 0o755);

  if (process.platform === "win32") {
    writeFileSync(join(dir, "omp.cmd"), `@node "%~dp0omp" %*\r\n`, "utf8");
  }

  return dir;
}

const OMP_SHIM_DIR = setupOmpShim();
const ORIGINAL_PATH = process.env.PATH || "";
process.env.PATH = `${OMP_SHIM_DIR}${delimiter}${ORIGINAL_PATH}`;

/** Каталоги, покрытые манифестом sync.ps1 (та же область, что у orphan-files). */
const MANIFEST_DIRS = ["tools", "agent", "rules", "core", "templates", "paseo"];

function resolveCliArgs(args) {
  const extra = [];
  const harnessIdx = args.indexOf("--harness");
  if (harnessIdx !== -1 && args[harnessIdx + 1]) {
    const baseDir = dirname(resolve(args[harnessIdx + 1]));
    for (const [flag, dir] of [["--agents-home", "agents-home"], ["--agent-dir", "agent-dir"]]) {
      const candidate = join(baseDir, dir);
      if (!args.includes(flag) && existsSync(candidate)) extra.push(flag, candidate);
    }
  }
  return [...args, ...extra];
}

/** Запускает doctor как CLI и возвращает {status, json}. */
function runDoctorCli(args) {
  const finalArgs = resolveCliArgs(args);
  const res = spawnSync(process.execPath, [DOCTOR_PATH, ...finalArgs, "--json"], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

function checkOf(json, id) {
  return json.checks.find((c) => c.id === id);
}

/**
 * Асинхронный запуск CLI: нужен там, где провайдер обслуживается HTTP-сервером
 * внутри теста — spawnSync заблокировал бы event loop и сервер не ответил бы.
 */
function runDoctorCliAsync(args) {
  const finalArgs = resolveCliArgs(args);
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [DOCTOR_PATH, ...finalArgs, "--json"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolvePromise({ status, json, stdout, stderr });
    });
  });
}

/**
 * Клон репозитория внутри харнесса: маркеры репозитория + зеркало каталогов манифеста.
 * `extraFiles` попадают ТОЛЬКО в харнесс (это и есть сироты).
 */
function addRepoClone(harness, extraFiles = []) {
  const clone = join(harness, "workflow-repo");
  for (const dir of MANIFEST_DIRS) {
    cpSync(join(harness, dir), join(clone, dir), { recursive: true });
  }
  if (existsSync(join(harness, "skills"))) {
    cpSync(join(harness, "skills"), join(clone, "skills"), { recursive: true });
  }
  writeFileSync(join(clone, "install.ps1"), "# repo marker\n", "utf8");
  writeFileSync(join(clone, "agent/models.yml.example"), "providers: {}\n", "utf8");

  for (const rel of extraFiles) {
    const full = join(harness, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "harness-only\n", "utf8");
  }
  return clone;
}

/** models.yml с одним провайдером; baseUrl намеренно ненадёжен (порт 1 — отказ). */
function modelsYamlFixture({ livePort = null } = {}) {
  const lines = ["providers:", "  dead-provider:", "    baseUrl: http://127.0.0.1:1/v1", "    apiKey: sk-fixture-secret-key", "    models:", "      - id: model-a"];
  if (livePort) {
    lines.push(
      "  live-provider:",
      `    baseUrl: http://127.0.0.1:${livePort}/v1`,
      "    models:",
      "      - id: model-b"
    );
  }
  return lines.join("\n") + "\n";
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function createMockHarness(baseDir, { omitFiles = [], omitTools = [] } = {}) {
  const harness = join(baseDir, "harness");
  mkdirSync(harness, { recursive: true });

  mkdirSync(join(baseDir, "agents-home", "skills"), { recursive: true });
  mkdirSync(join(baseDir, "agent-dir"), { recursive: true });
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
  // Обязательные роли + sonic (наш форк): форк встроенного scout/task/security-reviewer удалён.
  const agentRoles = REQUIRED_ROLES.map((role) => `${role}.md`).concat("sonic.md");
  for (const role of agentRoles) {
    writeFileSync(join(harness, "agent/agents", role), `---
name: ${role.replace(".md", "")}
---
# Role
`, "utf8");
  }
  // Plugins manifest
  writeFileSync(
    join(harness, "agent/plugins.json"),
    JSON.stringify(
      {
        version: 1,
        plugins: [
          { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
          { name: "oh-my-pi-plugin-morph", spec: "oh-my-pi-plugin-morph@0.6.0", required: true },
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
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
    const harnessToolPath = join(harness, "tools", tool);
    mkdirSync(dirname(harnessToolPath), { recursive: true });
    try {
      copyFileSync(realToolPath, harnessToolPath);
    } catch {
      writeFileSync(harnessToolPath, "export const ok = true;\n", "utf8");
    }
  }

  for (const f of omitFiles) {
    try {
      rmSync(join(harness, f), { recursive: true, force: true });
    } catch {}
  }

  return harness;
}


test("doctor real workflow-repo in repo mode returns valid exit and parses JSON", () => {
  const res = spawnSync(
    process.execPath,
    [DOCTOR_PATH, "--harness", REPO_ROOT, "--json"],
    { encoding: "utf8" }
  );

  const json = JSON.parse(res.stdout);
  const expectedExit = json.summary.fail > 0 ? 1 : 0;
  assert.equal(res.status, expectedExit, `Expected exit ${expectedExit}, got ${res.status}. Output: ${res.stdout}\n${res.stderr}`);
  assert.equal(json.ok, json.summary.fail === 0);
  assert.equal(json.mode, "repo");
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
  assert.ok(checkIds.includes("agents-drift"));
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

test("doctor fails when required sync engine and manifest are missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-fail-tool-"));
  try {
    const harness = createMockHarness(tmp, { omitTools: ["sync.mjs", "sync-manifest.json"] });

    const res = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--json"],
      { encoding: "utf8" }
    );

    assert.equal(res.status, 1, `Expected exit 1 for missing sync files, got ${res.status}`);

    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, false);
    assert.ok(json.summary.fail > 0);
    const toolsSyntaxCheck = json.checks.find(c => c.id === "tools-syntax");
    assert.ok(toolsSyntaxCheck, "tools-syntax check must be present");
    assert.equal(toolsSyntaxCheck.status, "fail");
    assert.match(toolsSyntaxCheck.detail, /sync\.mjs/);
    assert.match(toolsSyntaxCheck.detail, /sync-manifest\.json/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor tools-syntax enumerates nested runtime modules and refuses to certify unreadable or linked entries", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-nested-syntax-"));
  try {
    const harness = createMockHarness(tmp);
    const nestedBroken = join(harness, "tools", "installation", "broken.mjs");
    writeFileSync(nestedBroken, "export function broken( {\n", "utf8");

    const res = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 1, `Expected exit 1 for invalid nested module, got ${res.status}. ${res.stdout}`);

    const json = JSON.parse(res.stdout);
    const toolsSyntaxCheck = json.checks.find(c => c.id === "tools-syntax");
    assert.ok(toolsSyntaxCheck, "tools-syntax check must be present");
    assert.equal(toolsSyntaxCheck.status, "fail");
    assert.match(toolsSyntaxCheck.detail, /installation\/broken\.mjs/, "Nested module must be syntax-checked, not silently skipped");

    let linked = false;
    try {
      symlinkSync(nestedBroken, join(harness, "tools", "installation", "linked.mjs"), "file");
      linked = true;
    } catch {
      linked = false; // Symlink creation is privileged on some hosts; the nested check above still applies.
    }
    if (linked) {
      const linkedRes = spawnSync(
        process.execPath,
        [DOCTOR_PATH, "--harness", harness, "--json"],
        { encoding: "utf8" }
      );
      const linkedJson = JSON.parse(linkedRes.stdout);
      const linkedCheck = linkedJson.checks.find(c => c.id === "tools-syntax");
      assert.match(linkedCheck.detail, /installation\/linked\.mjs/, "A linked entry must be reported, never silently certified");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Фикстура установки: харнесс + agent-dir, привязанный к нему через .harness-root.
 * `agentRoles` — определения ролей, реально положенные в <agent-dir>/agents.
 */
function createInstalledFixture(tmp, { agentRoles = null } = {}) {
  const harness = createMockHarness(tmp);
  const agentDir = join(tmp, "agent-dir");
  const agentsHome = join(tmp, "agents-home");

  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(agentsHome, "skills"), { recursive: true });
  writeFileSync(join(agentDir, ".harness-root"), harness + "\n", "utf8");
  writeFileSync(join(agentDir, "AGENTS.md"), `# AGENTS\nHarness: ${harness}\n`, "utf8");

  for (const role of agentRoles || roleNamesIn(join(harness, "agent", "agents"))) {
    writeFileSync(join(agentDir, "agents", `${role}.md`), "# Role\n", "utf8");
  }

  mkdirSync(join(agentDir, "rules"), { recursive: true });
  writeFileSync(join(agentDir, "rules/enterprise-directives.md"), "# Directives\n", "utf8");
  mkdirSync(join(agentsHome, "rules"), { recursive: true });
  writeFileSync(join(agentsHome, "rules/enterprise-directives.md"), "# Directives\n", "utf8");
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  writeFileSync(join(agentDir, "models.yml"), "models: []\n", "utf8");
  writeFileSync(join(agentDir, "config.yml"), "editor: nano\n", "utf8");

  return { harness, agentDir, agentsHome };
}

/** Каталог «встроенных агентов» для agents-drift: имя файла → содержимое. */
function writeBuiltinAgents(dir, entries) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

/** Прямой вызов runDoctor в режиме repo на моковом харнессе с заданным каталогом встроенных. */
function runDoctorOnMockHarness(tmp, { builtinAgentsDir, runOmp } = {}) {
  return runDoctor({
    harness: join(tmp, "harness"),
    agentDir: join(tmp, "agent-dir"),
    agentsHome: join(tmp, "agents-home"),
    mode: "repo",
    builtinAgentsDir,
    runOmp: runOmp ?? fakeOmp({
      installed: [
        { name: "pi-lens", version: "4.2.1" },
        { name: "oh-my-pi-plugin-morph", version: "0.6.0" },
      ],
    }),
  });
}

test("doctor full pass fixture with mock harness in installed mode", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-installed-"));
  try {
    const { harness, agentDir, agentsHome } = createInstalledFixture(tmp);

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

test("skills check fixture: unrelated human .agents/skills contents stay byte-identical and cannot make minimal doctor require our catalogue", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-skills-human-"));
  try {
    const harness = createMockHarness(tmp);
    const agentsHome = join(tmp, "agents-home");
    const humanSkillDir = join(agentsHome, "skills", "custom-human-skill");
    mkdirSync(humanSkillDir, { recursive: true });
    const humanSkillContent = "---\nname: custom-human-skill\ndescription: Custom user skill\n---\nHuman implementation\n";
    const skillFile = join(humanSkillDir, "SKILL.md");
    writeFileSync(skillFile, humanSkillContent, "utf8");

    const res = spawnSync(
      process.execPath,
      [
        DOCTOR_PATH,
        "--harness", harness,
        "--agent-dir", join(tmp, "agent-dir"),
        "--agents-home", agentsHome,
        "--mode", "installed",
        "--json",
      ],
      { encoding: "utf8" }
    );

    const json = JSON.parse(res.stdout);
    const skillsCheck = json.checks.find((c) => c.id === "skills");
    assert.ok(skillsCheck, "skills check exists");
    assert.equal(skillsCheck.status, "skip");
    assert.match(skillsCheck.detail, /независимый каталог навыков/);
    // Human skill contents remain completely byte-identical
    assert.equal(readFileSync(skillFile, "utf8"), humanSkillContent);
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

test("orphan-files: чистое дерево (харнесс == клон) — PASS", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-clean-"));
  try {
    const harness = createMockHarness(tmp);
    const clone = addRepoClone(harness);

    const { status, json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /присутствуют в репозитории/);
    assert.equal(json.summary.fail, 0);
    assert.equal(status, 0);
    assert.equal(discoverRepoClone(harness), clone);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("orphan-files: лишний файл в tools/ — FAIL (инструмент вне дистрибутива)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-tools-"));
  try {
    const harness = createMockHarness(tmp);
    addRepoClone(harness, ["tools/local-hack.mjs"]);

    const { status, json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /tools\/ \(1\): tools\/local-hack\.mjs/);
    assert.equal(json.ok, false);
    assert.equal(status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("orphan-files: лишний файл вне tools/ — WARN, exit 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-agent-"));
  try {
    const harness = createMockHarness(tmp);
    addRepoClone(harness, ["agent/local-note.md", "rules/scratch.md"]);

    const { status, json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(check.status, "warn");
    assert.match(check.detail, /прочие \(2\)/);
    assert.match(check.detail, /agent\/local-note\.md/);
    assert.match(check.detail, /rules\/scratch\.md/);
    assert.equal(json.summary.fail, 0);
    assert.equal(status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("orphan-files: конфиги и сессионные каталоги не считаются сиротами", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-configs-"));
  try {
    const harness = createMockHarness(tmp);
    addRepoClone(harness, [
      "agent/config.yml",
      "agent/models.yml",
      "agent/mcp.json",
      "agent/models.db",
      "agent/sessions/live.jsonl",
      "agent/.workflow/state.json",
      "tools/node_modules/pkg/index.js",
    ]);

    const { json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(check.status, "pass", check.detail);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("orphan-files: харнесс является репозиторием или клон не обнаружен — SKIP", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-skip-"));
  try {
    const harness = createMockHarness(tmp);
    const { json: noCloneJson } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    assert.equal(discoverRepoClone(harness), null);
    assert.equal(checkOf(noCloneJson, "orphan-files").status, "skip");
    assert.match(checkOf(noCloneJson, "orphan-files").detail, /Клон репозитория не обнаружен/);

    writeFileSync(join(harness, "install.ps1"), "# repo marker\n", "utf8");
    writeFileSync(join(harness, "agent/models.yml.example"), "providers: {}\n", "utf8");
    const { json: repoJson } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    assert.equal(isRepoTree(harness), true);
    assert.equal(checkOf(repoJson, "orphan-files").status, "skip");
    assert.match(checkOf(repoJson, "orphan-files").detail, /является дистрибутивным репозиторием/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("parseRoleModels: modelRoles и task.agentModelOverrides, комментарии и кавычки", () => {
  const config = [
    "# comment",
    "providers:",
    "  streamIdleTimeoutSeconds: 180",
    "modelRoles:",
    "  default: openai-codex/gpt-6-astra:high",
    '  oracle: "opencode-go/deepseek-v4.1-flash" # chosen',
    "task:",
    "  agentModelOverrides:",
    "    fixer: opencode-go/deepseek-v4.1-flash",
    "    critic: my-provider/gpt-4o",
    "commands:",
    "  enableOpencodeUser: false",
  ].join("\n");

  assert.deepEqual(parseRoleModels(config), [
    { role: "default", section: "modelRoles", model: "openai-codex/gpt-6-astra:high" },
    { role: "oracle", section: "modelRoles", model: "opencode-go/deepseek-v4.1-flash" },
    { role: "fixer", section: "agentModelOverrides", model: "opencode-go/deepseek-v4.1-flash" },
    { role: "critic", section: "agentModelOverrides", model: "my-provider/gpt-4o" },
  ]);
  assert.deepEqual(parseRoleModels(""), []);
  assert.deepEqual(parseRoleModels("# только комментарий\n"), []);
});

test("probeProviders: живой /models → reachable, мёртвый порт → unreachable, без baseUrl → null", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-probe-unit-"));
  try {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-c" }] }));
      },
      async (port) => {
        const modelsPath = join(tmp, "models.yml");
        writeFileSync(
          modelsPath,
          [
            "providers:",
            "  live-provider:",
            `    baseUrl: http://127.0.0.1:${port}/v1`,
            "    models:",
            "      - id: model-b",
            "  dead-provider:",
            "    baseUrl: http://127.0.0.1:1/v1",
            "    models:",
            "      - id: model-a",
            "  headless-provider:",
            "    models:",
            "      - id: model-z",
          ].join("\n") + "\n",
          "utf8"
        );

        const { providers, notes } = await probeProviders(modelsPath);

        assert.equal(providers["live-provider"].reachable, true);
        assert.equal(providers["dead-provider"].reachable, false);
        assert.ok(providers["dead-provider"].error, "dead provider must carry an error");
        assert.equal(providers["headless-provider"].reachable, null);
        assert.equal(providers["headless-provider"].error, "baseUrl не задан");
        assert.equal(notes.length, 1);
        assert.match(notes[0], /dead-provider недостижим/);
      }
    );

    const missing = await probeProviders(join(tmp, "nope.yml"));
    assert.deepEqual(missing.providers, {});
    assert.match(missing.notes[0], /models.yml не найден/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("provider-reachability: без --probe проверки нет вовсе (поведение прежнее)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-reach-off-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.yml"), modelsYamlFixture(), "utf8");
    writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  oracle: dead-provider/model-a\n", "utf8");

    const { json } = runDoctorCli(["--harness", harness, "--agent-dir", agentDir]);

    assert.equal(checkOf(json, "provider-reachability"), undefined, "no probe -> no check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("provider-reachability: недостижимый провайдер → WARN со списком ролей (не FAIL)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-reach-warn-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    mkdirSync(agentDir, { recursive: true });

    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-b" }] }));
      },
      async (port) => {
        writeFileSync(join(agentDir, "models.yml"), modelsYamlFixture({ livePort: port }), "utf8");
        writeFileSync(
          join(agentDir, "config.yml"),
          [
            "modelRoles:",
            "  oracle: dead-provider/model-a",
            "  task: live-provider/model-b",
            "task:",
            "  agentModelOverrides:",
            "    fixer: dead-provider/model-a",
          ].join("\n") + "\n",
          "utf8"
        );

        const { status, json, stdout } = await runDoctorCliAsync([
          "--harness",
          harness,
          "--agent-dir",
          agentDir,
          "--probe",
        ]);
        const check = checkOf(json, "provider-reachability");

        assert.equal(check.status, "warn");
        assert.match(check.detail, /Недостижимые провайдеры: dead-provider/);
        assert.match(check.detail, /oracle \[dead-provider\/model-a\]/);
        assert.match(check.detail, /fixer \[dead-provider\/model-a\]/);
        assert.ok(!check.detail.includes("task ["), "role on a live provider must not be flagged");
        assert.equal(json.summary.fail, 0, "offline machine must never FAIL");
        assert.equal(status, 0);
        assert.ok(!stdout.includes("sk-fixture-secret-key"), "apiKey must never reach the report");
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("provider-reachability: все провайдеры отвечают → PASS, роли вне models.yml перечислены", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-reach-pass-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    mkdirSync(agentDir, { recursive: true });

    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-b" }] }));
      },
      async (port) => {
        writeFileSync(
          join(agentDir, "models.yml"),
          [
            "providers:",
            "  live-provider:",
            `    baseUrl: http://127.0.0.1:${port}/v1`,
            "    models:",
            "      - id: model-b",
          ].join("\n") + "\n",
          "utf8"
        );
        writeFileSync(
          join(agentDir, "config.yml"),
          ["modelRoles:", "  oracle: live-provider/model-b", "  designer: external-gateway/some-model"].join("\n") + "\n",
          "utf8"
        );

        const { json } = await runDoctorCliAsync(["--harness", harness, "--agent-dir", agentDir, "--probe"]);
        const check = checkOf(json, "provider-reachability");

        assert.equal(check.status, "pass");
        assert.match(check.detail, /Провайдеры отвечают \(live-provider\)/);
        assert.match(check.detail, /роли вне models\.yml не проверялись: external-gateway \(designer\)/);
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("provider-reachability: config.yml отсутствует → SKIP (не FAIL)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-reach-noconfig-"));
  try {
    const harness = createMockHarness(tmp);
    const agentDir = join(tmp, "agent-dir");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.yml"), modelsYamlFixture(), "utf8");

    const { json } = runDoctorCli(["--harness", harness, "--agent-dir", agentDir, "--probe"]);
    const check = checkOf(json, "provider-reachability");
    assert.equal(check.status, "skip");
    assert.match(check.detail, /config\.yml не найден/);

    const direct = runDoctor({
      harness, agentDir, agentsHome: join(tmp, "agents-home"), mode: "repo",
      probeResults: { providers: { dead: { reachable: false, error: "fetch failed" } }, notes: [] },
    });
    assert.equal(checkOf(direct, "provider-reachability").status, "skip");
    assert.equal(direct.summary.fail, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("compareAgentDefs: форк, дрейф и совпадение разложены по корзинам (BOM и CRLF не различия)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-defs-"));
  try {
    const ours = writeBuiltinAgents(join(tmp, "ours"), {
      "alpha.md": "# Role\nSame body\n",
      "beta.md": "# Role\nOurs body\n",
      "delta.md": "\uFEFF# Role\r\nSame body\r\n",
      "gamma.md": "# Role\nOnly ours\n",
      "notes.txt": "не определение роли\n",
    });
    const builtin = writeBuiltinAgents(join(tmp, "builtin"), {
      "alpha.md": "# Role\nSame body\n",
      "beta.md": "# Role\nBuiltin body\n",
      "delta.md": "# Role\nSame body\n",
    });

    assert.deepEqual(compareAgentDefs(ours, builtin), {
      forks: ["gamma.md"],
      drift: ["beta.md"],
      matched: ["alpha.md", "delta.md"],
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("roleNamesIn/missingRequiredRoles: sonic опционален, отсутствующие роли называются поимённо", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-role-names-"));
  try {
    const dir = writeBuiltinAgents(join(tmp, "agents"), {
      "orchestrator.md": "# Role\n",
      "fixer.md": "# Role\n",
      "AGENTS.txt": "не роль\n",
    });

    assert.deepEqual(roleNamesIn(dir), ["fixer", "orchestrator"]);
    assert.deepEqual(roleNamesIn(join(tmp, "нет-такого-каталога")), []);

    const full = REQUIRED_ROLES.concat("sonic");
    assert.deepEqual(missingRequiredRoles(full), [], "sonic не обязателен: набор ролей полон");
    assert.deepEqual(
      missingRequiredRoles(full.filter((r) => r !== "orchestrator" && r !== "reviewer")),
      ["orchestrator", "reviewer"]
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("harness-files: отсутствует обязательная роль → FAIL с точным именем файла", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-fail-role-"));
  try {
    const harness = createMockHarness(tmp, { omitFiles: ["agent/agents/oracle.md"] });
    const { status, json } = runDoctorCli(["--harness", harness]);

    assert.equal(status, 1, "пропавшая обязательная роль должна валить doctor");
    const check = checkOf(json, "harness-files");
    assert.equal(check.status, "fail");
    assert.ok(
      check.detail.includes("agent/agents/oracle.md"),
      `Ожидался точный путь роли в detail: ${check.detail}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent-wiring: несовпадающий .harness-root → FAIL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-wiring-mismatch-"));
  try {
    const { harness, agentDir, agentsHome } = createInstalledFixture(tmp);
    writeFileSync(join(agentDir, ".harness-root"), "/different/harness/path\n", "utf8");

    const { json } = runDoctorCli([
      "--harness", harness,
      "--agent-dir", agentDir,
      "--agents-home", agentsHome,
      "--mode", "installed",
    ]);
    const check = checkOf(json, "agent-wiring");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /\.harness-root/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("agents-drift: лишние файлы без встроенного аналога → форки, PASS (не FAIL)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-drift-forks-"));
  try {
    createMockHarness(tmp);
    const builtin = join(tmp, "builtin-agents");
    mkdirSync(builtin, { recursive: true });
    copyFileSync(join(tmp, "harness/agent/agents/reviewer.md"), join(builtin, "reviewer.md"));

    const result = runDoctorOnMockHarness(tmp, { builtinAgentsDir: builtin });
    const check = checkOf(result, "agents-drift");

    assert.equal(check.status, "pass");
    assert.match(check.detail, /форков: 7/);
    assert.match(check.detail, /designer\.md/);
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("agents-drift: расхождение содержимого → WARN с именами, exit 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-drift-warn-"));
  try {
    createMockHarness(tmp);
    const builtin = writeBuiltinAgents(join(tmp, "builtin-agents"), {
      "orchestrator.md": "# Builtin orchestrator\n",
      "sonic.md": "# Builtin sonic\n",
    });

    const result = runDoctorOnMockHarness(tmp, { builtinAgentsDir: builtin });
    const check = checkOf(result, "agents-drift");

    assert.equal(check.status, "warn");
    assert.match(check.detail, /Дрейф от встроенных агентов OMP \(2\): orchestrator\.md, sonic\.md/);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.ok, true, "дрейф — WARN, он не валит doctor");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("agents-drift: каталог встроенных агентов недоступен → SKIP с причиной", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-drift-skip-"));
  try {
    createMockHarness(tmp);
    const builtin = join(tmp, "нет-встроенных");

    const result = runDoctorOnMockHarness(tmp, { builtinAgentsDir: builtin });
    const check = checkOf(result, "agents-drift");

    assert.equal(check.status, "skip");
    assert.match(check.detail, /каталог встроенных агентов не найден/);
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("agents-drift: реальный репозиторий — проверка присутствует, никогда не FAIL", () => {
  const { status, json } = runDoctorCli(["--harness", REPO_ROOT]);
  const check = checkOf(json, "agents-drift");

  assert.ok(check, "agents-drift должен присутствовать в отчёте");
  assert.ok(["pass", "warn", "skip"].includes(check.status), `Статус ${check.status} недопустим`);
  assert.notEqual(check.status, "fail", "agents-drift никогда не должен быть FAIL");
  const expectedExit = json.summary.fail > 0 ? 1 : 0;
  assert.equal(status, expectedExit, `Exit code must match summary.fail: expected ${expectedExit}, got ${status}`);
});

/** Манифест плагинов харнесса (`agent/plugins.json`) для фикстур. */
function writePluginsManifest(harness, plugins) {
  writeFileSync(join(harness, "agent", "plugins.json"), JSON.stringify({ version: 1, plugins }, null, 2) + "\n", "utf8");
}

/**
 * Подставной `omp` вместо реального CLI: тесты не зависят от того, что
 * установлено на машине, и не ходят в сеть.
 */
function fakeOmp({ installed = [], listStdout = null, listStatus = 0, listStderr = "", doctorStatus = 0, doctorStderr = "", error = null } = {}) {
  return (args) => {
    if (args[1] === "list") {
      if (error) return { status: null, stdout: "", stderr: "", error };
      const stdout = listStdout ?? JSON.stringify({
        npm: installed.map((item) => {
          if (typeof item === "object" && item !== null) {
            return {
              name: item.name,
              version: "version" in item ? item.version : null,
              enabled: true,
            };
          }
          if (typeof item === "string") {
            const lastAt = item.lastIndexOf("@");
            if (lastAt > 0) {
              return { name: item.slice(0, lastAt), version: item.slice(lastAt + 1), enabled: true };
            }
            return { name: item, version: "1.0.0", enabled: true };
          }
          return item;
        }),
      });
      return { status: listStatus, stdout, stderr: listStderr, error: null };
    }
    return { status: doctorStatus, stdout: "", stderr: doctorStderr, error: null };
  };
}

/** runDoctor на моковом харнессе с подставным `omp` (встроенных агентов не распаковываем). */
function runDoctorWithOmp(tmp, { runOmp, requirePlugins = false, skipPluginCheck = false } = {}) {
  return runDoctor({
    harness: join(tmp, "harness"),
    agentDir: join(tmp, "agent-dir"),
    agentsHome: join(tmp, "agents-home"),
    mode: "repo",
    builtinAgentsDir: join(tmp, "нет-встроенных"),
    runOmp,
    requirePlugins,
    skipPluginCheck,
  });
}


test("plugins: default runOmp invocation count is 0 on fresh minimal install; explicit opt-in detects missing plugin", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-minimal-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);
    let ompCalls = 0;
    const trackingOmp = () => {
      ompCalls++;
      return { status: 0, stdout: JSON.stringify({ npm: [] }), stderr: "", error: null };
    };

    // 1. Default (no requirePlugins): runOmp is NEVER invoked, check is SKIP
    const defaultRes = runDoctorWithOmp(tmp, { runOmp: trackingOmp, requirePlugins: false });
    assert.equal(ompCalls, 0, "default doctor must not invoke runOmp");
    assert.equal(checkOf(defaultRes, "plugins").status, "skip");

    // 2. Explicit opt-in (--require-plugins): runOmp IS invoked and detects missing plugin
    const optInRes = runDoctorWithOmp(tmp, { runOmp: trackingOmp, requirePlugins: true });
    assert.ok(ompCalls > 0, "explicit opt-in must invoke runOmp");
    assert.equal(checkOf(optInRes, "plugins").status, "fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: --require-plugins превращает недостающие опциональные плагины в FAIL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-require-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-qq", spec: "pi-qq@0.1.17" },
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: ["pi-lens"] }), requirePlugins: true });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /pi-qq/);
    assert.equal(result.requirePlugins, true);
    assert.equal(result.summary.fail, 1);
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: без манифеста проверка дает FAIL (fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-nomanifest-"));
  try {
    const harness = createMockHarness(tmp);
    rmSync(join(harness, "agent", "plugins.json"), { force: true });
    let calls = 0;
    const result = runDoctorWithOmp(tmp, {
      requirePlugins: true,
      runOmp: () => {
        calls++;
        return { status: 0, stdout: '{"npm":[]}', stderr: "", error: null };
      },
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /Манифест плагинов отсутствует/);
    assert.equal(calls, 0, "без манифеста omp не вызывается");
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: --skip-plugin-check и маркер agent/plugins.skipped пропускают проверку плагинов (SKIP)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-skip-"));
  try {
    const harness = createMockHarness(tmp);
    rmSync(join(harness, "agent", "plugins.json"), { force: true });
    const byFlag = runDoctorWithOmp(tmp, {
      skipPluginCheck: true,
      runOmp: () => ({ status: 127, stdout: "", stderr: "omp not found", error: null }),
    });
    assert.equal(checkOf(byFlag, "plugins").status, "skip");
    assert.match(checkOf(byFlag, "plugins").detail, /Проверка плагинов пропущена/);
    assert.equal(byFlag.ok, true);

    writePluginsManifest(harness, [{ name: "pi-lens", spec: "pi-lens@4.2.1", required: true }]);
    writeFileSync(join(harness, "agent", "plugins.skipped"), "plugins skipped during install (-SkipPlugins)\n", "utf8");
    const byMarker = runDoctorWithOmp(tmp, {
      runOmp: () => ({ status: 127, stdout: "", stderr: "omp not found", error: null }),
    });
    assert.equal(checkOf(byMarker, "plugins").status, "skip");
    assert.match(checkOf(byMarker, "plugins").detail, /плагины пропущены при установке \(-SkipPlugins\)/);
    assert.equal(byMarker.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("plugins: всё установлено, лишние перечислены как info (PASS)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-extra-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [{ name: "pi-qq", spec: "pi-qq@0.1.17", required: false }]);

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: ["pi-qq@0.1.17", "pi-extra"] }), requirePlugins: true });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "pass");
    assert.match(check.detail, /1\/1 плагинов установлено/);
    assert.match(check.detail, /Установлены сверх манифеста \(1\): pi-extra/);
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: omp недоступен или вывод не разобран → FAIL (fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-noomp-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [{ name: "pi-lens", spec: "pi-lens@4.2.1", required: true }]);

    const enoent = Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" });
    const absent = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ error: enoent }), requirePlugins: true });
    const absentCheck = checkOf(absent, "plugins");
    assert.equal(absentCheck.status, "fail", "отсутствие omp дает FAIL (fail-closed)");
    assert.match(absentCheck.detail, /(?:omp не запущен|omp не найден в PATH)/);
    assert.equal(absent.ok, false);

    const garbage = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ listStdout: "not json at all" }), requirePlugins: true });
    const garbageCheck = checkOf(garbage, "plugins");
    assert.equal(garbageCheck.status, "fail");
    assert.match(garbageCheck.detail, /вывод omp plugin list не разобран/);
    assert.equal(garbage.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("doctor CLI: absent omp on PATH fails closed for required plugins", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-cli-noomp-"));
  try {
    const harness = createMockHarness(tmp);
    const nodeDir = dirname(process.execPath);
    const isolatedEnv = {
      ...process.env,
      PATH: process.platform === "win32"
        ? `${nodeDir};${process.env.SystemRoot || "C:\\Windows"}\\System32`
        : `${nodeDir}:/bin:/usr/bin`,
    };
    const res = spawnSync(
      process.execPath,
      [DOCTOR_PATH, "--harness", harness, "--require-plugins", "--json"],
      { encoding: "utf8", env: isolatedEnv }
    );
    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, false);
    assert.equal(res.status, 1);
    const check = checkOf(json, "plugins");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /(?:omp не запущен|omp не найден в PATH)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("plugins: манифест с синтаксической ошибкой → FAIL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-bad-"));
  try {
    const harness = createMockHarness(tmp);
    writeFileSync(join(harness, "agent", "plugins.json"), "{ invalid json", "utf8");

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: [] }), requirePlugins: true });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /Манифест плагинов не прочитан/);
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: ненулевой код omp plugin doctor → WARN с хвостом вывода", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-health-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [{ name: "pi-qq", spec: "pi-qq@0.1.17" }]);

    const result = runDoctorWithOmp(tmp, {
      requirePlugins: true,
      runOmp: fakeOmp({ installed: ["pi-qq@0.1.17"], doctorStatus: 1, doctorStderr: "boom: broken plugin\nsecond line" }),
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "warn");
    assert.match(check.detail, /1\/1 плагинов установлено/);
    assert.match(check.detail, /omp plugin doctor завершился с кодом 1: boom: broken plugin second line/);
    assert.equal(result.ok, true, "health-чек плагинов не валит doctor");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: несоответствие или отсутствие версии обязательного плагина → FAIL (ok: false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-req-ver-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [{ name: "pi-lens", spec: "pi-lens@4.2.1", required: true }]);

    const mismatch = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: [{ name: "pi-lens", version: "4.2.0" }] }), requirePlugins: true });
    assert.equal(checkOf(mismatch, "plugins").status, "fail");
    assert.match(checkOf(mismatch, "plugins").detail, /4\.2\.0 != 4\.2\.1/);
    assert.equal(mismatch.ok, false);

    const noVer = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: [{ name: "pi-lens", version: null }] }), requirePlugins: true });
    assert.equal(checkOf(noVer, "plugins").status, "fail");
    assert.match(checkOf(noVer, "plugins").detail, /Несоответствие версии обязательных плагинов/);
    assert.equal(noVer.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("plugins: --require-plugins виден в CLI и в JSON-отчёте", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-cli-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, []);
    const { status, json } = runDoctorCli(["--harness", harness, "--require-plugins"]);

    assert.equal(json.requirePlugins, true);
    assert.equal(checkOf(json, "plugins").status, "pass");
    assert.equal(json.summary.fail, 0);
    assert.equal(status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("plugins: валидный JSON при ненулевом коде omp plugin list → PASS (регрессия OMP 18.3.3+)", () => {
  // OMP 18.3.3+ печатает ПОЛНЫЙ документ и затем выходит с кодом 1: хук beforeExit
  // срабатывает, пока команда ещё не завершилась ("the event loop drained while it
  // was still pending"). Код возврата врёт, данные корректны — иначе doctor валит
  // установку на любой машине с таким OMP.
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-exit1-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);

    const result = runDoctorWithOmp(tmp, {
      requirePlugins: true,
      runOmp: fakeOmp({
        installed: [{ name: "pi-lens", version: "4.2.1" }],
        listStatus: 1,
        listStderr: "omp: `omp plugin` ended before completing: the event loop drained while it was still pending",
      }),
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "pass", check.detail);
    assert.match(check.detail, /1\/1 плагинов установлено/);
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: неразбираемый вывод при ненулевом коде остаётся FAIL", () => {
  // Терпимость к коду возврата не должна маскировать настоящую поломку: без
  // валидного списка плагинов проверка честно падает.
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-junk-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);

    const result = runDoctorWithOmp(tmp, {
      requirePlugins: true,
      runOmp: fakeOmp({ listStdout: "not json at all", listStatus: 1 }),
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /завершился с кодом 1/);
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugin-patches: снятый патч pi-lens → WARN (иначе краш хоста не виден)", () => {
  // Патчи живут в node_modules и теряются при обновлении плагина. Проверка только
  // наличия файла-патчера это не ловит: харнесс рапортует «здоров», а непатченный
  // pi-lens валит хост Unhandled Rejection'ом.
  const tmp = mkdtempSync(join(tmpdir(), "doctor-patch-"));
  try {
    const harness = createMockHarness(tmp);
    const agentsHome = join(tmp, ".agents");
    const piLensDir = join(tmp, ".omp", "plugins", "node_modules", "pi-lens", "dist");
    mkdirSync(agentsHome, { recursive: true });
    mkdirSync(piLensDir, { recursive: true });
    // Ванильный vscode-jsonrpc: ERR_STREAM_DESTROYED присутствует, маркера патча нет —
    // именно этот случай раньше ошибочно считался пропатченным.
    const vanilla = 'throw new Error("Cannot call write after a stream was destroyed") // ERR_STREAM_DESTROYED\n';
    writeFileSync(join(piLensDir, "index.js"), vanilla, "utf8");

    const unpatched = runDoctor({ harness, agentDir: join(tmp, "agent-dir"), agentsHome, mode: "repo" });
    const warn = checkOf(unpatched, "plugin-patches");
    assert.equal(warn.status, "warn", "ванильный pi-lens не должен считаться пропатченным");
    assert.match(warn.detail, /БЕЗ патча/);

    // Маркер патча → PASS.
    writeFileSync(
      join(piLensDir, "index.js"),
      '/* patched-epipe-handler */ return new Promise((r) => r());\n',
      "utf8"
    );
    const patched = runDoctor({ harness, agentDir: join(tmp, "agent-dir"), agentsHome, mode: "repo" });
    assert.equal(checkOf(patched, "plugin-patches").status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor with targetHarness: opencode accepts JSONC and opencode.jsonc, rejects invalid JSON5, omits OMP checks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-opencode-"));
  try {
    const harness = createMockHarness(tmp);
    writeFileSync(join(harness, "AGENTS.md"), "<!-- BEGIN NULLFORM WORKFLOW -->\n# OpenCode NULLFORM WORKFLOW\n<!-- END NULLFORM WORKFLOW -->\n", "utf8");
    writeFileSync(join(harness, "opencode.jsonc"), [
      "{",
      "  // Valid OpenCode JSONC with comments and trailing comma",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "model": "anthropic/claude-sonnet-4",',
      "}",
    ].join("\n"), "utf8");

    const result = runDoctor({
      harness, targetHarness: "opencode", userHome: tmp,
      agentDir: join(tmp, "agent-dir"), agentsHome: join(tmp, "agents-home"),
    });
    assert.equal(result.targetHarness, "opencode");
    for (const ompId of ["plugins", "agent-wiring", "plugin-patches", "agents-drift", "logs-hygiene", "configs"]) {
      assert.equal(checkOf(result, ompId), undefined, `OMP check ${ompId} must be omitted for opencode`);
    }
    assert.equal(checkOf(result, "harness-integration").status, "pass");
    assert.ok(["pass", "warn"].includes(checkOf(result, "host-runtime").status));

    const canary = "sk-secret-never-leak-999";
    writeFileSync(join(harness, "opencode.jsonc"), `{ unquotedKey: "${canary}" }`, "utf8");
    const badRes = runDoctor({
      harness, targetHarness: "opencode", userHome: tmp,
      agentDir: join(tmp, "agent-dir"), agentsHome: join(tmp, "agents-home"),
    });
    const badCheck = checkOf(badRes, "harness-integration");
    assert.equal(badCheck.status, "fail", "Invalid JSON5 unquoted key must fail JSONC check");
    assert.equal(badCheck.detail.includes(canary), false, "Secret canary must not leak in error detail");
    assert.equal(badRes.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("doctor with targetHarness: cursor projectRoot, openclaw JSON5, release-drift, and explicit omp SETUP", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-multi-target-"));
  try {
    const { harness, agentDir, agentsHome } = createInstalledFixture(tmp);
    writeFileSync(join(harness, "VERSION"), "1.0.0\n", "utf8");

    const projectRoot = join(tmp, "cursor-project");
    const mdcPath = join(projectRoot, ".cursor", "rules", "00-workflow.mdc");
    mkdirSync(dirname(mdcPath), { recursive: true });
    writeFileSync(mdcPath, "---\nalwaysApply: true\n---\n\n<!-- BEGIN NULLFORM WORKFLOW -->\n# Cursor\n<!-- END NULLFORM WORKFLOW -->\n", "utf8");

    const cursorRes = runDoctor({
      harness, targetHarness: "cursor", projectRoot, userHome: tmp, agentDir, agentsHome,
      releaseInfo: { status: "drift", current: "1.0.0", latest: "1.1.0" },
    });
    assert.equal(checkOf(cursorRes, "harness-integration").status, "pass");
    assert.equal(checkOf(cursorRes, "release-drift").status, "warn");
    assert.match(checkOf(cursorRes, "release-drift").detail, /nullform update/i);

    writeFileSync(join(harness, "openclaw.json"), `// JSON5\n{\n  agents: { entries: { workflow: { workspace: "${tmp.replace(/\\/g, "/")}" } } }\n}\n`, "utf8");
    writeFileSync(join(harness, "AGENTS.md"), "<!-- BEGIN NULLFORM WORKFLOW -->\n# OpenClaw\n<!-- END NULLFORM WORKFLOW -->\n", "utf8");
    const clawRes = runDoctor({ harness, targetHarness: "openclaw", userHome: tmp, agentDir, agentsHome });
    assert.equal(checkOf(clawRes, "harness-integration").status, "pass");

    rmSync(join(agentDir, "models.yml"), { force: true });
    const ompExplicit = runDoctor({
      harness, targetHarness: "omp", userHome: tmp, agentDir, agentsHome,
      builtinAgentsDir: join(tmp, "no-builtin"),
      runOmp: fakeOmp({ installed: [] }),
    });
    assert.equal(ompExplicit.ok, true, "Explicit targetHarness omp treats missing models as SETUP warn, plugins skipped without requirePlugins");
    assert.equal(checkOf(ompExplicit, "plugins").status, "skip");
    assert.equal(checkOf(ompExplicit, "configs").status, "warn");
    assert.match(checkOf(ompExplicit, "configs").detail, /\[SETUP\]/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Under Bun, `process.execPath` IS Bun and `bun --check <file>` executes the file.
// The tools-syntax check must run a real Node for `--check` instead, or fail closed.
test("doctor tools-syntax never executes tools under a Bun caller", (t) => {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) return t.skip("bun not in PATH");

  const tmp = mkdtempSync(join(tmpdir(), "doctor-bun-syntax-"));
  try {
    const sentinel = join(tmp, "executed.txt");
    const harness = createMockHarness(tmp);
    // A syntactically valid tool that writes a sentinel only if it is executed, not parsed.
    writeFileSync(
      join(harness, "tools", "zz-sentinel.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed");\n`,
      "utf8"
    );

    const res = spawnSync("bun", [DOCTOR_PATH, "--harness", harness, "--json"], { encoding: "utf8", windowsHide: true });
    assert.equal(existsSync(sentinel), false, "bun --check must never execute a tool");
    const json = JSON.parse(res.stdout);
    assert.equal(checkOf(json, "tools-syntax").status, "pass", checkOf(json, "tools-syntax").detail);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("F01 (9): синтаксическая проверка doctorLite покрывает ВСЕ файлы, а не урезается таймаутом", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-lite-coverage-"));
  try {
    const toolsDir = join(tmp, "tools");
    mkdirSync(toolsDir, { recursive: true });
    // Many files: the old per-file timeout skipped the tail once the budget ran out,
    // hiding broken files behind a warn. Coverage must be complete now.
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(toolsDir, `tool-${String(i).padStart(2, "0")}.mjs`), `export const v${i} = ${i};\n`, "utf8");
    }
    // A genuinely broken file at the END of the ordering must still be reported.
    writeFileSync(join(toolsDir, "zz-broken.mjs"), "export const = ;\n", "utf8");

    const res = doctorLite(tmp);
    assert.equal(res.ok, false, "a broken tool file must fail the probe");
    assert.ok(
      res.warns.some((w) => w.includes("zz-broken.mjs")),
      `the last file must be checked, not skipped: ${JSON.stringify(res.warns)}`,
    );
    assert.ok(
      !res.warns.some((w) => w.includes("пропущены файлы")),
      "no file may be skipped by a time budget",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("F01 (10): checkConfigs возвращает skip, а не pass, когда в agent-dir ноль конфигураций", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-zero-configs-"));
  try {
    const checks = [];
    checkConfigs({ checks, agentDir: tmp, options: {} });
    const cfgCheck = checks.find(c => c.id === "configs");
    assert.ok(cfgCheck, "checkConfigs должен добавить проверку с id configs");
    assert.equal(cfgCheck.status, "skip", "при 0 конфигураций статус должен быть skip, а не pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
