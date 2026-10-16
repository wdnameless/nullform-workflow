import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { createTempDir } from "./test-helpers.mjs";
import { loadYaml } from "../harness-config.mjs";

const CLI = fileURLToPath(new URL("../../bin/nullform.mjs", import.meta.url));
const yaml = loadYaml();

function fixture(t) {
  const base = createTempDir("adaptive-cli-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "user"), host = join(home, "selected-host");
  const root = join(base, "workflow"), project = join(base, "project");
  for (const dir of [home, host, project]) mkdirSync(dir, { recursive: true });
  // Never inherit the operator's real Hermes profile, registry credentials or loaders.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HERMES_|NULLFORM_|NPM_CONFIG_|npm_config_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NULLFORM_USER_HOME: home,
    LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"), HERMES_HOME: host,
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: join(home, "global.npmrc"),
    NPM_CONFIG_CACHE: join(base, "npm-cache"), NF_NO_DASHBOARD: "1", NF_NO_OPEN: "1",
  });
  writeFileSync(env.NPM_CONFIG_USERCONFIG, "", "utf8");
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "", "utf8");
  const fx = { base, home, host, root, project, env };
  fx.run = (args, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--user-home", home, "--json"], {
      cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120000,
      windowsHide: true, shell: false,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  fx.init = (harness, args = [], extraEnv = {}) => fx.run([
    "init", "--harness", harness, "--root", root, "--host-home", host,
    "--project-root", project, "--yes", "--skip-release-check", ...args,
  ], extraEnv);
  return fx;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function snapshot(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix + entry.name, path = join(root, entry.name);
    if (entry.isSymbolicLink()) return [[name, "link", readlinkSync(path)]];
    if (entry.isDirectory()) return [[name, "directory"], ...snapshot(path, name + "/")];
    return [[name, "file", readFileSync(path).toString("base64")]];
  });
}

function manifest(fx, capabilities = {}, overrides = {}) {
  const path = join(fx.base, "host.json");
  put(path, JSON.stringify({
    schemaVersion: 1, id: "isolated-client", instructionsFile: "instructions/workflow.md", capabilities, ...overrides,
  }));
  return path;
}

function state(fx) {
  return JSON.parse(readFileSync(join(fx.home, ".nullform", "installation.json"), "utf8"));
}

test("public inspect and init preview leave an isolated Hermes profile byte-identical", (t) => {
  const fx = fixture(t);
  put(join(fx.host, "config.yaml"), "# operator config\nskills:\n  auto_load: [human-policy]\n");
  put(join(fx.host, "SOUL.md"), "Operator identity, not coding policy.\n");
  const before = snapshot(fx.base);
  const report = success(fx.run(["inspect", "--harness", "hermes", "--host-home", fx.host]));
  assert.equal(report.harness, "hermes");
  assert.equal(resolve(report.hostHome), fx.host);
  assert.deepEqual(snapshot(fx.base), before, "Default inspection must not modify any profile/project file");
  assert.equal(success(fx.init("hermes", ["--dry-run"])).dryRun, true);
  assert.deepEqual(snapshot(fx.base), before, "Preview must not write installation identity or assets");
});

test("Hermes policy has one native auto-load consumer and preserves human configuration on reapply", (t) => {
  const fx = fixture(t);
  const configPath = join(fx.host, "config.yaml"), soulPath = join(fx.host, "SOUL.md");
  const config = "# operator comment\ncustom_setting: keep\nskills:\n  auto_load:\n    - human-policy # human entry\nmcp_servers:\n  human-server:\n    command: human-tool\n";
  const soul = "Human identity\r\nKeep these exact bytes.\r\n";
  put(configPath, config);
  put(soulPath, soul);
  put(join(fx.host, "skills", "human-policy", "SKILL.md"), "---\nname: human-policy\ndescription: Human policy\n---\nHuman-owned policy.\n");
  const humanSkill = readFileSync(join(fx.host, "skills", "human-policy", "SKILL.md"));
  for (let apply = 0; apply < 2; apply++) {
    const applied = success(fx.init("hermes"));
    assert.equal(applied.ok, true);
    assert.equal(applied.profile.runtimeReady.status, "not-verified", "Native registration is configuration, not a live Hermes load");
    const installedText = readFileSync(configPath, "utf8"), installed = yaml.parse(installedText);
    assert.deepEqual(installed.skills.auto_load, ["human-policy", "nullform-workflow"]);
    assert.deepEqual(installed.mcp_servers, yaml.parse(config).mcp_servers);
    assert.equal(installed.custom_setting, "keep");
    // Comments are operator data, not a generated-prompt wording contract.
    assert.equal(installedText.includes("# operator comment"), true);
    assert.equal(installedText.includes("# human entry"), true);
    assert.deepEqual(readFileSync(soulPath), Buffer.from(soul));
    assert.deepEqual(readFileSync(join(fx.host, "skills", "human-policy", "SKILL.md")), humanSkill);
    assert.deepEqual(readdirSync(join(fx.host, "skills")).sort(), ["human-policy", "nullform-workflow"]);
    const skillPath = join(fx.host, "skills", installed.skills.auto_load[1], "SKILL.md");
    const skill = readFileSync(skillPath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
    assert.ok(frontmatter, "Hermes consumes SKILL.md native frontmatter, not home AGENTS alone");
    const metadata = yaml.parse(frontmatter[1]);
    assert.equal(metadata.name, "nullform-workflow");
    assert.equal(typeof metadata.description, "string");
    assert.notEqual(metadata.description.trim(), "");
    assert.equal(existsSync(join(fx.project, ".workflow", "state.json")), false);
  }
});

test("fresh Hermes installation creates no SOUL, unsolicited MCP or bulk skill catalogue", (t) => {
  const fx = fixture(t);
  assert.equal(success(fx.init("hermes")).ok, true);
  assert.equal(existsSync(join(fx.host, "SOUL.md")), false);
  assert.equal(existsSync(join(fx.root, "SOUL.md")), false);
  assert.equal(existsSync(join(fx.home, ".agents", "skills")), false);
  const config = yaml.parse(readFileSync(join(fx.host, "config.yaml"), "utf8"));
  assert.deepEqual(config.skills.auto_load, ["nullform-workflow"]);
  assert.deepEqual(Object.keys(config.mcp_servers || {}), []);
  assert.deepEqual(readdirSync(join(fx.host, "skills")), ["nullform-workflow"]);
  assert.equal(existsSync(join(fx.project, ".workflow", "state.json")), false);
});

for (const skills of ["skills: []\n", "skills: false\n", "skills:\n  auto_load: human-policy\n", "skills:\n  auto_load: [42]\n"]) {
  test(`Hermes rejects malformed native loader schema before mutation: ${JSON.stringify(skills)}`, (t) => {
    const fx = fixture(t);
    put(join(fx.host, "config.yaml"), skills);
    const before = snapshot(fx.base);
    const result = fx.init("hermes");
    assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(snapshot(fx.base), before);
  });
}

for (const disabled of ["environment", "declared"]) {
  test(`Hermes does not enable an explicitly unavailable policy loader: ${disabled}`, (t) => {
    const fx = fixture(t), configPath = join(fx.host, "config.yaml");
    const config = "# user loader configuration\nskills:\n  auto_load: [human-policy]\n";
    put(configPath, config);
    const args = disabled === "declared"
      ? ["--host-manifest", manifest(fx, { skills: "unavailable" }, { id: "hermes" })] : [];
    const result = fx.init("hermes", args, disabled === "environment" ? { HERMES_IGNORE_RULES: "1" } : {});
    const applied = success(result);
    assert.equal(applied.activation.status, "manual");
    assert.equal(applied.profile.modules.skills.decision, "manual");
    assert.equal(applied.profile.runtimeReady.status, "not-verified");
    assert.equal(existsSync(join(fx.root, "AGENTS.md")), true, "Manual delivery retains project/root instructions without claiming auto-load");
    assert.equal(readFileSync(configPath, "utf8"), config, "Disabled native loading must not be silently re-enabled");
    assert.equal(existsSync(join(fx.host, "skills", "nullform-workflow", "SKILL.md")), false);
    assert.equal(existsSync(join(fx.host, "SOUL.md")), false);
  });
}

test("Hermes refuses an unowned policy-skill name without overwriting any files", (t) => {
  const fx = fixture(t);
  put(join(fx.host, "config.yaml"), "skills:\n  auto_load: [human-policy]\n");
  put(join(fx.host, "skills", "nullform-workflow", "SKILL.md"), "---\nname: nullform-workflow\ndescription: Human-owned skill\n---\nDo not replace.\n");
  const before = snapshot(fx.base);
  const result = fx.init("hermes");
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(snapshot(fx.base), before);
});

test("Hermes reapply cannot re-enable a generated policy removed from auto_load by the operator", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  assert.equal(success(fx.init("hermes")).ok, true);
  const config = yaml.parse(readFileSync(configPath, "utf8"));
  config.skills.auto_load = ["human-policy"];
  put(configPath, yaml.stringify(config));
  const before = snapshot(fx.base);
  const result = fx.run(["init", "--yes", "--skip-release-check"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(snapshot(fx.base), before, "Human disabling must survive reapply without any partial deployment");
});

test("custom instruction destination preserves human text and uses the stored manifest on reapply", (t) => {
  const fx = fixture(t), destination = join(fx.project, "instructions", "workflow.md");
  const humanPrefix = "# Project-owned instructions\n\nHuman UTF-8: Ж, 日本語.\n";
  put(destination, humanPrefix);
  const path = manifest(fx, { taskState: "available", delegation: "available", verification: "unknown" });
  assert.equal(success(fx.init("custom", ["--host-manifest", path])).ok, true);
  const first = readFileSync(destination, "utf8");
  assert.equal(first.startsWith(humanPrefix), true);
  const humanSuffix = "\nHuman addition after install.\n";
  put(destination, first + humanSuffix);
  // A mutable manifest file must not silently redirect a previously selected installation.
  put(path, JSON.stringify({ schemaVersion: 1, id: "changed-client", instructionsFile: "elsewhere.md", capabilities: {} }));
  assert.equal(success(fx.run(["init", "--yes", "--skip-release-check"])).ok, true);
  assert.equal(readFileSync(destination, "utf8"), first + humanSuffix);
  assert.equal(existsSync(join(fx.project, "elsewhere.md")), false);
  assert.equal(state(fx).harness, "custom");
  assert.equal(state(fx).projectRoot, fx.project);
  assert.equal(existsSync(join(fx.project, ".workflow", "state.json")), false);
});

const invalidManifests = [
  { instructionsFile: "../escaped.md" },
  { instructionsFile: "/absolute.md" },
  { instructionsFile: "C:/absolute.md" },
  { instructionsFile: "instructions\\workflow.md" },
  { instructionsFile: "instructions/workflow.md:stream" },
  { instructionsFile: "instructions/\u0000policy.md" },
  { commands: { inspect: "echo should-never-run" } },
  { capabilities: { taskState: "sometimes" } },
];
for (const invalid of invalidManifests) {
  test(`custom manifest fails closed without writes: ${JSON.stringify(invalid)}`, (t) => {
    const fx = fixture(t), path = manifest(fx, {}, invalid), before = snapshot(fx.base);
    const inspect = fx.run(["inspect", "--harness", "custom", "--host-home", fx.host, "--project-root", fx.project, "--host-manifest", path]);
    assert.notEqual(inspect.status, 0, inspect.stdout);
    assert.deepEqual(snapshot(fx.base), before);
    const init = fx.init("custom", ["--host-manifest", path]);
    assert.notEqual(init.status, 0, init.stdout);
    assert.deepEqual(snapshot(fx.base), before);
  });
}

test("stored Hermes profile remains selected after the ambient profile changes", (t) => {
  const fx = fixture(t), other = join(fx.home, "other-independent-root");
  assert.equal(success(fx.init("hermes")).ok, true);
  put(join(other, "config.yaml"), "# another operator profile\nskills:\n  auto_load: [other-policy]\n");
  put(join(other, "SOUL.md"), "Other independent identity.\n");
  const otherBefore = snapshot(other), saved = state(fx);
  const changedEnv = { HERMES_HOME: other };
  const doctor = success(fx.run(["doctor", "--skip-release-check"], changedEnv));
  assert.equal(doctor.targetHarness, "hermes");
  assert.equal(doctor.profile.hostHome, fx.host);
  assert.equal(doctor.profile.runtimeReady.status, "not-verified");
  assert.equal(success(fx.run(["init", "--yes", "--skip-release-check"], changedEnv)).ok, true);
  assert.deepEqual(snapshot(other), otherBefore);
  assert.equal(state(fx).root, saved.root);
  assert.equal(state(fx).hostHome, fx.host);
  assert.equal(existsSync(join(other, "skills", "nullform-workflow", "SKILL.md")), false);
});

for (const status of ["available", "unavailable", "unknown"]) {
  test(`public Hermes profile distinguishes native ${status} task/delegation evidence`, (t) => {
    const fx = fixture(t);
    const capabilities = { taskState: status, delegation: status, worktree: status, verification: "unknown" };
    const path = manifest(fx, capabilities, { id: "hermes" });
    const before = snapshot(fx.base);
    const report = success(fx.run([
      "inspect", "--harness", "hermes", "--host-home", fx.host, "--host-manifest", path,
    ]));
    assert.deepEqual(snapshot(fx.base), before);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.runtimeReady.status, "not-verified");
    assert.deepEqual(report.probe, { requested: false, commands: [] });
    for (const key of ["taskState", "delegation", "worktree"]) {
      assert.equal(report.capabilities[key].status, status);
      assert.equal(report.capabilities[key].evidence, "declared");
    }
    assert.equal(report.modules.taskState.decision, { available: "reuse", unavailable: "enable", unknown: "manual" }[status]);
    assert.equal(report.modules.delegation.decision, status === "available" ? "reuse" : "manual");
    if (status === "unavailable") {
      const git = spawnSync("git", ["--version"], { cwd: fx.project, env: fx.env, encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(report.modules.worktree.decision, git.status === 0 ? "enable" : "manual");
    } else {
      assert.equal(report.modules.worktree.decision, status === "available" ? "reuse" : "manual");
    }
    assert.equal(report.modules.verification.decision, "enable");
    const installed = success(fx.init("hermes", ["--host-manifest", path]));
    for (const key of ["taskState", "delegation", "worktree", "verification"]) {
      assert.equal(installed.profile.modules[key].decision, report.modules[key].decision);
    }
    assert.equal(existsSync(join(fx.project, ".workflow", "state.json")), false, "An installed policy must not create a parallel task board");
    if (status === "unavailable") {
      // Exercise the existing enabled task gate, including the unmet-artifact boundary.
      const workflow = (args) => spawnSync(process.execPath, [CLI, "workflow", ...args], {
        cwd: fx.project, env: fx.env, encoding: "utf8", timeout: 20000, windowsHide: true,
      });
      assert.equal(workflow(["start", "--tier", "T1", "--task", "Isolated verification", "--no-dashboard"]).status, 0);
      assert.equal(workflow(["check"]).status, 1);
      assert.equal(workflow(["close"]).status, 1, "Incomplete work must not close");
      assert.equal(workflow(["artifact", "--kind", "recon", "--detail", "Files: isolated input; acceptance: inspect actual output."]).status, 0);
      assert.equal(workflow(["check"]).status, 0);
      assert.equal(workflow(["close"]).status, 0);
      assert.equal(existsSync(join(fx.project, ".workflow", "dashboard.json")), false);
    }
  });
}

test("custom requires both its manifest and explicit project scope before any writes", (t) => {
  const fx = fixture(t), path = manifest(fx), before = snapshot(fx.base);
  for (const args of [
    ["--project-root", fx.project],
    ["--host-manifest", path],
  ]) {
    const result = fx.run(["init", "--harness", "custom", "--host-home", fx.host, "--root", fx.root, "--yes", "--skip-release-check", ...args]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.deepEqual(snapshot(fx.base), before);
  }
});

test("public update preview keeps stored host home and manifest despite changed environment and manifest file", async (t) => {
  const fx = fixture(t), other = join(fx.home, "other-independent-root");
  const path = manifest(fx, { taskState: "available", delegation: "unavailable" }, { id: "hermes" });
  assert.equal(success(fx.init("hermes", ["--host-manifest", path])).ok, true);
  const saved = state(fx);
  assert.equal(saved.hostHome, fx.host);
  assert.equal(saved.hostManifest.capabilities.taskState, "available");
  put(join(other, "config.yaml"), "skills:\n  auto_load: [other-human-policy]\n");
  put(path, JSON.stringify({ schemaVersion: 1, id: "hermes", capabilities: { taskState: "unavailable" } }));
  const selectedBefore = snapshot(fx.host), otherBefore = snapshot(other), stateBefore = readFileSync(join(fx.home, ".nullform", "installation.json"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ name: "nullform-workflow", version: saved.version }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      CLI, "update", "--dry-run", "--user-home", fx.home, "--api-url",
      `http://127.0.0.1:${server.address().port}/nullform-workflow/latest`, "--json",
    ], { cwd: fx.project, env: { ...fx.env, HERMES_HOME: other }, timeout: 20000, windowsHide: true });
    const preview = JSON.parse(stdout);
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.updated, false);
    assert.equal(preview.harness, "hermes");
    assert.equal(preview.root, saved.root);
    assert.equal(preview.hostHome, saved.hostHome);
    assert.deepEqual(preview.hostManifest, saved.hostManifest);
    assert.deepEqual(requests, [{ method: "GET", url: "/nullform-workflow/latest" }]);
    assert.deepEqual(snapshot(fx.host), selectedBefore);
    assert.deepEqual(snapshot(other), otherBefore);
    assert.deepEqual(readFileSync(join(fx.home, ".nullform", "installation.json")), stateBefore);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});
