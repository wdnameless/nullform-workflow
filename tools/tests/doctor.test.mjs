import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  CORE_TOOLS,
  REQUIRED_ROLES,
  runDoctor,
  parseCliArgs,
  parseRoleModels,
  probeProviders,
  discoverRepoClone,
  isRepoTree,
  compareAgentDefs,
  roleNamesIn,
  missingRequiredRoles,
} from "../doctor.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const DOCTOR_PATH = resolve(REPO_ROOT, "tools/doctor.mjs");

/** Каталоги, покрытые манифестом sync.ps1 (та же область, что у orphan-files). */
const MANIFEST_DIRS = ["tools", "agent", "rules", "core", "templates", "paseo"];

/** Запускает doctor как CLI и возвращает {status, json}. */
function runDoctorCli(args) {
  const res = spawnSync(process.execPath, [DOCTOR_PATH, ...args, "--json"], { encoding: "utf8" });
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
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [DOCTOR_PATH, ...args, "--json"]);
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
function runDoctorOnMockHarness(tmp, { builtinAgentsDir } = {}) {
  return runDoctor({
    harness: join(tmp, "harness"),
    agentDir: join(tmp, "agent-dir"),
    agentsHome: join(tmp, "agents-home"),
    mode: "repo",
    builtinAgentsDir,
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

test("orphan-files: харнесс сам является репозиторием — SKIP", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-isrepo-"));
  try {
    const harness = createMockHarness(tmp);
    writeFileSync(join(harness, "install.ps1"), "# repo marker\n", "utf8");
    writeFileSync(join(harness, "agent/models.yml.example"), "providers: {}\n", "utf8");

    const { json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(isRepoTree(harness), true);
    assert.equal(check.status, "skip");
    assert.match(check.detail, /является дистрибутивным репозиторием/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("orphan-files: клон репозитория не обнаружен — SKIP", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-orphan-noclone-"));
  try {
    const harness = createMockHarness(tmp);

    const { json } = runDoctorCli(["--harness", harness, "--agent-dir", join(tmp, "agent-dir")]);
    const check = checkOf(json, "orphan-files");

    assert.equal(discoverRepoClone(harness), null);
    assert.equal(check.status, "skip");
    assert.match(check.detail, /Клон репозитория не обнаружен/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseCliArgs: --probe включает сетевую проверку, по умолчанию выключена", () => {
  assert.equal(parseCliArgs(["--harness", "/tmp/h"]).probe, false);
  assert.equal(parseCliArgs(["--harness", "/tmp/h", "--probe"]).probe, true);
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

test("provider-reachability: config.yml отсутствует → SKIP", () => {
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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor: probeResults без config.yml не превращается в FAIL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-reach-direct-"));
  try {
    const harness = createMockHarness(tmp);
    const result = runDoctor({
      harness,
      agentDir: join(tmp, "agent-dir"),
      agentsHome: join(tmp, "agents-home"),
      mode: "repo",
      probeResults: { providers: { dead: { reachable: false, error: "fetch failed" } }, notes: [] },
    });

    const check = result.checks.find((c) => c.id === "provider-reachability");
    assert.equal(check.status, "skip");
    assert.equal(result.summary.fail, 0);
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

test("agent-wiring: установка без обязательной роли → FAIL (счёт «>= 8» её пропускал)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-test-wiring-role-"));
  try {
    const { harness, agentDir, agentsHome } = createInstalledFixture(tmp, {
      agentRoles: REQUIRED_ROLES.filter((r) => r !== "fixer").concat("sonic"),
    });

    const { json } = runDoctorCli([
      "--harness", harness,
      "--agent-dir", agentDir,
      "--agents-home", agentsHome,
    ]);

    const check = checkOf(json, "agent-wiring");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /отсутствуют обязательные роли \(fixer\)/);
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
  assert.equal(json.summary.fail, 0);
  assert.equal(status, 0);
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
            return { name: item.name, version: item.version ?? "1.0.0", enabled: true };
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
function runDoctorWithOmp(tmp, { runOmp, requirePlugins = false } = {}) {
  return runDoctor({
    harness: join(tmp, "harness"),
    agentDir: join(tmp, "agent-dir"),
    agentsHome: join(tmp, "agents-home"),
    mode: "repo",
    builtinAgentsDir: join(tmp, "нет-встроенных"),
    runOmp,
    requirePlugins,
  });
}

test("parseCliArgs: --require-plugins по умолчанию выключен", () => {
  assert.equal(parseCliArgs(["--harness", "/tmp/h"]).requirePlugins, false);
  assert.equal(parseCliArgs(["--harness", "/tmp/h", "--require-plugins"]).requirePlugins, true);
});

test("plugins: только опциональные плагины отсутствуют → WARN с именами и командой установки (ok: true)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-missing-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-qq", spec: "pi-qq@0.1.17" },
      { name: "pi-prompt-shelf", spec: "pi-prompt-shelf@1.1.2" },
    ]);

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: [] }) });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "warn");
    assert.match(check.detail, /Не установлены опциональные плагины \(2 из 2\): pi-qq, pi-prompt-shelf/);
    assert.match(check.detail, /omp plugin install pi-qq@0\.1\.17/);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.ok, true, "без обязательных плагинов отсутствие опциональных не валит doctor");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: обязательный плагин отсутствует → FAIL по умолчанию (ok: false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-req-fail-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-qq", spec: "pi-qq@0.1.17" },
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: ["pi-qq"] }) });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /Не установлены обязательные плагины \(1\): pi-lens/);
    assert.equal(result.summary.fail, 1);
    assert.equal(result.ok, false, "отсутствие обязательного плагина дает FAIL по умолчанию");
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
    createMockHarness(tmp);
    let calls = 0;
    const result = runDoctorWithOmp(tmp, {
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

test("plugins: всё установлено, лишние перечислены как info (PASS)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-extra-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [{ name: "pi-qq", spec: "pi-qq@0.1.17", required: false }]);

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: ["pi-qq@0.1.17", "pi-extra"] }) });
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
    assert.match(absentCheck.detail, /omp не запущен/);
    assert.equal(absent.ok, false);

    const garbage = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ listStdout: "not json at all" }) });
    const garbageCheck = checkOf(garbage, "plugins");
    assert.equal(garbageCheck.status, "fail");
    assert.match(garbageCheck.detail, /вывод omp plugin list не разобран/);
    assert.equal(garbage.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: манифест с синтаксической ошибкой → FAIL", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-bad-"));
  try {
    const harness = createMockHarness(tmp);
    writeFileSync(join(harness, "agent", "plugins.json"), "{ invalid json", "utf8");

    const result = runDoctorWithOmp(tmp, { runOmp: fakeOmp({ installed: [] }) });
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
      runOmp: fakeOmp({ installed: ["pi-qq"], doctorStatus: 1, doctorStderr: "boom: broken plugin\nsecond line" }),
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

test("plugins: обязательный плагин с неверной версией → FAIL (ok: false)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-req-ver-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
    ]);

    const result = runDoctorWithOmp(tmp, {
      runOmp: fakeOmp({ installed: [{ name: "pi-lens", version: "4.2.0" }] }),
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "fail");
    assert.match(check.detail, /Несоответствие версии обязательных плагинов/);
    assert.match(check.detail, /4\.2\.0 != 4\.2\.1/);
    assert.equal(result.summary.fail, 1);
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("plugins: опциональный плагин с неверной версией → WARN (ok: true)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-plugins-opt-ver-"));
  try {
    const harness = createMockHarness(tmp);
    writePluginsManifest(harness, [
      { name: "pi-lens", spec: "pi-lens@4.2.1", required: true },
      { name: "pi-qq", spec: "pi-qq@0.1.17", required: false },
    ]);

    const result = runDoctorWithOmp(tmp, {
      runOmp: fakeOmp({
        installed: [
          { name: "pi-lens", version: "4.2.1" },
          { name: "pi-qq", version: "0.1.10" },
        ],
      }),
    });
    const check = checkOf(result, "plugins");

    assert.equal(check.status, "warn");
    assert.match(check.detail, /Несоответствие версии опциональных плагинов/);
    assert.match(check.detail, /0\.1\.10 != 0\.1\.17/);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.ok, true);
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
