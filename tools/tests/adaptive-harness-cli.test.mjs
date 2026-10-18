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
import { applyManagedSection, hashContent, loadYaml, MANAGED_START, MANAGED_END } from "../harness-config.mjs";
import { prepareHermesActivation } from "../harness-adapters.mjs";
import { inspectHarness } from "../harness-profiles.mjs";
import { runDoctor } from "../doctor.mjs";

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

// These adapter/doctor regressions do not copy a full installation or claim
// native runtime consumption; the parent verifies the installed Hermes consumer.
function hermesPolicy(fx, { env = fx.env, managedFiles = {}, slashRoot = fx.root.replace(/\\/g, "/") } = {}) {
  const report = inspectHarness({
    harness: "hermes", userHome: fx.home, hostHome: fx.host,
    projectRoot: fx.project, env,
  });
  return prepareHermesActivation({
    hostHome: fx.host, slashRoot, report, managedFiles, env,
  });
}

test("Hermes native policy preserves human prompt, YAML and legacy assets on reapply", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const human = "Human UTF-8: Ж, 日本語.  \n\nKeep my base prompt.\n";
  const settings = "# operator comment\ncustom_setting: keep # setting comment\nskills:\n  auto_load: [human-policy] # human entry\nmcp_servers:\n  human-server:\n    command: human-tool\n";
  put(configPath, `agent:\n  max_turns: 17 # agent comment\n  system_prompt: |\n${human.split("\n").slice(0, -1).map(line => `    ${line}\n`).join("")}${settings}`);
  put(join(fx.host, "SOUL.md"), "Human identity\r\nKeep these exact bytes.\r\n");
  put(join(fx.host, "USER.md"), "Human preferences.\n");
  put(join(fx.host, "skills", "human-policy", "SKILL.md"), "Human-owned skill.\n");
  const assets = snapshot(fx.host).filter(([path]) => path !== "config.yaml");
  const managedFiles = {};
  const first = hermesPolicy(fx);
  assert.equal(first.activation.status, "configured");
  assert.deepEqual(first.writes.map(([path]) => path), [configPath]);
  const text = first.writes[0][1], installed = yaml.parse(text);
  assert.equal(installed.agent.system_prompt.startsWith(human), true, "Do not replace or trim the human base prompt");
  assert.equal(installed.agent.system_prompt.split(MANAGED_START).length - 1, 1);
  assert.equal(installed.agent.system_prompt.split(MANAGED_END).length - 1, 1);
  assert.equal(installed.agent.max_turns, 17);
  assert.equal(text.includes(settings), true, "Unrelated YAML, comments and formatting are human data");
  assert.equal(text.includes("# agent comment"), true);
  for (const [path, content] of first.writes) {
    put(path, content);
    managedFiles[path] = hashContent(content);
  }
  const suffix = "\nHuman addition after the owned block.  \n";
  const doc = yaml.parseDocument(readFileSync(configPath, "utf8"), { keepSourceTokens: true });
  doc.setIn(["agent", "system_prompt"], installed.agent.system_prompt + suffix);
  doc.set("custom_setting", "human edit after install");
  put(configPath, doc.toString());
  const before = readFileSync(configPath, "utf8");
  const reapplied = hermesPolicy(fx, { managedFiles });
  assert.equal(reapplied.activation.status, "configured");
  assert.deepEqual(reapplied.writes.map(([path]) => path), [configPath]);
  assert.equal(reapplied.writes[0][1], before, "Reapply must preserve human edits outside the owned prompt block");
  assert.deepEqual(snapshot(fx.host).filter(([path]) => path !== "config.yaml"), assets);
});

test("Hermes native policy fresh activation uses only agent.system_prompt", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml"), before = snapshot(fx.base);
  const prepared = hermesPolicy(fx);
  assert.equal(prepared.activation.status, "configured");
  assert.deepEqual(prepared.writes.map(([path]) => path), [configPath]);
  const installed = yaml.parse(prepared.writes[0][1]);
  assert.equal(installed.agent.system_prompt.split(MANAGED_START).length - 1, 1);
  assert.equal(installed.agent.system_prompt.split(MANAGED_END).length - 1, 1);
  assert.equal(installed.skills, undefined);
  assert.equal(installed.mcp_servers, undefined);
  assert.deepEqual(snapshot(fx.base), before, "Preflight must not mutate files");
});

test("Hermes native policy honors prompt override presence and ignore-rules without writes", (t) => {
  const fx = fixture(t);
  put(join(fx.host, "config.yaml"), 'agent:\n  system_prompt: "Human base prompt"\n');
  const before = snapshot(fx.base);
  for (const override of [
    { HERMES_IGNORE_RULES: "1" },
    { HERMES_EPHEMERAL_SYSTEM_PROMPT: "Human session override" },
    { HERMES_EPHEMERAL_SYSTEM_PROMPT: " " },
    { HERMES_EPHEMERAL_SYSTEM_PROMPT: "" },
  ]) {
    const prepared = hermesPolicy(fx, { env: { ...fx.env, ...override } });
    assert.equal(prepared.activation.status, "manual");
    assert.deepEqual(prepared.writes, []);
    assert.deepEqual(snapshot(fx.base), before);
    assert.equal(JSON.stringify(prepared).includes("Human session override"), false, "Never echo an override's contents");
  }
});

test("Hermes native policy rejects malformed agent and prompt fields without writes", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  for (const config of [
    "agent: false\n", "agent: []\n", "agent: human\n",
    "agent:\n  system_prompt: false\n", "agent:\n  system_prompt: 42\n",
    "agent:\n  system_prompt: []\n", "agent:\n  system_prompt: {}\n",
    "agent:\n  system_prompt: null\n",
  ]) {
    put(configPath, config);
    const before = snapshot(fx.base);
    assert.throws(() => hermesPolicy(fx));
    assert.deepEqual(snapshot(fx.base), before);
  }
});

test("Hermes native policy preserves unknown legacy skills instead of adopting them", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  put(join(fx.host, "skills", "nullform-workflow", "SKILL.md"), "Human-owned namesake skill.\n");
  const asset = readFileSync(join(fx.host, "skills", "nullform-workflow", "SKILL.md"));
  for (const legacy of [
    "skills: false\n", "skills: []\n", "skills:\n  auto_load: human-policy\n",
    "skills:\n  auto_load: [42]\n", "skills:\n  auto_load: [nullform-workflow, human-policy]\n",
  ]) {
    put(configPath, `agent:\n  system_prompt: Human base\n${legacy}`);
    const prepared = hermesPolicy(fx);
    assert.equal(prepared.activation.status, "configured");
    assert.deepEqual(prepared.writes.map(([path]) => path), [configPath]);
    assert.equal(prepared.writes[0][1].includes(legacy), true);
    assert.deepEqual(yaml.parse(prepared.writes[0][1]).skills, yaml.parse(legacy).skills);
    assert.deepEqual(readFileSync(join(fx.host, "skills", "nullform-workflow", "SKILL.md")), asset);
  }
});

test("Hermes native policy refuses unknown, malformed and modified managed blocks", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const unknown = `${MANAGED_START}\nHuman-owned policy; not ours to replace.\n${MANAGED_END}`;
  for (const prompt of [unknown, MANAGED_START, MANAGED_END, `${MANAGED_END}\n${MANAGED_START}`, `${unknown}\n${unknown}`]) {
    put(configPath, yaml.stringify({ agent: { system_prompt: prompt } }));
    const before = snapshot(fx.base);
    assert.throws(() => hermesPolicy(fx));
    assert.deepEqual(snapshot(fx.base), before);
  }
  rmSync(configPath);
  const first = hermesPolicy(fx), managedFiles = {};
  for (const [path, content] of first.writes) {
    put(path, content);
    managedFiles[path] = hashContent(content);
  }
  const config = yaml.parse(readFileSync(configPath, "utf8"));
  config.agent.system_prompt = config.agent.system_prompt.replace(MANAGED_START, `${MANAGED_START}\nHuman edit inside owned block.`);
  put(configPath, yaml.stringify(config));
  const before = snapshot(fx.base);
  assert.throws(() => hermesPolicy(fx, { managedFiles }));
  assert.deepEqual(snapshot(fx.base), before);
});

test("Hermes native policy does not restore a policy removed by the operator", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml"), managedFiles = {};
  const first = hermesPolicy(fx);
  for (const [path, content] of first.writes) {
    put(path, content);
    managedFiles[path] = hashContent(content);
  }
  const config = yaml.parse(readFileSync(configPath, "utf8"));
  config.agent = { ...config.agent, system_prompt: "Only my human prompt now" };
  put(configPath, yaml.stringify(config));
  const before = snapshot(fx.base);
  assert.throws(() => hermesPolicy(fx, { managedFiles }));
  assert.deepEqual(snapshot(fx.base), before);
});

test("Hermes native policy doctor rejects legacy-only loading and respects manual overrides", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  put(join(fx.root, "AGENTS.md"), applyManagedSection("", "Isolated installation policy."));
  put(configPath, "skills:\n  auto_load: [nullform-workflow]\n");
  put(join(fx.host, "skills", "nullform-workflow", "SKILL.md"), "---\nname: nullform-workflow\ndescription: Legacy policy\n---\nLegacy content.\n");
  const options = {
    harness: fx.root, targetHarness: "hermes", userHome: fx.home, hostHome: fx.host,
    projectRoot: fx.project, mode: "installed", env: fx.env, skipReleaseCheck: true, skipPluginCheck: true,
  };
  const before = snapshot(fx.base);
  const legacy = runDoctor(options);
  assert.equal(legacy.checks.find(check => check.id === "harness-integration").status, "fail", "An unconsumed auto_load entry cannot establish configured policy");
  assert.deepEqual(snapshot(fx.base), before);
  rmSync(configPath);
  rmSync(join(fx.host, "skills"), { recursive: true });
  for (const [path, content] of hermesPolicy(fx).writes) put(path, content);
  const configured = runDoctor(options);
  assert.equal(configured.checks.find(check => check.id === "harness-integration").status, "pass");
  assert.equal(configured.profile.runtimeReady.status, "not-verified");
  for (const override of [{ HERMES_IGNORE_RULES: "1" }, { HERMES_EPHEMERAL_SYSTEM_PROMPT: "Human session override" }, { HERMES_EPHEMERAL_SYSTEM_PROMPT: "" }]) {
    const snapshotBefore = snapshot(fx.base);
    const manual = runDoctor({ ...options, env: { ...fx.env, ...override } });
    assert.equal(manual.checks.find(check => check.id === "policy-loading").status, "warn");
    assert.equal(manual.profile.runtimeReady.status, "not-verified");
    assert.equal(JSON.stringify(manual).includes("Human session override"), false);
    assert.deepEqual(snapshot(fx.base), snapshotBefore);
  }
});

test("Hermes native policy refuses to adopt an exact generated block without ownership", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const block = `${MANAGED_START}\nAdopted-looking policy text.\n${MANAGED_END}`;
  put(configPath, yaml.stringify({ agent: { system_prompt: block } }));
  const before = snapshot(fx.base);
  // An exact-looking block that we never installed is not authority to rewrite it.
  assert.throws(() => hermesPolicy(fx, { managedFiles: {} }));
  assert.deepEqual(snapshot(fx.base), before);
});

test("Hermes native policy migrates an unchanged owned config to the native block", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const legacySkill = join(fx.host, "skills", "nullform-workflow", "SKILL.md");
  put(legacySkill, "Legacy owned skill.\n");
  put(configPath, "agent:\n  max_turns: 7\n");
  const managedFiles = {
    [configPath]: hashContent(readFileSync(configPath, "utf8")),
    [legacySkill]: hashContent(readFileSync(legacySkill)),
  };
  const prepared = hermesPolicy(fx, { managedFiles });
  const installed = yaml.parse(prepared.writes[0][1]);
  assert.equal(prepared.activation.status, "configured");
  assert.equal(installed.agent.max_turns, 7, "Unrelated human fields survive the owned migration");
  assert.equal(installed.agent.system_prompt.split(MANAGED_START).length - 1, 1);
});

test("Hermes native policy upgrades an unchanged owned config to a changed policy", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const first = hermesPolicy(fx), managedFiles = {};
  for (const [path, content] of first.writes) { put(path, content); managedFiles[path] = hashContent(content); }
  const before = readFileSync(configPath, "utf8");
  // Same full-config hash as persisted ownership, different generated policy/root: a legitimate upgrade.
  const changed = hermesPolicy(fx, { managedFiles, slashRoot: `${fx.root.replace(/\\/g, "/")}/moved` });
  assert.equal(changed.writes[0][1] !== before, true);
  assert.equal(changed.writes[0][1].includes(`${fx.root.replace(/\\/g, "/")}/moved`), true);
  assert.equal(changed.writes[0][1].split(MANAGED_START).length - 1, 1);
});

test("Hermes native policy never re-enables a block removed after legacy ownership", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  const legacySkill = join(fx.host, "skills", "nullform-workflow", "SKILL.md");
  put(legacySkill, "Legacy owned skill.\n");
  put(configPath, "agent:\n  system_prompt: Human base\n");
  const managedFiles = {
    [configPath]: hashContent(readFileSync(configPath, "utf8")),
    [legacySkill]: hashContent(readFileSync(legacySkill)),
  };
  // Operator removed the native block and rewrote the prompt: legacy ownership is not consent.
  put(configPath, "agent:\n  system_prompt: Only my human prompt now\n");
  const before = snapshot(fx.base);
  assert.throws(() => hermesPolicy(fx, { managedFiles }));
  assert.deepEqual(snapshot(fx.base), before);
});

test("Hermes native policy rejects merge keys and YAML 1.1 boolean prompt scalars", (t) => {
  const fx = fixture(t), configPath = join(fx.host, "config.yaml");
  for (const config of [
    "defaults: &d\n  system_prompt: inherited\nagent:\n  <<: *d\n  max_turns: 5\n",
    "agent:\n  system_prompt: off\n",
    "agent:\n  system_prompt: yes\n",
    "agent:\n  system_prompt: on\n",
  ]) {
    put(configPath, config);
    const before = snapshot(fx.base);
    assert.throws(() => hermesPolicy(fx), `must refuse: ${JSON.stringify(config)}`);
    assert.deepEqual(snapshot(fx.base), before);
  }
  // Explicit quoting and !!str keep the value a real string and are accepted.
  for (const config of ["agent:\n  system_prompt: \"off\"\n", "agent:\n  system_prompt: !!str off\n"]) {
    put(configPath, config);
    assert.equal(hermesPolicy(fx).activation.status, "configured");
  }
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
