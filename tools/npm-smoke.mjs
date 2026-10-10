#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLocalRegistry } from "./tests/npm-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const HARNESS_CHOICES = ["claude", "codex", "opencode", "cursor", "omp", "openclaw", "hermes", "openhuman"];

function terminateChildTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

function spawnAsync(command, args = [], options = {}) {
  const { cwd = REPO_ROOT, env = process.env, input = "", timeoutMs = 120_000, tracker = null } = options;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    if (tracker) tracker.add(child);
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child);
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    const cleanupChild = () => {
      clearTimeout(timer);
      if (tracker) tracker.delete(child);
    };

    child.on("error", (err) => {
      cleanupChild();
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      cleanupChild();
      resolveRun({
        status: timedOut ? 124 : (code ?? 1),
        signal,
        timedOut,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

function resolveNpmInvocation(env = process.env) {
  const execDir = dirname(process.execPath);
  const candidates = [
    env.npm_execpath,
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(env.PATH || "").split(delimiter).filter(Boolean).flatMap((d) => [
      join(d, "node_modules", "npm", "bin", "npm-cli.js"),
      join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]),
  ];
  for (const c of candidates) {
    if (c && /\.[cm]?js$/i.test(c) && existsSync(c)) return { command: process.execPath, prefixArgs: [c] };
  }
  return process.platform === "win32"
    ? { command: env.ComSpec || "cmd.exe", prefixArgs: ["/d", "/c", "npm.cmd"] }
    : { command: "npm", prefixArgs: [] };
}

function getGlobalBinPath(prefixDir) {
  const candidates =
    process.platform === "win32"
      ? [join(prefixDir, "nullform.cmd"), join(prefixDir, "bin", "nullform.cmd")]
      : [join(prefixDir, "bin", "nullform"), join(prefixDir, "nullform")];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(full));
    else results.push(full);
  }
  return results.sort();
}

function createSmokeEnv(baseTemp) {
  const spaceBase = join(baseTemp, "isolated env");
  const tempHome = join(spaceBase, "home");
  const tempPrefix = join(spaceBase, "prefix");
  const tempCache = join(spaceBase, "cache");
  const tempPackDir = join(spaceBase, "pack");
  for (const dir of [tempHome, tempPrefix, tempCache, tempPackDir, join(tempPrefix, "bin")]) mkdirSync(dir, { recursive: true });

  const isolatedEnv = {
    ...process.env,
    HOME: tempHome, USERPROFILE: tempHome,
    APPDATA: join(tempHome, "AppData", "Roaming"), LOCALAPPDATA: join(tempHome, "AppData", "Local"),
    npm_config_prefix: tempPrefix, npm_config_cache: tempCache,
    NPM_CONFIG_PREFIX: tempPrefix, NPM_CONFIG_CACHE: tempCache,
    PATH: [tempPrefix, join(tempPrefix, "bin"), process.env.PATH || ""].join(delimiter),
  };
  for (const k of ["OMP_CONFIG_DIR", "HERMES_HOME", "OPENHUMAN_WORKSPACE", "OPENCLAW_CONFIG_PATH", "NULLFORM_RELEASE_URL", "NULLFORM_REGISTRY"]) {
    delete isolatedEnv[k];
  }

  const npmExec = resolveNpmInvocation(isolatedEnv);

  const activeChildren = new Set();

  return {
    baseTemp, spaceBase, tempHome, tempPrefix, tempCache, tempPackDir, isolatedEnv,
    activeChildren,
    spawnAsync: (cmd, args = [], opts = {}) => spawnAsync(cmd, args, { ...opts, tracker: activeChildren }),
    runNpm: (args, cwd = REPO_ROOT, extraEnv = {}, timeoutMs = 120_000) =>
      spawnAsync(npmExec.command, [...npmExec.prefixArgs, ...args], { cwd, env: { ...isolatedEnv, ...extraEnv }, timeoutMs, tracker: activeChildren }),
    runInstalledBin(args, options = {}) {
      const binPath = getGlobalBinPath(tempPrefix);
      assert.equal(existsSync(binPath), true, `Installed global bin missing at ${binPath}`);
      const env = { ...isolatedEnv, ...(options.extraEnv || {}) };
      const command = process.platform === "win32" ? env.ComSpec || "cmd.exe" : binPath;
      const fullArgs = process.platform === "win32" ? ["/d", "/c", "nullform.cmd", ...args] : args;
      return spawnAsync(command, fullArgs, { cwd: options.cwd || spaceBase, env, input: options.input ?? "", timeoutMs: options.timeoutMs ?? 60_000, tracker: activeChildren });
    },
    async dispose() {
      for (const child of activeChildren) terminateChildTree(child);
      await Promise.allSettled(
        Array.from(activeChildren).map((c) =>
          c.exitCode === null ? new Promise((r) => { c.once("close", r); setTimeout(r, 2000); }) : null
        )
      );
      activeChildren.clear();
    },
  };
}

function locateInstalledDependencyDir(depName) {
  const candidates = [join(REPO_ROOT, "node_modules", depName)];
  try {
    const req = createRequire(join(REPO_ROOT, "package.json"));
    candidates.push(dirname(req.resolve(`${depName}/package.json`)));
  } catch {}
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

async function prepareDependencyTarballs(ctx, registry, pkgJson) {
  const deps = pkgJson.dependencies || {};
  assert.equal(deps.json5, "2.2.3", "R01: package.json must pin json5@2.2.3");
  assert.equal(deps.yaml, "2.9.1", "R01: package.json must pin yaml@2.9.1");
  assert.equal(deps["jsonc-parser"], "3.3.1", "R01: package.json must pin jsonc-parser@3.3.1");

  await Promise.all(
    Object.entries(deps).map(async ([depName, depVersion]) => {
      const expectedFilename = `${depName.replace(/^@.*\//, "")}-${depVersion}.tgz`;
      const depTarballPath = join(ctx.tempPackDir, expectedFilename);
      const localDepDir = locateInstalledDependencyDir(depName);
      let depManifest = null;

      if (localDepDir) {
        const rawPkg = JSON.parse(readFileSync(join(localDepDir, "package.json"), "utf8"));
        assert.equal(rawPkg.name, depName, `Installed ${depName} package name mismatch`);
        assert.equal(rawPkg.version, depVersion, `Installed ${depName} version mismatch`);
        const stageDir = join(ctx.tempPackDir, `stage_${depName.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
        cpSync(localDepDir, stageDir, { recursive: true });
        const sanitizedPkg = { ...rawPkg };
        delete sanitizedPkg.scripts;
        delete sanitizedPkg.devDependencies;
        writeFileSync(join(stageDir, "package.json"), JSON.stringify(sanitizedPkg, null, 2) + "\n", "utf8");
        const packDep = await ctx.runNpm(["pack", "--ignore-scripts", stageDir, "--pack-destination", ctx.tempPackDir], ctx.tempPackDir);
        assert.equal(packDep.status, 0, `Failed to pack dependency ${depName}@${depVersion}: ${packDep.stderr}`);
        depManifest = sanitizedPkg;
      } else {
        const packDep = await ctx.runNpm(["pack", "--ignore-scripts", `${depName}@${depVersion}`, "--pack-destination", ctx.tempPackDir], ctx.tempPackDir);
        assert.equal(packDep.status, 0, `Failed to fetch/pack dependency ${depName}@${depVersion}: ${packDep.stderr}`);
        const unpackDepDir = join(ctx.tempPackDir, `unpack_${depName.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
        mkdirSync(unpackDepDir, { recursive: true });
        const untar = await ctx.spawnAsync("tar", ["-xzf", depTarballPath, "-C", unpackDepDir], { cwd: unpackDepDir, env: ctx.isolatedEnv });
        assert.equal(untar.status, 0, `Failed to inspect dependency tarball ${depTarballPath}: ${untar.stderr}`);
        const rawPkg = JSON.parse(readFileSync(join(unpackDepDir, "package", "package.json"), "utf8"));
        delete rawPkg.scripts;
        delete rawPkg.devDependencies;
        depManifest = rawPkg;
      }

      assert.equal(existsSync(depTarballPath), true, `Dependency tarball missing at ${depTarballPath}`);
      assert.ok(statSync(depTarballPath).size > 1024, `Dependency tarball ${depName} must be a real non-empty archive`);
      registry.addPackage({ name: depName, version: depVersion, tarballPath: depTarballPath, manifest: depManifest });
    })
  );
}

async function verifyPackAndInventory(ctx, registry) {
  const pkgPath = join(REPO_ROOT, "package.json");
  assert.equal(existsSync(pkgPath), true, "package.json missing in repository root");
  const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkgJson.name, "nullform-workflow", "R07: package name must be nullform-workflow");
  assert.equal(pkgJson.bin?.nullform, "bin/nullform.mjs", "R07: bin.nullform must point to bin/nullform.mjs");
  assert.ok(pkgJson.engines?.node === ">=18.19.0" || pkgJson.engines?.node === ">=18.0.0", "package.json engines.node must match");
  assert.equal(readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim(), pkgJson.version, "VERSION must match package.json");

  const dryPack = await ctx.runNpm(["pack", "--dry-run", "--json"], REPO_ROOT);
  assert.equal(dryPack.status, 0, `R01: npm pack --dry-run failed: ${dryPack.stderr}`);
  const parsed = JSON.parse(dryPack.stdout);
  const packedFiles = (parsed[0]?.files || []).map((f) => f.path.replace(/\\/g, "/"));

  const bannedPrefixes = [
    ".tmp", ".workflow", "bench/runs", "history", "openspec", "tools/tests",
    "tools/npm-smoke.mjs", ".git", "node_modules", "agent/config.yml", "agent/models.yml", "agent/mcp.json",
  ];
  for (const file of packedFiles) {
    for (const b of bannedPrefixes) {
      assert.ok(file !== b && !file.startsWith(`${b}/`) && !file.includes("/node_modules/"), `R01/R04: Banned path "${file}" in tarball`);
    }
    assert.ok(!file.endsWith("CODEMAP.md"), `R01: CODEMAP.md packed: ${file}`);
    assert.ok(!(/\.env(\.|$)/i.test(file) && !file.endsWith("secrets.example.env")), `R04: Secret env packed: ${file}`);
  }

  const requiredFiles = [
    "package.json", "VERSION", "LICENSE", "jev/LICENSE", "README.md", "CONTEXT.md",
    ".code-size.baseline.json", "bin/nullform.mjs", "tools/install-harness.mjs", "tools/harness-config.mjs",
    "tools/installation-state.mjs", "tools/doctor.mjs", "tools/self-update.mjs", "tools/workflow.mjs",
    "tools/verify.mjs", "tools/sync-manifest.json", "verify.ps1", "verify.sh",
  ];
  for (const req of requiredFiles) assert.ok(packedFiles.includes(req), `R01: Required asset "${req}" missing from tarball`);

  const packRes = await ctx.runNpm(["pack", "--ignore-scripts", "--pack-destination", ctx.tempPackDir], REPO_ROOT);
  assert.equal(packRes.status, 0, `R01: npm pack failed: ${packRes.stderr}`);
  const tarballName = `nullform-workflow-${pkgJson.version}.tgz`;
  const tarballPath = join(ctx.tempPackDir, tarballName);
  assert.equal(existsSync(tarballPath), true, `R01: Tarball not created at ${tarballPath}`);
  assert.ok(statSync(tarballPath).size > 1024, "R01/R08: Packed tarball must be non-empty");

  await prepareDependencyTarballs(ctx, registry, pkgJson);
  registry.addPackage({ name: "nullform-workflow", version: pkgJson.version, tarballPath, manifest: pkgJson });
  return { pkgJson, packedFiles, tarballName, tarballPath };
}

async function verifyGlobalInstall(ctx, registry, pkgJson) {
  const installRes = await ctx.runNpm(
    ["install", "-g", "--ignore-scripts", "--no-audit", "--no-fund", "nullform-workflow", "--registry", registry.url],
    ctx.spaceBase,
    { npm_config_registry: registry.url, NPM_CONFIG_REGISTRY: registry.url, NULLFORM_REGISTRY: registry.url }
  );
  assert.equal(installRes.status, 0, `R01: npm install -g failed: ${installRes.stderr}`);

  const servedPaths = registry.requests.map((r) => r.path);
  for (const expectedPkg of ["nullform-workflow", "json5", "yaml", "jsonc-parser"]) {
    assert.ok(servedPaths.some((p) => p.includes(expectedPkg)), `R01/R08: Loopback registry was not queried for ${expectedPkg}`);
  }

  const binExecutable = getGlobalBinPath(ctx.tempPrefix);
  assert.equal(existsSync(binExecutable), true, `R01: Global bin missing at ${binExecutable}`);
  assert.deepEqual(listFilesRecursive(ctx.tempHome), [], "R01: npm install -g must not mutate user home before init");

  const verRes = await ctx.runInstalledBin(["--version"]);
  assert.equal(verRes.status, 0, `R01: nullform --version failed: ${verRes.stderr}`);
  assert.equal(verRes.stdout.trim(), pkgJson.version, "R01: nullform --version must match package.json version");

  const helpRes = await ctx.runInstalledBin(["--help"]);
  assert.equal(helpRes.status, 0, `R01: nullform --help failed: ${helpRes.stderr}`);
  for (const token of ["init", "doctor", "update", ...HARNESS_CHOICES]) {
    assert.ok(helpRes.stdout.includes(token), `R01: --help output missing "${token}"`);
  }
  return binExecutable;
}

function buildHarnessFixture(harness, root, home, proj, secret) {
  const hb = `Preserve human top note for ${harness} verbatim.`;
  const ha = `Preserve human bottom note for ${harness} verbatim.`;
  const stdMd = `# User Heading (${harness})\n\n${hb}\n\n<!-- BEGIN NULLFORM WORKFLOW -->\nOld workflow block to replace cleanly.\n<!-- END NULLFORM WORKFLOW -->\n\n${ha}\n`;
  const opencodeJsonc = `{\n  // User JSONC comment preserved at trust boundary\n  "$schema": "https://opencode.ai/config.json",\n  "share": "manual",\n  "provider": { "openai": { "options": { "apiKey": "${secret}", }, }, },\n}\n`;
  const openclawJson5 = `{\n  // OpenClaw JSON5 user configuration\n  env: { vars: { OPENAI_API_KEY: '${secret}', }, },\n  agents: { entries: { customAgent: { workspace: '/tmp/custom-agent', }, }, },\n}\n`;
  const hermesYaml = `# User Hermes YAML config\nmodel: "anthropic/claude-3-5-sonnet"\napi_key: "${secret} # hash inside quoted YAML string"\ncustom_multiline: |\n  first line # keep comment char in literal block\n  second line\ndefaults: &default_settings\n  timeout: 45\nservice:\n  <<: *default_settings\nmcp_servers:\n  customUserServer:\n    command: "node"\n    args: ["custom-server.js"]\n    env:\n      API_TOKEN: "${secret}"\n`;
  const ompMcp = JSON.stringify({ mcpServers: { customUserMcp: { command: "node", args: ["mcp.js"], env: { TOKEN: secret } } } }, null, 2) + "\n";
  const openhumanToml = `# User OpenHuman TOML config\n[agent]\nagents_md_enabled = true\n\n[env]\nOPENAI_API_KEY = "${secret}"\n`;
  const cursorMdc = `---\ndescription: Custom User Cursor Rule\nalwaysApply: true\n---\n\n${hb}\n\n<!-- BEGIN NULLFORM WORKFLOW -->\nOld workflow block to replace cleanly.\n<!-- END NULLFORM WORKFLOW -->\n\n${ha}\n`;

  const map = {
    claude: { md: [join(root, "CLAUDE.md"), join(home, ".claude", "CLAUDE.md")], skills: join(home, ".claude", "skills") },
    codex: { md: [join(root, "AGENTS.md"), join(home, ".codex", "AGENTS.md")], skills: join(home, ".codex", "skills") },
    opencode: { md: [join(root, "AGENTS.md"), join(home, ".config", "opencode", "AGENTS.md")], cfg: [join(root, "opencode.json"), join(home, ".config", "opencode", "opencode.json")], cfgBody: opencodeJsonc, cfgKind: "jsonc", skills: join(home, ".config", "opencode", "skills") },
    cursor: { md: [join(proj, ".cursor", "rules", "00-workflow.mdc")], mdBody: cursorMdc, skills: join(root, "skills") },
    omp: { md: [join(home, ".omp", "agent", "AGENTS.md")], cfg: [join(home, ".omp", "agent", "mcp.json")], cfgBody: ompMcp, cfgKind: "omp-json", skills: join(home, ".agents", "skills") },
    openclaw: { md: [join(root, "AGENTS.md"), join(root, "SOUL.md"), join(root, "USER.md")], cfg: [join(root, "openclaw.json"), join(home, ".openclaw", "openclaw.json")], cfgBody: openclawJson5, cfgKind: "json5", skills: join(home, ".openclaw", "skills") },
    hermes: { md: [join(root, "AGENTS.md"), join(home, ".hermes", "SOUL.md"), join(home, ".hermes", "AGENTS.md")], cfg: [join(root, "config.yaml"), join(home, ".hermes", "config.yaml")], cfgBody: hermesYaml, cfgKind: "yaml", skills: join(home, ".hermes", "skills") },
    openhuman: { md: [join(root, "AGENTS.md"), join(home, ".openhuman", "AGENTS.md")], cfg: [join(home, ".openhuman", "config.toml")], cfgBody: openhumanToml, cfgKind: "toml", skills: join(home, ".openhuman", "skills"), noSymlink: true },
  };
  const e = map[harness];
  return { mdFiles: e.md, mdContent: e.mdBody || stdMd, cfgFiles: e.cfg || [], cfgContent: e.cfgBody, cfgKind: e.cfgKind, skillsDir: e.skills, noSymlinkSkills: e.noSymlink, humanBefore: hb, humanAfter: ha };
}

function seedHarnessFiles(fixture, customRoot, secretToken) {
  writeFileSync(join(customRoot, "unrelated-notes.txt"), "Unrelated user file content.\n", "utf8");
  writeFileSync(join(customRoot, ".env"), `USER_ENV_SECRET=${secretToken}\n`, "utf8");
  for (const mdPath of fixture.mdFiles) {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, fixture.mdContent, "utf8");
  }
  for (const cfgPath of fixture.cfgFiles) {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, fixture.cfgContent, "utf8");
  }
}

async function verifyHarnessInit(ctx, harness, fixture, customRoot, harnessHome, projectDir, secretToken, pkgVersion) {
  const initArgs = [
    "init", "--harness", harness, "--root", customRoot, "--user-home", harnessHome,
    ...(projectDir ? ["--project-root", projectDir] : []), "--yes",
  ];

  let firstPassMdSnapshots = {};
  for (let pass = 1; pass <= 2; pass++) {
    const res = await ctx.runInstalledBin(initArgs);
    assert.equal(res.status, 0, `R02/R04: init pass ${pass} for ${harness} failed: ${res.stderr || res.stdout}`);

    for (const mdPath of fixture.mdFiles) {
      assert.equal(existsSync(mdPath), true, `R03: Expected native instruction file missing at ${mdPath}`);
      const mdAfter = readFileSync(mdPath, "utf8");
      assert.ok(mdAfter.includes(fixture.humanBefore) && mdAfter.includes(fixture.humanAfter), `R04: Human notes lost in ${mdPath}`);
      assert.equal(mdAfter.includes("Old workflow block to replace cleanly."), false, `R04: Old block not replaced in ${mdPath}`);
      assert.equal(mdAfter.includes("NULLFORM WORKFLOW"), true, `R03: Workflow adapter missing in ${mdPath}`);
      assert.equal(mdAfter.split("<!-- BEGIN NULLFORM WORKFLOW -->").length, 2, `R04: Duplicate managed block in ${mdPath}`);
      if (harness === "cursor") assert.ok(mdAfter.includes("alwaysApply: true"), "R03: Cursor .mdc must retain alwaysApply: true");
      if (pass === 1) firstPassMdSnapshots[mdPath] = mdAfter;
      else assert.equal(mdAfter, firstPassMdSnapshots[mdPath], `R04: Managed block not idempotent in ${mdPath}`);
    }

    if (harness === "cursor") {
      assert.equal(existsSync(join(harnessHome, ".cursor", "rules")), false, "R03: Cursor must not create global ~/.cursor/rules");
    }

    assert.equal(readFileSync(join(customRoot, "unrelated-notes.txt"), "utf8"), "Unrelated user file content.\n", "R04: Unrelated file altered");
    assert.equal(readFileSync(join(customRoot, ".env"), "utf8"), `USER_ENV_SECRET=${secretToken}\n`, "R04: User .env file altered");

    for (const cfgPath of fixture.cfgFiles) {
      assert.equal(existsSync(cfgPath), true, `R03: Expected native config missing at ${cfgPath}`);
      const text = readFileSync(cfgPath, "utf8");
      assert.ok(text.includes(secretToken), `R04: Secret token lost in ${cfgPath} on pass ${pass}`);
      if (fixture.cfgKind === "jsonc") assert.ok(text.includes("manual") && text.includes("// User JSONC comment"), "R04: OpenCode settings lost");
      if (fixture.cfgKind === "json5" || harness === "openclaw") {
        assert.ok(text.includes(customRoot.replace(/\\/g, "/")), "R03: OpenClaw workflow workspace missing");
        assert.ok(text.includes("customAgent"), "R04: OpenClaw customAgent entry lost");
      }
      if (fixture.cfgKind === "yaml") {
        assert.ok(text.includes("# hash inside quoted YAML string") && text.includes("first line # keep comment char"), "R04: YAML comments corrupted");
        assert.ok(text.includes("*default_settings") && text.includes("mcp_servers:"), "R03/R04: Hermes anchor/mcp lost");
        assert.equal(/(?:^|\n)profiles:\s*(?:\r?\n)/m.test(text), false, "R03: Hermes config must not inject fake profiles");
      }
      if (fixture.cfgKind === "toml") {
        assert.equal(text.includes("[memory.agents.workflow]"), false, "R04: OpenHuman config unrequested section injected");
      }
    }

    assert.equal(existsSync(fixture.skillsDir), true, `R03: Skills directory missing at ${fixture.skillsDir} for ${harness}`);
    const skills = readdirSync(fixture.skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.ok(skills.length > 0, `R03: No skills installed in ${fixture.skillsDir} for ${harness}`);
    if (fixture.noSymlinkSkills) {
      for (const entry of skills) {
        const fullSkillPath = join(fixture.skillsDir, entry.name);
        assert.equal(lstatSync(fullSkillPath).isSymbolicLink(), false, `R03: Skill must not be symlink: ${fullSkillPath}`);
      }
    }
  }

  const statePath = join(harnessHome, ".nullform", "installation.json");
  assert.equal(existsSync(statePath), true, `R05: State file missing at ${statePath}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.schemaVersion, 1, "R05: schemaVersion must be 1");
  assert.equal(state.harness, harness, `R05: state.harness must be ${harness}`);
  assert.equal(resolve(state.root), resolve(customRoot), "R05: state.root must match customRoot");
  assert.equal(resolve(state.userHome), resolve(harnessHome), "R05: state.userHome must match harnessHome");
  if (projectDir) assert.equal(resolve(state.projectRoot), resolve(projectDir), "R05: state.projectRoot must match projectDir");
  assert.equal(state.version, pkgVersion, `R05: state.version must be ${pkgVersion}`);
  assert.equal(JSON.stringify(state).includes(secretToken), false, "R04/R05: State file must not store user secrets");
}

async function verifyHarnessDoctor(ctx, harness, harnessHome) {
  const docArgs = ["doctor", "--user-home", harnessHome, "--json", ...(harness === "omp" ? ["--skip-plugin-check"] : [])];
  const docRes = await ctx.runInstalledBin(docArgs);
  const docJson = JSON.parse(docRes.stdout);
  assert.equal(docJson.targetHarness, harness, `R03/R05: doctor targetHarness must equal persisted ${harness}`);
  const failedChecks = (docJson.checks || []).filter((c) => c.status === "fail");
  assert.deepEqual(failedChecks, [], `R03: Doctor failed unexpectedly on ${harness}: ${JSON.stringify(failedChecks)}`);

  const checkIds = (docJson.checks || []).map((c) => c.id);
  if (harness !== "omp") {
    for (const ompOnlyId of ["plugins", "agents-drift", "logs-hygiene", "configs", "agent-wiring"]) {
      assert.equal(checkIds.includes(ompOnlyId), false, `R03: OMP-only check "${ompOnlyId}" must not run for ${harness}`);
    }
    const integrationCheck = (docJson.checks || []).find((c) => c.id === "harness-integration");
    assert.equal(integrationCheck?.status, "pass", `R03: harness-integration check must pass for ${harness}`);
    const skillsCheck = (docJson.checks || []).find((c) => c.id === "skills");
    assert.equal(skillsCheck?.status, "pass", `R03: skills check must pass for ${harness}`);
    const runtimeCheck = (docJson.checks || []).find((c) => c.id === "host-runtime");
    assert.ok(runtimeCheck, `R03: host-runtime check must be present for ${harness}`);
    assert.notEqual(runtimeCheck.status, "fail", `R03: Missing host runtime for ${harness} must be SETUP/warn, never FAIL`);
  }
}

async function seedAndVerifyHarness(ctx, harness, pkgVersion) {
  const customRoot = join(ctx.spaceBase, `root_${harness}`);
  const harnessHome = join(ctx.spaceBase, `home_${harness}`);
  const projectDir = harness === "cursor" ? join(ctx.spaceBase, `project_${harness}`) : null;
  mkdirSync(customRoot, { recursive: true });
  mkdirSync(harnessHome, { recursive: true });
  if (projectDir) mkdirSync(projectDir, { recursive: true });

  const secretToken = `sk-secret-${harness}-98765`;
  const fixture = buildHarnessFixture(harness, customRoot, harnessHome, projectDir || customRoot, secretToken);

  seedHarnessFiles(fixture, customRoot, secretToken);
  await verifyHarnessInit(ctx, harness, fixture, customRoot, harnessHome, projectDir, secretToken, pkgVersion);
  await verifyHarnessDoctor(ctx, harness, harnessHome);
}

async function verifyBoundaries(ctx) {
  const dryRoot = join(ctx.spaceBase, "dry_root");
  const dryHome = join(ctx.spaceBase, "dry_home");
  const cleanHome = join(ctx.spaceBase, "clean_home");
  const cancelHome = join(ctx.spaceBase, "cancel_home");
  const cancelRoot = join(ctx.spaceBase, "cancel_root");
  const malformedRoot = join(ctx.spaceBase, "malformed_root");
  const malformedHome = join(ctx.spaceBase, "malformed_home");
  const badMarkerRoot = join(ctx.spaceBase, "bad_marker_root");
  const badMarkerHome = join(ctx.spaceBase, "bad_marker_home");
  for (const d of [dryRoot, dryHome, cleanHome, cancelHome, cancelRoot, malformedRoot, malformedHome, badMarkerRoot, badMarkerHome]) {
    mkdirSync(d, { recursive: true });
  }

  const existingMd = join(malformedRoot, "AGENTS.md");
  const leakCanary = "sk-canary-never-echo-in-errors-999";
  writeFileSync(existingMd, "# Intact User File\n", "utf8");
  writeFileSync(join(malformedRoot, "openclaw.json"), `{ apiKey: "${leakCanary}", broken_json5: [ `, "utf8");

  const badMarkerMd = join(badMarkerRoot, "CLAUDE.md");
  const badMarkerContent = "# User Notes\n\n<!-- BEGIN NULLFORM WORKFLOW -->\nUnclosed marker.\n";
  writeFileSync(badMarkerMd, badMarkerContent, "utf8");

  const [dryRes, nonTtyRes, autoRes, cancelRes, malformedRes, badMarkerRes] = await Promise.all([
    ctx.runInstalledBin(["init", "--harness", "opencode", "--root", dryRoot, "--user-home", dryHome, "--dry-run"]),
    ctx.runInstalledBin(["init", "--user-home", cleanHome]),
    ctx.runInstalledBin(["init", "--harness", "auto", "--user-home", cleanHome, "--yes"]),
    ctx.runInstalledBin(["init", "--harness", "opencode", "--root", cancelRoot, "--user-home", cancelHome], { input: "n\n" }),
    ctx.runInstalledBin(["init", "--harness", "openclaw", "--root", malformedRoot, "--user-home", malformedHome, "--yes"]),
    ctx.runInstalledBin(["init", "--harness", "claude", "--root", badMarkerRoot, "--user-home", badMarkerHome, "--yes"]),
  ]);

  assert.equal(dryRes.status, 0, `R02/R04: --dry-run failed: ${dryRes.stderr}`);
  assert.deepEqual(listFilesRecursive(dryRoot), [], "R04: --dry-run must not write to target root");
  assert.deepEqual(listFilesRecursive(dryHome), [], "R04: --dry-run must not write to userHome or state");
  assert.notEqual(nonTtyRes.status, 0, "R02: Non-TTY init must fail closed");
  assert.deepEqual(listFilesRecursive(cleanHome), [], "R02: Failed init must not write state");
  assert.notEqual(autoRes.status, 0, "R02: auto rejected");
  assert.notEqual(cancelRes.status, 0);
  assert.deepEqual(listFilesRecursive(cancelRoot), [], "R02: Cancelled init must not write target root");
  assert.deepEqual(listFilesRecursive(cancelHome), [], "R02: Cancelled init must not write state");

  assert.notEqual(malformedRes.status, 0, "R04: Malformed native config must fail closed");
  assert.equal(readFileSync(existingMd, "utf8"), "# Intact User File\n", "R04: Preflight must fail before mutating AGENTS.md");
  assert.equal(existsSync(join(malformedRoot, "tools")), false, "R04: Preflight must fail before copying tools/");
  assert.equal(existsSync(join(malformedHome, ".nullform", "installation.json")), false, "R04: Preflight must not write state");
  assert.ok(!(malformedRes.stdout + malformedRes.stderr).includes(leakCanary), "R04: error must not echo secret");

  assert.notEqual(badMarkerRes.status, 0, "R04: Unclosed marker must fail preflight");
  assert.equal(readFileSync(badMarkerMd, "utf8"), badMarkerContent, "R04: Unclosed marker must not truncate user file");
  assert.equal(existsSync(join(badMarkerRoot, "tools")), false);
  assert.equal(existsSync(join(badMarkerHome, ".nullform", "installation.json")), false);
}

async function verifyRegistryUpgrade(ctx, registry, v11TarballPath, pkgJson) {
  const unpackDir = join(ctx.spaceBase, "v120_unpack");
  mkdirSync(unpackDir, { recursive: true });
  assert.equal((await ctx.spawnAsync("tar", ["-xzf", v11TarballPath, "-C", unpackDir], { cwd: unpackDir, env: ctx.isolatedEnv })).status, 0);

  const v12Source = join(unpackDir, "package");
  assert.ok(existsSync(join(v12Source, "CONTEXT.md")) && existsSync(join(v12Source, ".code-size.baseline.json")));
  const v12Pkg = { ...pkgJson, version: "1.2.0" };
  writeFileSync(join(v12Source, "package.json"), JSON.stringify(v12Pkg, null, 2) + "\n", "utf8");
  writeFileSync(join(v12Source, "VERSION"), "1.2.0\n", "utf8");

  const opencodeSkills = join(ctx.spaceBase, "home_opencode", ".config", "opencode", "skills");
  const ownedSkillFile = join(opencodeSkills, "ui-ux-pro-max", "scripts", "core.py");
  const userSkillFile = join(opencodeSkills, "ui-ux-pro-max", "scripts", "validate_data.py");
  assert.ok(existsSync(ownedSkillFile), "R03: Owned skill asset should exist prior to update");
  assert.ok(existsSync(userSkillFile), "R03: Skill asset to be edited should exist prior to update");
  writeFileSync(userSkillFile, "# User edit to validate_data.py preserved\n", "utf8");
  writeFileSync(join(v12Source, "skills", "ui-ux-pro-max", "scripts", "core.py"), "# Upgraded core.py v1.2.0\n", "utf8");
  writeFileSync(join(v12Source, "skills", "ui-ux-pro-max", "scripts", "validate_data.py"), "# Upgraded validate_data.py v1.2.0\n", "utf8");
  assert.equal((await ctx.runNpm(["pack", "--ignore-scripts", "--pack-destination", ctx.tempPackDir], v12Source)).status, 0);
  const v12TarballPath = join(ctx.tempPackDir, "nullform-workflow-1.2.0.tgz");
  assert.ok(existsSync(v12TarballPath), "R06: v1.2.0 tarball missing");

  registry.addPackage({ name: "nullform-workflow", version: "1.2.0", tarballPath: v12TarballPath, manifest: v12Pkg });
  const metaRes = await fetch(`${registry.url}/nullform-workflow`);
  assert.equal(metaRes.status, 200);
  assert.equal((await metaRes.json())["dist-tags"]?.latest, "1.2.0");

  const opencodeHome = join(ctx.spaceBase, "home_opencode");
  const opencodeRoot = join(ctx.spaceBase, "root_opencode");
  const envReg = { npm_config_registry: registry.url, NPM_CONFIG_REGISTRY: registry.url, NULLFORM_REGISTRY: registry.url };
  const updateRes = await ctx.runInstalledBin(["update", "--yes", "--user-home", opencodeHome, "--registry", registry.url], { extraEnv: envReg });
  assert.equal(updateRes.status, 0, `R06: update failed: ${updateRes.stderr || updateRes.stdout}`);
  assert.equal((await ctx.runInstalledBin(["--version"])).stdout.trim(), "1.2.0");

  const updatedState = JSON.parse(readFileSync(join(opencodeHome, ".nullform", "installation.json"), "utf8"));
  assert.equal(updatedState.version, "1.2.0");
  assert.equal(updatedState.harness, "opencode");
  assert.equal(resolve(updatedState.root), resolve(opencodeRoot));
  assert.equal(readFileSync(join(opencodeRoot, "VERSION"), "utf8").trim(), "1.2.0");
  assert.ok(readFileSync(join(opencodeHome, ".config", "opencode", "AGENTS.md"), "utf8").includes("Preserve human top note for opencode verbatim."));
  assert.ok(readFileSync(join(opencodeHome, ".config", "opencode", "opencode.json"), "utf8").includes("sk-secret-opencode-98765"));

  assert.equal(readFileSync(ownedSkillFile, "utf8"), "# Upgraded core.py v1.2.0\n", "R03/R04/R06: Unchanged owned asset should update to v1.2.0");
  assert.equal(readFileSync(userSkillFile, "utf8"), "# User edit to validate_data.py preserved\n", "R03/R04/R06: User-edited asset should not be overwritten");
  assert.ok(updatedState.managedFiles?.[ownedSkillFile], "R03/R05: Owned skill file hash should be recorded in managedFiles");
  assert.ok(updatedState.managedFiles?.[userSkillFile], "R03/R05: User skill file prior hash should be preserved in managedFiles");
  const cursorHome = join(ctx.spaceBase, "home_cursor");
  const cursorRoot = join(ctx.spaceBase, "root_cursor");
  const cursorProject = join(ctx.spaceBase, "project_cursor");
  const cUpRes = await ctx.runInstalledBin(["update", "--force", "--yes", "--user-home", cursorHome, "--registry", registry.url], { extraEnv: envReg });
  assert.equal(cUpRes.status, 0);
  const cursorState = JSON.parse(readFileSync(join(cursorHome, ".nullform", "installation.json"), "utf8"));
  assert.equal(cursorState.version, "1.2.0");
  assert.equal(resolve(cursorState.root), resolve(cursorRoot));
  assert.equal(resolve(cursorState.projectRoot), resolve(cursorProject));
  assert.equal(readFileSync(join(cursorRoot, "VERSION"), "utf8").trim(), "1.2.0");
  assert.ok(readFileSync(join(cursorProject, ".cursor", "rules", "00-workflow.mdc"), "utf8").includes("Preserve human top note for cursor verbatim."));

  const v13Pkg = { ...pkgJson, version: "1.3.0" };
  registry.addPackage({ name: "nullform-workflow", version: "1.3.0", tarballPath: v12TarballPath, manifest: v13Pkg, tarballStatus: 404 });
  const tarballFailRes = await ctx.runInstalledBin(["update", "--yes", "--user-home", opencodeHome, "--registry", registry.url], {
    timeoutMs: 30_000,
    extraEnv: { ...envReg, npm_config_fetch_retries: "0", NPM_CONFIG_FETCH_RETRIES: "0" },
  });
  assert.notEqual(tarballFailRes.status, 0, "R06: Broken 404 tarball during npm install must exit nonzero");
  assert.equal((await ctx.runInstalledBin(["--version"])).stdout.trim(), "1.2.0", "R06: Failed update must leave global version at 1.2.0");
  assert.equal(JSON.parse(readFileSync(join(opencodeHome, ".nullform", "installation.json"), "utf8")).version, "1.2.0", "R06: Failed update must preserve verified installation.json version");
  assert.equal(readFileSync(join(opencodeRoot, "VERSION"), "utf8").trim(), "1.2.0", "R06: Failed update must preserve target root VERSION");

  const unreachable = "http://127.0.0.1:1/unreachable";
  const failRes = await ctx.runInstalledBin(["update", "--yes", "--timeout", "2", "--user-home", opencodeHome, "--registry", unreachable], {
    timeoutMs: 15_000,
    extraEnv: { npm_config_registry: unreachable, NPM_CONFIG_REGISTRY: unreachable, NULLFORM_REGISTRY: unreachable, npm_config_fetch_retries: "0", NPM_CONFIG_FETCH_RETRIES: "0" },
  });
  assert.notEqual(failRes.status, 0, "R06: Unreachable registry must exit nonzero");
}

export async function runSmoke(options = {}) {
  const keepTemp = Boolean(options.keepTemp);
  const baseTemp = options.baseTemp || mkdtempSync(join(tmpdir(), "nullform-smoke-"));
  let registry = null;
  let ctx = null;
  let primaryError = null;

  try {
    ctx = createSmokeEnv(baseTemp);
    const registryServer = createLocalRegistry({ host: "127.0.0.1", port: 0 });
    registry = await registryServer.start();

    const packInfo = await verifyPackAndInventory(ctx, registry);
    const binExecutable = await verifyGlobalInstall(ctx, registry, packInfo.pkgJson);

    await Promise.all([
      ...HARNESS_CHOICES.map((harness) => seedAndVerifyHarness(ctx, harness, packInfo.pkgJson.version)),
      verifyBoundaries(ctx),
    ]);
    await verifyRegistryUpgrade(ctx, registry, packInfo.tarballPath, packInfo.pkgJson);

    const workspaceTmp = join(REPO_ROOT, ".tmp");
    mkdirSync(workspaceTmp, { recursive: true });
    const deliveredTarball = join(workspaceTmp, packInfo.tarballName);
    const sourceBuf = readFileSync(packInfo.tarballPath);

    const isIdentical = existsSync(deliveredTarball) &&
      statSync(deliveredTarball).size === sourceBuf.length &&
      readFileSync(deliveredTarball).equals(sourceBuf);

    if (!isIdentical) {
      const atomicTmp = `${deliveredTarball}.tmp-${process.pid}-${Date.now().toString(36)}`;
      cpSync(packInfo.tarballPath, atomicTmp);
      try {
        renameSync(atomicTmp, deliveredTarball);
      } catch {
        cpSync(atomicTmp, deliveredTarball);
        try { rmSync(atomicTmp, { force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
      }
    }

    assert.equal(existsSync(deliveredTarball), true, "R08: Delivered tarball missing in .tmp/");
    assert.ok(readFileSync(deliveredTarball).equals(sourceBuf), "R08: Delivered tarball in .tmp/ must match verified pack exactly");
    return {
      status: "success",
      evidence: {
        R01: `Packed ${packInfo.tarballName} (${packInfo.packedFiles.length} files, private/node_modules excluded) with real json5@2.2.3, yaml@2.9.1, and jsonc-parser@3.3.1 dependency tarballs; installed globally via --ignore-scripts at ${binExecutable}`,
        R02: `Initialized all 8 harnesses (${HARNESS_CHOICES.join(", ")}); non-TTY missing selection, --harness auto, and cancelled prompt fail closed without writes`,
        R03: `Source-verified native routes and skills validated for all 8 harnesses; doctor verified targetHarness and excluded OMP-only checks for non-OMP`,
        R04: `Mixed managed-block human notes, JSONC/JSON5/YAML/TOML secrets, YAML #/multiline/anchors, and unrelated files preserved across repeat init and update; dry-run, malformed config, and malformed marker preflight made zero writes`,
        R05: `Persisted schemaVersion 1 installation.json (including custom root and Cursor projectRoot) verified across all 8 harnesses and respected by doctor/update`,
        R06: `Upgraded global bin, installation.json, and target VERSION from ${packInfo.pkgJson.version} to 1.2.0 via loopback registry without Git; bounded unreachable registry exited nonzero`,
        R07: `Single package nullform-workflow with nullform CLI backed by installHarness`,
        R08: `Verified tarball delivered at ${deliveredTarball} and upgraded via loopback registry ${registry.url}`,
      },
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    let cleanupError = null;
    if (ctx) {
      try { await ctx.dispose(); } catch (err) { cleanupError ||= err; }
    }
    if (registry) {
      try { await registry.close(); } catch (err) { cleanupError ||= err; }
    }
    if (!keepTemp && existsSync(baseTemp)) {
      try {
        rmSync(baseTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        cleanupError ||= err;
      }
    }
    if (cleanupError) {
      if (primaryError) {
        try { primaryError.cleanupError = cleanupError; } catch {}
      } else {
        throw cleanupError;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const keepTemp = process.argv.includes("--keep-temp");
  const asJson = process.argv.includes("--json");
  runSmoke({ keepTemp })
    .then((res) => {
      if (asJson) console.log(JSON.stringify(res, null, 2));
      else {
        console.log("ALL SMOKE CHECKS PASSED (R01-R08)");
        for (const [k, v] of Object.entries(res.evidence)) console.log(`  [${k}] ${v}`);
      }
    })
    .catch((err) => {
      console.error("SMOKE CHECK FAILED:", err?.stack || err?.message || err);
      process.exitCode = 1;
    });
}
