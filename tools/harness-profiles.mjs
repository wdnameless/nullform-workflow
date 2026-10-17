/** Read-only host routing, declarative capability evidence, and adaptive module decisions. */
import { accessSync, constants, fstatSync, lstatSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { isInsideOrEqual, validatePathWithinScope, validateRootPath } from "./worktree-snapshot.mjs";

const HOSTS = ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman"];
const CAPABILITIES = ["taskState", "delegation", "worktree", "terminal", "browser", "skills", "verification", "mcp"];
const STATUSES = new Set(["available", "unavailable", "unknown"]);
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HERMES_SOURCE = "https://github.com/NousResearch/hermes-agent/blob/3b2f971133e4e011022ccf33dc6dc1c9050563d8/";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function present(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot inspect selected profile metadata");
  }
}

function requireHost(harness) {
  if (!HOSTS.includes(harness) && harness !== "custom") throw new Error("Unsupported harness");
}

function safePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 4096 || CONTROLS.test(value) || value.startsWith("-")) {
    throw new Error(`Invalid ${label}`);
  }
  return resolve(value);
}

// Read only bounded regular metadata files; never follow a profile-marker symlink.
function readMarker(file) {
  let info;
  try { info = lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read active_profile metadata");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw new Error("Invalid active_profile metadata");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 128) throw new Error("Invalid active_profile metadata");
    const buffer = Buffer.alloc(129);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 128) throw new Error("Invalid active_profile metadata");
    return buffer.subarray(0, size).toString("utf8").trim();
  } finally { closeSync(fd); }
}

/** Explicit selection wins; ambient roots outside an isolated userHome are ignored. */
export function resolveHostHome({ harness, userHome = homedir(), hostHome, env = process.env, platform = process.platform } = {}) {
  requireHost(harness);
  const home = safePath(userHome, "userHome");
  if (hostHome !== undefined && hostHome !== null) {
    const path = safePath(hostHome, "hostHome");
    validateRootPath(path);
    return { path, source: "explicit" };
  }
  // homedir() follows HOME/USERPROFILE, including sandbox overrides. Only the
  // OS account identity can authorize ambient roots outside the selected home.
  let accountHome = null;
  try {
    const candidate = userInfo().homedir;
    if (typeof candidate === "string" && isAbsolute(candidate)) accountHome = safePath(candidate, "OS account home");
  } catch {}
  const isolated = !accountHome || !isInsideOrEqual(home, accountHome) || !isInsideOrEqual(accountHome, home);
  const trusted = (name) => {
    if (!env[name]) return null;
    const path = safePath(env[name], name);
    return !isolated || isInsideOrEqual(home, path) ? path : null;
  };
  const envRoots = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "OPENCODE_CONFIG_DIR", omp: "OMP_CONFIG_DIR", openclaw: "OPENCLAW_STATE_DIR", hermes: "HERMES_HOME" };
  const envRoot = envRoots[harness] && trusted(envRoots[harness]);
  if (envRoot) {
    validateRootPath(envRoot);
    if (isolated && !validatePathWithinScope(envRoot, home)) throw new Error("Host environment root escapes isolated userHome");
    if (harness !== "hermes") return { path: envRoot, source: `env:${envRoots[harness]}` };
  }
  let path;
  let source = envRoot ? `env:${envRoots[harness]}` : "default";
  if (harness === "hermes") {
    const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
    if (typeof suffix !== "string" || !/^[a-zA-Z0-9_.-]{0,64}$/.test(suffix) || suffix.includes("..") || suffix.endsWith(".")) throw new Error("Invalid HERMES_DATA_DIR_SUFFIX");
    const nativeRoot = platform === "win32" ? join(trusted("LOCALAPPDATA") || join(home, "AppData", "Local"), `hermes${suffix}`) : join(home, `.hermes${suffix}`);
    path = envRoot || nativeRoot;
    if (!envRoot) source = platform === "win32" ? "default:LOCALAPPDATA/hermes" : "default:~/.hermes";
    validateRootPath(path);
    if (isolated && !validatePathWithinScope(path, home)) throw new Error("Hermes root escapes isolated userHome");
    if (basename(dirname(path)) === "profiles") {
      if (!PROFILE_NAME.test(basename(path))) throw new Error("Invalid Hermes profile name");
      return { path, source };
    }
    const supervised = env.HERMES_SUPERVISED_CHILD || env.HERMES_S6_SUPERVISED_CHILD || truthy(env.HERMES_GATEWAY_EXTERNAL_SUPERVISOR);
    if (!supervised) {
      const root = isInsideOrEqual(nativeRoot, path) ? nativeRoot : path;
      validateRootPath(root);
      const markerPath = join(root, "active_profile");
      if (!validatePathWithinScope(markerPath, root)) throw new Error("active_profile escapes Hermes home");
      const profile = readMarker(markerPath);
      if (profile) {
        if (!PROFILE_NAME.test(profile)) throw new Error("Invalid active_profile name");
        if (profile !== "default") {
          const selected = join(root, "profiles", profile);
          if (!validatePathWithinScope(selected, root)) throw new Error("active_profile escapes Hermes home");
          validateRootPath(selected);
          const identity = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"].some((name) => {
            const entry = present(join(selected, name));
            return entry && (entry.isFile() || entry.isSymbolicLink());
          });
          if (!present(selected)?.isDirectory() || !identity || present(join(root, "profiles", ".deleted", profile))) throw new Error("Selected active_profile is missing, deleted or lacks native profile identity");
          path = selected;
          source += ":active_profile";
        }
      }
    }
  } else if (harness === "opencode") {
    const configHome = trusted("XDG_CONFIG_HOME") || join(home, ".config");
    path = join(configHome, "opencode");
    if (configHome !== join(home, ".config")) source = "env:XDG_CONFIG_HOME";
  } else {
    path = join(home, harness === "omp" ? ".omp/agent" : harness === "custom" ? ".nullform/custom" : `.${harness}`);
  }
  validateRootPath(path);
  if (isolated && !validatePathWithinScope(path, home)) throw new Error("Default host root escapes isolated userHome");
  return { path, source };
}

function record(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) {
      throw new Error(`Invalid ${label}: unknown or non-declarative field`);
    }
  }
}

function instructionPath(value) {
  if (typeof value !== "string" || !value || value.length > 256 || CONTROLS.test(value) || /[\\:]/.test(value) || isAbsolute(value)) {
    throw new Error("Invalid instructionsFile: expected a safe project-relative Markdown destination");
  }
  const segments = value.split("/");
  const reserved = /^(?:\.git|\.hg|\.svn|\.ssh|\.gnupg|\.aws|\.azure|node_modules|\.nullform|\.workflow|\.env.*|auth(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|SOUL\.md|USER\.md|ACCESS_POLICY\.md|HEARTBEAT\.md)$/i;
  if (segments.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === ".." || /[. ]$/.test(part) || reserved.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) || !/\.(?:md|mdc)$/i.test(segments.at(-1))) {
    throw new Error("Invalid instructionsFile: reserved or unsafe destination");
  }
  return value;
}

/** A manifest is data, never executable discovery or a runtime-readiness claim. */
export function validateHostManifest(value, { custom = false } = {}) {
  record(value, ["schemaVersion", "id", "displayName", "instructionsFile", "capabilities"], "host manifest");
  if (value.schemaVersion !== 1) throw new Error("Invalid host manifest schemaVersion: expected 1");
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || ["constructor", "prototype"].includes(value.id)) throw new Error("Invalid host manifest id");
  const out = { schemaVersion: 1, id: value.id };
  if (Object.hasOwn(value, "displayName")) {
    if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 120 || CONTROLS.test(value.displayName)) throw new Error("Invalid host manifest displayName");
    out.displayName = value.displayName.trim();
  }
  if (custom || Object.hasOwn(value, "instructionsFile")) out.instructionsFile = instructionPath(value.instructionsFile);
  record(value.capabilities, CAPABILITIES, "host manifest capabilities");
  out.capabilities = {};
  for (const capability of CAPABILITIES) {
    if (!Object.hasOwn(value.capabilities, capability)) continue;
    if (!STATUSES.has(value.capabilities[capability])) throw new Error("Invalid host manifest capability status");
    out.capabilities[capability] = value.capabilities[capability];
  }
  return out;
}

// PATH inspection does not execute a host, Git, a shell, or an authentication check.
function commandPath(command, env, platform) {
  const directories = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of directories) {
    if (!isAbsolute(directory) || CONTROLS.test(directory)) continue;
    for (const extension of extensions) {
      const file = join(directory, command + extension);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

function decideModules(capabilities, gitPresent) {
  const modules = {};
  for (const [name, capability] of Object.entries(capabilities)) {
    const available = capability.status === "available" && ["declared", "configured"].includes(capability.evidence);
    let decision = "manual";
    let reason;
    let actions = [];
    if (name === "mcp") {
      decision = "skip";
      reason = "Preserve existing host MCP services; Nullform does not install or activate a server from capability evidence.";
    } else if (available) {
      decision = "reuse";
      reason = `Reuse the host's ${name} only when actually exposed in the session, within its permissions; ${capability.evidence} evidence is not execution proof.`;
      if (name === "taskState") actions = ["Use the native durable task tracker when available; do not create parallel Nullform task state or force start/check/close."];
      if (name === "delegation") actions = ["Dispatch through the host's native delegation mechanism with scoped requirements, constraints, verification criteria and a verifiable return contract; do not assume child context or worktree inheritance."];
      if (name === "worktree") actions = ["Use the native workspace mechanism only after checking filesystem/Git isolation; isolated agent context is not a worktree."];
    } else if (name === "verification") {
      decision = "enable";
      reason = "Use lightweight actual-result verification and truthful completion; no new framework or mandatory coding specification for routine/general tasks.";
      actions = ["Exercise the changed behavior or validate the requested artifact against its requirements. Report observed results and unverified limits; do not infer success from configuration."];
    } else if (name === "taskState" && capability.status === "unavailable") {
      decision = "enable";
      reason = "Native durable task state is explicitly unavailable. Opt into portable state only for matching bounded tasks: choose T0 for truly trivial 1–2 known-file edits or T1 for bounded work needing reconnaissance, then record recon for T1. Routine/general requests do not acquire mandatory state. T2/T3 recorded automated acceptance remains OMP/Bun-only; outside that route review/acceptance is manual, not a portable automated fallback. Never down-classify architecture to pass these gates.";
      actions = [
        'nullform workflow start --tier T0 --task "<trivial bounded task>"',
        'nullform workflow start --tier T1 --task "<bounded task needing reconnaissance>"',
        'nullform workflow artifact --kind recon --detail "Files touched: <paths>; acceptance check: <scenario and observed result>"',
        "nullform workflow check",
        "nullform workflow close",
      ];
    } else if (name === "delegation" && capability.status === "unavailable") {
      reason = "Native delegation is explicitly unavailable; use single-agent execution or an explicit operator handoff, never invent a callable agent tool.";
      actions = ["Execute in one agent, or hand off scoped requirements, constraints, owned files and verification criteria; require a verifiable result/return contract."];
    } else if (name === "worktree" && capability.status === "unavailable") {
      decision = gitPresent ? "enable" : "manual";
      reason = gitPresent ? "Git is present in PATH (not executed). Portable workspace/integrate require a committed integration base, one writer per workspace and a clean integration target." : "Portable workspaces require Git in PATH, a committed base and a clean integration target; install/configure Git explicitly before use.";
      actions = gitPresent ? ["nullform workflow workspace --feature SLUG --root PROJECT", "nullform workflow integrate --feature SLUG --root PROJECT"] : ["Provide Git explicitly; no automatic dependency installation."];
    } else if (["taskState", "delegation", "worktree"].includes(name)) {
      reason = `Native ${name} availability is unknown. Retain conditional native guidance; supply a validated capability declaration or an explicit bounded probe where supported, or opt into portable tools. Do not activate speculative state or services.`;
      actions = ["Provide a schema1 host manifest with capability evidence before selecting native reuse or an explicit gap action."];
    } else {
      reason = `Native ${name} is ${capability.status}; use an existing session tool if exposed or provide the prerequisite explicitly. Do not install a tool, browser, skill registry or service automatically.`;
    }
    modules[name] = { decision, evidence: capability.evidence, reason, actions };
  }
  return modules;
}

const HERMES_TOOLSETS = { taskState: "kanban", delegation: "delegation", terminal: "terminal", browser: "browser", skills: "skills" };

// Pinned _print_tools_list grammar. Only built-in CLI rows establish native
// configuration; plugin/MCP entries and free-form log identifiers never do.
function parseHermesToolsets(output) {
  const lines = output.split(/\r?\n/);
  if (lines.shift() !== "Built-in toolsets (cli):") return null;
  const found = {};
  const seen = new Set();
  let section = "builtin";
  let rows = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line === "Plugin toolsets (cli):" && section === "builtin") { section = "plugin"; continue; }
    if (line === "MCP servers:") { section = "mcp"; break; }
    const match = line.match(/^  (✓ enabled|✗ disabled)  ([a-z][a-z0-9_]{0,63})  (.{1,256})$/u);
    if (!match || CONTROLS.test(match[3]) || ++rows > 256) return null;
    if (section !== "builtin") continue;
    if (seen.has(match[2])) return null;
    seen.add(match[2]);
    if (Object.values(HERMES_TOOLSETS).includes(match[2])) found[match[2]] = match[1] === "✓ enabled" ? "available" : "unavailable";
  }
  return seen.size ? found : null;
}

function hermesProbe({ executable, userHome, hostHome, env }) {
  const commands = [];
  for (const args of [["--version"], ["config", "path"], ["tools", "list", "--platform", "cli"]]) {
    const entry = { command: "hermes", args, status: "unavailable" };
    commands.push(entry);
    if (!executable || /\.(?:cmd|bat)$/i.test(executable)) {
      entry.reason = executable ? "Batch wrapper requires a shell; shell execution is not permitted." : "Hermes executable not found in PATH.";
      continue;
    }
    const result = spawnSync(executable, args, {
      cwd: hostHome, env: {
        ...env, HOME: userHome, USERPROFILE: userHome, NULLFORM_USER_HOME: userHome,
        LOCALAPPDATA: env.LOCALAPPDATA && isInsideOrEqual(userHome, env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(userHome, "AppData", "Local"),
        HERMES_HOME: hostHome, HERMES_SUPERVISED_CHILD: "1",
      },
      encoding: "utf8", shell: false, timeout: 3000, maxBuffer: 32768, windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.signal) {
      entry.status = "failed";
      entry.reason = result.error?.code === "ETIMEDOUT" ? "Probe timed out after 3000ms." : result.error?.code === "ENOBUFS" ? "Probe output exceeded 32768 bytes." : "Probe process failed; raw output withheld.";
      continue;
    }
    const output = stripVTControlCharacters(result.stdout).trim();
    entry.status = "unrecognized";
    entry.reason = "Output did not match the bounded nonsecret consumer format; raw output withheld.";
    if (args[0] === "--version") {
      // Real `hermes --version` is multi-line (version + install/python/sdk rows).
      // Accept the version from the first non-empty line only; never retain other rows.
      const firstLine = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
      const match = firstLine.match(/^(?:hermes(?:-agent|\s+agent)?\s+(?:version\s+)?v?)?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][a-zA-Z0-9.-]{1,64})?)(?:\s+\(.*\))?$/i);
      if (match) { entry.status = "observed"; entry.version = match[1]; delete entry.reason; }
    } else if (args[0] === "config") {
      if (!CONTROLS.test(output) && output === join(hostHome, "config.yaml")) {
        entry.status = "observed"; entry.path = output; delete entry.reason;
      }
    } else {
      const toolsets = parseHermesToolsets(output);
      if (toolsets) {
        entry.status = "observed"; entry.toolsets = toolsets; delete entry.reason;
      }
    }
  }
  return { requested: true, commands, timeoutMs: 3000, maxOutputBytes: 32768 };
}

/** Default inspection is read-only metadata/PATH inspection, never inference or host execution. */
export function inspectHarness({ harness, userHome = homedir(), hostHome, hostManifest, projectRoot, env = process.env, platform = process.platform, probe = false } = {}) {
  requireHost(harness);
  if (typeof probe !== "boolean") throw new Error("probe must be a boolean");
  if (probe && harness !== "hermes") throw new Error("Bounded probing is supported only for Hermes");
  const manifest = hostManifest === undefined || hostManifest === null ? null : validateHostManifest(hostManifest, { custom: harness === "custom" });
  if (harness === "custom" && (!manifest || !projectRoot)) throw new Error("Custom harness requires a host manifest and projectRoot");
  if (manifest && harness !== "custom" && manifest.id !== harness) throw new Error("Host manifest id must match the named harness");
  if (harness === "custom") {
    const project = safePath(projectRoot, "projectRoot");
    validateRootPath(project);
    const destination = join(project, manifest.instructionsFile);
    if (!validatePathWithinScope(destination, project)) throw new Error("instructionsFile escapes projectRoot");
    try {
      const entry = lstatSync(destination);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("instructionsFile must be a regular file, not a symlink or directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const selected = resolveHostHome({ harness, userHome, hostHome, env, platform });
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, {
    status: manifest?.capabilities[name] ?? "unknown",
    evidence: manifest && Object.hasOwn(manifest.capabilities, name) ? "declared" : "unknown",
    reason: manifest && Object.hasOwn(manifest.capabilities, name) ? "Operator declaration; not a runtime tool/authentication/funding check." : "No configured or declared evidence for this selected profile; binary presence does not establish session capability.",
  }]));
  if (harness === "hermes") {
    for (const [name, toolset] of Object.entries(HERMES_TOOLSETS)) {
      if (capabilities[name].evidence === "unknown") capabilities[name] = {
        status: "unknown", evidence: "documented",
        reason: `Pinned native ${toolset} toolset exists; selected-profile/session availability remains unknown (${HERMES_SOURCE}hermes_cli/tools_config.py).`,
      };
    }
  }
  const limitations = [
    "The inspector does not open credential files or invoke model inference, authentication/funding checks or native tasks.",
    "Documented APIs, declared capabilities, PATH entries and configured tools are not active-session/runtime proof; unknown is not absence.",
    "No dependencies, MCP servers, browsers, skills or task services are installed or activated by inspection.",
  ];
  if (harness !== "omp") limitations.push("T0/T1 portable state is available only for tasks that genuinely fit those lanes. T2/T3 recorded automated review/acceptance requires OMP with Bun; manual review outside that route does not satisfy its automated gates. Never down-classify architecture or claim non-OMP automated acceptance.");
  if (harness === "custom") limitations.push("A custom contract declares a project instruction destination; writing that file cannot prove the unknown host loads it.");
  if (harness === "hermes") limitations.push("Hermes policy loading uses skills.auto_load, conditional on skills tools and HERMES_IGNORE_RULES. Home AGENTS.md is not a global loader; native delegated children may skip context/skills, so parents must pass scoped requirements and verification criteria.");
  if (["cursor", "openhuman", "openclaw"].includes(harness)) limitations.push("Uncertain host root/workspace conventions require explicit hostHome; the default is a deployment convention, not runtime discovery.");
  let probeReport = { requested: false, commands: [] };
  if (probe) {
    limitations.push("Explicit host probes may trigger native/plugin bootstrap side effects, including native configuration/credential reads. Only version/path/tool-list commands are allowed; output is bounded and raw output is withheld. The selected home is pinned against sticky-profile redirection.");
    probeReport = hermesProbe({ executable: commandPath("hermes", env, platform), userHome: resolve(userHome), hostHome: selected.path, env });
    const toolList = probeReport.commands.find((entry) => entry.args[0] === "tools" && entry.status === "observed");
    const pathObserved = probeReport.commands.some((entry) => entry.args[0] === "config" && entry.status === "observed");
    if (toolList && pathObserved) {
      for (const [name, toolset] of Object.entries(HERMES_TOOLSETS)) {
        if (toolList.toolsets[toolset]) capabilities[name] = { status: toolList.toolsets[toolset], evidence: "configured", reason: `Explicit built-in CLI ${toolset} toolset listing; configuration only, not backend invocation/authentication or session-policy proof.` };
      }
    }
  }
  if (harness === "hermes" && truthy(env.HERMES_IGNORE_RULES)) {
    capabilities.skills = { status: "unavailable", evidence: "configured", reason: "HERMES_IGNORE_RULES explicitly disables policy context/skill loading; do not re-enable human policy." };
  }
  const gitPresent = Boolean(commandPath("git", env, platform));
  return {
    schemaVersion: 1, harness, profileId: harness === "custom" ? `custom:${manifest.id}` : harness === "omp" ? "omp-native" : `${harness}-adaptive`,
    hostHome: selected.path, pathSource: selected.source, hostManifest: manifest,
    capabilities, modules: decideModules(capabilities, gitPresent),
    runtimeReady: { status: "not-verified", reason: "No native task execution, active session tool check, authentication or funding verification was performed." },
    prerequisites: { git: { present: gitPresent, evidence: "path-only" } }, probe: probeReport, limitations,
  };
}
