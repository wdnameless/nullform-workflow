import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { inspectHarness, resolveHostHome, validateHostManifest } from "../harness-profiles.mjs";
import { getCapabilitiesInfo } from "../harness-capabilities.mjs";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "nullform-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const hostHome = join(home, "hermes-isolated");
  const projectRoot = join(root, "project");
  const bin = join(root, "bin");
  for (const path of [home, hostHome, projectRoot, bin]) mkdirSync(path, { recursive: true });
  return {
    root, home, hostHome, projectRoot, bin,
    env: { ...process.env, HOME: home, USERPROFILE: home, NULLFORM_USER_HOME: home, LOCALAPPDATA: join(home, "AppData", "Local"), HERMES_HOME: hostHome, HERMES_DATA_DIR_SUFFIX: "", HERMES_SUPERVISED_CHILD: "", HERMES_S6_SUPERVISED_CHILD: "", HERMES_GATEWAY_EXTERNAL_SUPERVISOR: "", HERMES_IGNORE_RULES: "", PATH: bin, Path: bin },
  };
}

function manifest(id, capabilities = {}, extra = {}) {
  return { schemaVersion: 1, id, capabilities, ...extra };
}

function snapshot(root) {
  const entries = {};
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix + name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries[relative] = { link: readlinkSync(path) };
      else if (stat.isDirectory()) { entries[relative] = { directory: true }; visit(path, `${relative}/`); }
      else entries[relative] = readFileSync(path).toString("base64");
    }
  }
  visit(root);
  return entries;
}

function directoryLink(t, target, path) {
  try { symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.skip(`Directory symlink prerequisite unavailable: ${error.code}`);
    return false;
  }
  return true;
}

test("default inspection neither starts an executable nor modifies selected profile/project bytes", (t) => {
  const box = sandbox(t);
  const marker = join(box.root, "host-was-started");
  const executable = join(box.bin, process.platform === "win32" ? "hermes.cmd" : "hermes");
  writeFileSync(executable, process.platform === "win32" ? `@echo started > "${marker}"\r\n` : `#!/bin/sh\nprintf started > '${marker}'\n`);
  chmodSync(executable, 0o755);
  writeFileSync(join(box.hostHome, "config.yaml"), "skills:\n  auto_load: [human-skill]\n");
  writeFileSync(join(box.hostHome, "SOUL.md"), "Human-owned identity\n");
  const before = snapshot(box.root);
  const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, projectRoot: box.projectRoot, env: box.env });
  assert.deepEqual(snapshot(box.root), before);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(report.probe, { requested: false, commands: [] });
  assert.equal(report.runtimeReady.status, "not-verified");
  assert.deepEqual([report.capabilities.taskState.status, report.capabilities.taskState.evidence, report.modules.taskState.decision], ["unknown", "documented", "manual"]);
});

test("Windows Hermes defaults honor isolated LOCALAPPDATA and a bounded literal suffix", (t) => {
  const box = sandbox(t);
  const env = { ...box.env, HERMES_HOME: "", HERMES_DATA_DIR_SUFFIX: "-sandbox" };
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env, platform: "win32" }).path, join(box.home, "AppData", "Local", "hermes-sandbox"));
  const foreign = join(box.root, "real-user");
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env: { ...env, HERMES_HOME: foreign, LOCALAPPDATA: foreign }, platform: "win32" }).path, join(box.home, "AppData", "Local", "hermes-sandbox"));
  for (const suffix of ["/escape", "\\escape", "..", ":ads", "\nsecret", "."]) {
    assert.throws(() => resolveHostHome({ harness: "hermes", userHome: box.home, env: { ...env, HERMES_DATA_DIR_SUFFIX: suffix }, platform: "win32" }), /SUFFIX/);
  }
});

test("sticky Hermes root selection requires live native identity and preserves explicit selected homes", (t) => {
  const box = sandbox(t);
  const selected = join(box.hostHome, "profiles", "coder");
  mkdirSync(selected, { recursive: true });
  writeFileSync(join(selected, "config.yaml"), "# identity presence only\n");
  writeFileSync(join(box.hostHome, "active_profile"), "\ufeffcoder\r\n");
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env: box.env }).path, selected);
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env }).path, box.hostHome);
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env: { ...box.env, HERMES_HOME: selected } }).path, selected);
  for (const supervisor of ["HERMES_SUPERVISED_CHILD", "HERMES_S6_SUPERVISED_CHILD", "HERMES_GATEWAY_EXTERNAL_SUPERVISOR"]) {
    assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env: { ...box.env, [supervisor]: "1" } }).path, box.hostHome);
  }
  // INVOCATION_ID alone is not supervision for these non-gateway commands.
  assert.equal(resolveHostHome({ harness: "hermes", userHome: box.home, env: { ...box.env, INVOCATION_ID: "fixture" } }).path, selected);
  mkdirSync(join(box.hostHome, "profiles", ".deleted"));
  writeFileSync(join(box.hostHome, "profiles", ".deleted", "coder"), "deleted");
  assert.throws(() => resolveHostHome({ harness: "hermes", userHome: box.home, env: box.env }), /missing, deleted/);
  rmSync(join(box.hostHome, "profiles", ".deleted", "coder"));
  rmSync(join(selected, "config.yaml"));
  assert.throws(() => resolveHostHome({ harness: "hermes", userHome: box.home, env: box.env }), /identity/);
});

test("escaping, malformed and oversized sticky metadata fails closed without writes", (t) => {
  const box = sandbox(t);
  for (const name of ["../escape", "..", "a/b", "a\\b", "a:stream", "Coder", "coder\u0000", "a".repeat(129)]) {
    writeFileSync(join(box.hostHome, "active_profile"), name);
    const before = snapshot(box.root);
    assert.throws(() => resolveHostHome({ harness: "hermes", userHome: box.home, env: box.env }), /active_profile/);
    assert.deepEqual(snapshot(box.root), before);
  }
});

test("a profile-directory escape through a junction/symlink is refused", (t) => {
  const box = sandbox(t);
  const external = join(box.root, "external");
  mkdirSync(external);
  writeFileSync(join(external, "config.yaml"), "human: true\n");
  mkdirSync(join(box.hostHome, "profiles"));
  if (!directoryLink(t, external, join(box.hostHome, "profiles", "coder"))) return;
  writeFileSync(join(box.hostHome, "active_profile"), "coder");
  assert.throws(() => resolveHostHome({ harness: "hermes", userHome: box.home, env: box.env }), /escapes|symlink/);
});

test("all named hosts and custom have one resolver; trusted environment roots cannot leak from real user homes", (t) => {
  const box = sandbox(t);
  const roots = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "OPENCODE_CONFIG_DIR", omp: "OMP_CONFIG_DIR", openclaw: "OPENCLAW_STATE_DIR" };
  for (const [harness, variable] of Object.entries(roots)) {
    const chosen = join(box.home, `selected-${harness}`);
    assert.deepEqual(resolveHostHome({ harness, userHome: box.home, env: { ...box.env, [variable]: chosen } }), { path: chosen, source: `env:${variable}` });
    assert.notEqual(resolveHostHome({ harness, userHome: box.home, env: { ...box.env, [variable]: join(box.root, "real-user") } }).path, join(box.root, "real-user"));
  }
  assert.equal(resolveHostHome({ harness: "custom", userHome: box.home, env: box.env }).path, join(box.home, ".nullform", "custom"));
  assert.equal(resolveHostHome({ harness: "omp", userHome: box.home, env: { ...box.env, OMP_CONFIG_DIR: "" } }).path, join(box.home, ".omp", "agent"));
  for (const harness of ["cursor", "openhuman"]) assert.equal(resolveHostHome({ harness, userHome: box.home, env: box.env }).path, join(box.home, `.${harness}`));
});

test("overridden child HOME/USERPROFILE cannot authorize sibling ambient roots for any shared host resolver", (t) => {
  const box = sandbox(t);
  const outside = join(box.root, "sibling-profile");
  mkdirSync(outside);
  const roots = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "OPENCODE_CONFIG_DIR", omp: "OMP_CONFIG_DIR", openclaw: "OPENCLAW_STATE_DIR", hermes: "HERMES_HOME" };
  const env = { ...box.env, LOCALAPPDATA: outside, XDG_CONFIG_HOME: outside, HERMES_SUPERVISED_CHILD: "1" };
  for (const variable of Object.values(roots)) env[variable] = outside;
  const script = `
    import { homedir, userInfo } from "node:os";
    import { join } from "node:path";
    import { resolveHostHome } from ${JSON.stringify(new URL("../harness-profiles.mjs", import.meta.url).href)};
    const roots = ${JSON.stringify(roots)};
    const home = process.env.HOME;
    const outside = process.env.HERMES_HOME;
    let accountHome = null;
    try { accountHome = userInfo().homedir; } catch {}
    const ambient = {}, contained = {}, explicit = {};
    for (const [harness, variable] of Object.entries(roots)) {
      ambient[harness] = resolveHostHome({ harness, userHome: home, env: process.env });
      contained[harness] = resolveHostHome({ harness, userHome: home, env: { ...process.env, [variable]: join(home, harness) } });
      explicit[harness] = resolveHostHome({ harness, userHome: home, hostHome: outside, env: process.env });
    }
    const normal = accountHome ? resolveHostHome({ harness: "hermes", userHome: accountHome, env: process.env }) : null;
    console.log(JSON.stringify({ environmentHome: homedir(), ambient, contained, explicit, normal }));
  `;
  const before = snapshot(box.root);
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: box.projectRoot, env, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.environmentHome, box.home);
  const defaults = { claude: ".claude", codex: ".codex", opencode: ".config/opencode", omp: ".omp/agent", openclaw: ".openclaw", hermes: process.platform === "win32" ? "AppData/Local/hermes" : ".hermes" };
  for (const [harness, destination] of Object.entries(defaults)) {
    assert.equal(report.ambient[harness].path, join(box.home, destination));
    assert.equal(report.contained[harness].path, join(box.home, harness));
    assert.equal(report.contained[harness].source, `env:${roots[harness]}`);
    assert.deepEqual(report.explicit[harness], { path: outside, source: "explicit" });
  }
  if (report.normal) assert.deepEqual(report.normal, { path: outside, source: "env:HERMES_HOME" });
  assert.deepEqual(snapshot(box.root), before);
});

test("strict schema1 manifests normalize declarative data and reject unsafe fields or destinations", () => {
  const valid = manifest("my-host", { taskState: "available", delegation: "unknown" }, { displayName: " My Host ", instructionsFile: ".my-host/AGENTS.md" });
  const normalized = validateHostManifest(valid, { custom: true });
  assert.equal(normalized.displayName, "My Host");
  assert.deepEqual(normalized.capabilities, { taskState: "available", delegation: "unknown" });
  normalized.capabilities.taskState = "unavailable";
  assert.equal(valid.capabilities.taskState, "available");
  const invalid = [
    null, [], { ...valid, schemaVersion: 2 }, { ...valid, id: "a".repeat(65) }, { ...valid, id: "../host" },
    { ...valid, displayName: "a".repeat(121) }, { ...valid, displayName: "host\ncommand" },
    { ...valid, command: "echo forbidden" }, { ...valid, probe: ["arbitrary"] },
    { ...valid, capabilities: [] }, { ...valid, capabilities: { taskState: true } },
    { ...valid, capabilities: { taskState: "enabled" } }, { ...valid, capabilities: { unknownCapability: "available" } },
    JSON.parse('{"schemaVersion":1,"id":"host","instructionsFile":"AGENTS.md","capabilities":{},"__proto__":{}}'),
  ];
  for (const value of invalid) assert.throws(() => validateHostManifest(value, { custom: true }), /Invalid/);
  for (const path of [undefined, "", "../AGENTS.md", "sub/../../AGENTS.md", "/AGENTS.md", "C:/AGENTS.md", "a\\AGENTS.md", "a.md:stream", "a\u0000.md", "a//AGENTS.md", "./AGENTS.md", ".git/AGENTS.md", "node_modules/host/AGENTS.md", "SOUL.md", ".ssh/AGENTS.md", "NUL.md", "con/AGENTS.md", "folder./AGENTS.md", "a%2f..%2fAGENTS.md", "config.json", "instruction.sh"]) {
    assert.throws(() => validateHostManifest({ ...valid, instructionsFile: path }, { custom: true }), /instructionsFile/);
  }
});

test("custom inspection validates project confinement and prerequisites before any profile write", (t) => {
  const box = sandbox(t);
  const hostManifest = manifest("my-host", { delegation: "available" }, { instructionsFile: ".my-host/AGENTS.md" });
  const args = { harness: "custom", userHome: box.home, projectRoot: box.projectRoot, env: box.env, hostManifest };
  const before = snapshot(box.root);
  const report = inspectHarness(args);
  assert.equal(report.modules.delegation.decision, "reuse");
  assert.equal(report.capabilities.delegation.evidence, "declared");
  assert.equal(report.runtimeReady.status, "not-verified");
  assert.deepEqual(snapshot(box.root), before);
  assert.throws(() => inspectHarness({ ...args, projectRoot: undefined }), /projectRoot/);
  assert.throws(() => inspectHarness({ ...args, hostManifest: undefined }), /manifest/);
  assert.throws(() => inspectHarness({ ...args, hostManifest: { ...hostManifest, command: "unsafe" } }), /Invalid/);
  if (!directoryLink(t, box.hostHome, join(box.projectRoot, ".my-host"))) return;
  const linkedBefore = snapshot(box.root);
  assert.throws(() => inspectHarness(args), /escapes/);
  assert.deepEqual(snapshot(box.root), linkedBefore);
});

test("native reuse, explicit gaps and unknown evidence produce different actionable decisions without readiness claims", (t) => {
  const box = sandbox(t);
  const inspect = (capabilities, env = box.env) => inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, hostManifest: manifest("hermes", capabilities), env });
  const native = inspect({ taskState: "available", delegation: "available", worktree: "available", verification: "available" });
  for (const name of ["taskState", "delegation", "worktree", "verification"]) {
    assert.equal(native.modules[name].decision, "reuse");
    assert.equal(native.modules[name].evidence, "declared");
  }
  assert.equal(native.runtimeReady.status, "not-verified");
  const gap = inspect({ taskState: "unavailable", delegation: "unavailable", worktree: "unavailable", verification: "unavailable" });
  assert.equal(gap.modules.taskState.decision, "enable");
  const actions = gap.modules.taskState.actions.map((action) => action.split(" "));
  assert.deepEqual(actions.map((args) => args[2]), ["start", "start", "artifact", "check", "close"]);
  assert.deepEqual(actions.filter((args) => args[2] === "start").map((args) => args[args.indexOf("--tier") + 1]), ["T0", "T1"]);
  const artifact = actions.find((args) => args[2] === "artifact");
  assert.equal(artifact[artifact.indexOf("--kind") + 1], "recon");
  assert.equal(gap.modules.delegation.decision, "manual");
  assert.equal(gap.modules.verification.decision, "enable");
  assert.equal(gap.modules.worktree.decision, "manual");
  const git = join(box.bin, process.platform === "win32" ? "git.exe" : "git");
  writeFileSync(git, "fixture PATH entry; never executed");
  chmodSync(git, 0o755);
  const withGit = inspect({ worktree: "unavailable" });
  assert.equal(withGit.modules.worktree.decision, "enable");
  assert.deepEqual(withGit.modules.worktree.actions.map((action) => action.split(" ")[2]), ["workspace", "integrate"]);
  const unknown = inspect({ taskState: "unknown", delegation: "unknown", worktree: "unknown", verification: "unknown" });
  for (const name of ["taskState", "delegation", "worktree"]) {
    assert.equal(unknown.modules[name].decision, "manual");
    assert.equal(unknown.capabilities[name].evidence, "declared");
  }
  assert.equal(unknown.modules.verification.decision, "enable");
  assert.equal(unknown.modules.mcp.decision, "skip");
  assert.deepEqual(unknown.probe.commands, []);
});

test("Hermes ignore-rules truthiness uses the native exact boolean vocabulary", (t) => {
  const box = sandbox(t);
  for (const value of ["1", " true ", "YES", "on", "0", "false", "no", "off", "anything", ""]) {
    const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, hostManifest: manifest("hermes", { skills: "available" }), env: { ...box.env, HERMES_IGNORE_RULES: value } });
    const disabled = ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    assert.equal(report.capabilities.skills.status, disabled ? "unavailable" : "available");
    assert.equal(report.capabilities.skills.evidence, disabled ? "configured" : "declared");
    assert.equal(report.modules.skills.decision, disabled ? "manual" : "reuse");
  }
});

test("capability inventory keeps custom declaration separate from eight named adapters and native review", (t) => {
  const box = sandbox(t);
  const report = getCapabilitiesInfo({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env });
  assert.deepEqual(report.configurationAdapters, ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman"]);
  assert.equal(report.customHostContract.supported, true);
  assert.equal(report.customHostContract.executableCommands, false);
  assert.deepEqual(report.automatedReview.supportedHarnesses, ["omp"]);
  assert.equal(report.automatedReview.requiresBun, true);
  assert.equal(report.profile.hostHome, box.hostHome);
  assert.equal(report.profile.runtimeReady.status, "not-verified");
});

test("missing probe executables and Windows batch wrappers are explicit unavailable outcomes, not fake capability proof", (t) => {
  const box = sandbox(t);
  const args = { harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env, probe: true };
  const missing = inspectHarness(args);
  assert.deepEqual(missing.probe.commands.map((entry) => entry.status), ["unavailable", "unavailable", "unavailable"]);
  assert.equal(missing.capabilities.taskState.status, "unknown");
  assert.throws(() => inspectHarness({ ...args, harness: "codex" }), /only for Hermes/);
  const marker = join(box.root, "wrapper-executed");
  writeFileSync(join(box.bin, "hermes.cmd"), `@echo leaked > "${marker}"\r\n`);
  const batch = inspectHarness({ ...args, platform: "win32" });
  assert.deepEqual(batch.probe.commands.map((entry) => entry.status), ["unavailable", "unavailable", "unavailable"]);
  assert.equal(existsSync(marker), false);
});

// This is an executable fixture of the pinned CLI text protocol, not Hermes or
// a native-session acceptance claim. Windows cannot execute shebang files.
function probeFixture(box, output) {
  const script = `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(join(box.root, "probe-calls.jsonl"))}, JSON.stringify({args: process.argv.slice(2), home: process.env.HERMES_HOME, supervised: process.env.HERMES_SUPERVISED_CHILD}) + '\\n');\nif (process.argv[2] === '--version') console.log('hermes 1.2.3');\nelse if (process.argv[2] === 'config') console.log(require('node:path').join(process.env.HERMES_HOME, 'config.yaml'));\nelse process.stdout.write(${JSON.stringify(output)});\n`;
  writeFileSync(join(box.bin, "hermes"), script);
  chmodSync(join(box.bin, "hermes"), 0o755);
}

// This is a POSIX-only probe-env test: Windows cannot execute the shebang fixture.
function probeLocalAppDataFixture(box) {
  const seenPath = join(box.root, "probe-localappdata.jsonl");
  const script = `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(seenPath)}, JSON.stringify({localappdata: process.env.LOCALAPPDATA || null}) + '\\n');\nif (process.argv[2] === '--version') console.log('hermes 1.2.3');\nelse if (process.argv[2] === 'config') console.log(require('node:path').join(process.env.HERMES_HOME, 'config.yaml'));\nelse console.log('Built-in toolsets (cli):\\n  \\u2713 enabled  kanban  Kanban');\n`;
  writeFileSync(join(box.bin, "hermes"), script);
  chmodSync(join(box.bin, "hermes"), 0o755);
  return seenPath;
}


test("explicit probe accepts only pinned built-in CLI rows and never equates todo, plugin or MCP entries with native task state", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox(t);
  probeFixture(box, ["Built-in toolsets (cli):", "  \u001b[32m✓ enabled\u001b[0m  todo  Task Planning", "  ✗ disabled  kanban  Kanban", "  ✓ enabled  delegation  Task Delegation", "  ✓ enabled  terminal  Terminal & Processes", "  ✗ disabled  skills  Skills", "", "Plugin toolsets (cli):", "  ✓ enabled  kanban  Plugin cannot enable native board", "", "MCP servers:", "  ✓ enabled  kanban  secret-provider-details-do-not-retain"].join("\n"));
  const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env, probe: true });
  assert.deepEqual(report.probe.commands.map((entry) => entry.status), ["observed", "observed", "observed"]);
  assert.deepEqual(report.probe.commands[2].toolsets, { kanban: "unavailable", delegation: "available", terminal: "available", skills: "unavailable" });
  assert.deepEqual([report.capabilities.taskState.status, report.capabilities.taskState.evidence, report.modules.taskState.decision], ["unavailable", "configured", "enable"]);
  assert.equal(report.modules.delegation.decision, "reuse");
  assert.equal(report.modules.skills.decision, "manual");
  assert.equal(report.capabilities.worktree.status, "unknown");
  assert.equal(report.capabilities.verification.status, "unknown");
  assert.equal(report.runtimeReady.status, "not-verified");
  assert.equal(JSON.stringify(report).includes("secret-provider-details"), false);
  const calls = readFileSync(join(box.root, "probe-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["config", "path"], ["tools", "list", "--platform", "cli"]]);
  assert.equal(calls.every((call) => call.home === box.hostHome && call.supervised === "1"), true);
});

test("malformed/native-version-mismatched probe formats and free-form identifiers stay unknown with no raw output retention", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox(t);
  const fixtures = [
    "kanban delegation terminal secret-token-do-not-retain",
    'problem: {"platform":"cli","tools":["kanban"]}',
    "Built-in toolsets (gateway):\n  ✓ enabled  kanban  Kanban",
    "Built-in toolsets (cli):\n  ✓ enabled  kanban  Kanban\n  ✗ disabled  kanban  Conflicting",
    "Built-in toolsets (cli):\n  ✓ enabled kanban Kanban",
    "Plugin toolsets (cli):\n  ✓ enabled  kanban  Kanban",
  ];
  for (const output of fixtures) {
    probeFixture(box, output);
    const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env, probe: true });
    assert.equal(report.probe.commands[2].status, "unrecognized");
    assert.equal(report.capabilities.taskState.status, "unknown");
    assert.equal(report.modules.taskState.decision, "manual");
    assert.equal(JSON.stringify(report).includes("secret-token"), false);
  }
});

test("a valid native listing cannot establish selected-profile capabilities when config path disagrees", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox(t);
  const script = `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('hermes 1.2.3');\nelse if (process.argv[2] === 'config') console.log(${JSON.stringify(join(box.root, "other-profile", "config.yaml"))});\nelse console.log('Built-in toolsets (cli):\\n  ✓ enabled  kanban  Kanban');\n`;
  writeFileSync(join(box.bin, "hermes"), script);
  chmodSync(join(box.bin, "hermes"), 0o755);
  const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env, probe: true });
  assert.equal(report.probe.commands[1].status, "unrecognized");
  assert.equal(report.probe.commands[2].status, "observed");
  assert.equal(report.capabilities.taskState.status, "unknown");
  assert.equal(report.capabilities.taskState.evidence, "documented");
});

test("probe output overflow fails explicitly without retaining output or treating it as capability evidence", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox(t);
  probeFixture(box, "secret-output-do-not-retain".repeat(3000));
  const report = inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: box.env, probe: true });
  assert.equal(report.probe.commands[2].status, "failed");
  assert.equal(report.capabilities.taskState.status, "unknown");
  assert.equal(JSON.stringify(report).includes("secret-output"), false);
});

test("probe LOCALAPPDATA keeps inside-home values and falls back for outside values", { skip: process.platform === "win32" }, (t) => {
  const box = sandbox(t);
  const seenPath = probeLocalAppDataFixture(box);
  const inside = join(box.home, "AppData", "Local");
  inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: { ...box.env, LOCALAPPDATA: inside }, probe: true });
  const first = JSON.parse(readFileSync(seenPath, "utf8").trim().split("\n").at(-1));
  assert.equal(first.localappdata, inside);
  rmSync(seenPath, { force: true });
  const outside = join(box.root, "foreign-localappdata");
  inspectHarness({ harness: "hermes", userHome: box.home, hostHome: box.hostHome, env: { ...box.env, LOCALAPPDATA: outside }, probe: true });
  const second = JSON.parse(readFileSync(seenPath, "utf8").trim().split("\n").at(-1));
  assert.equal(second.localappdata, join(box.home, "AppData", "Local"));
});
