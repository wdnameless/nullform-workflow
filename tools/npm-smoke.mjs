#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname, basename, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLocalRegistry } from "./tests/npm-registry.mjs";
import {
  REPO_ROOT,
  ALL_8_HARNESSES as HARNESS_CHOICES,
  computeFileDigests,
  deriveHigherVersion,
  resolveNpmInvocation,
  safeExtractArchive,
  inspectArchiveContents,
  buildHarnessFixture,
  seedHarnessFiles,
} from "./package-archive.mjs";
export { computeFileDigests, deriveHigherVersion, resolveNpmInvocation, safeExtractArchive, inspectArchiveContents };

const __dirname = dirname(fileURLToPath(import.meta.url));

function terminateChildTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

function spawnAsync(command, args = [], options = {}) {
  const { cwd = REPO_ROOT, env = process.env, input = "", timeoutMs = 120_000, tracker = null } = options;
  const startedAt = Date.now();
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
      const elapsedMs = Date.now() - startedAt;
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const rawStderr = Buffer.concat(errChunks).toString("utf8");
      const stderr = rawStderr || (timedOut ? `Command timed out after ${timeoutMs}ms (elapsed: ${elapsedMs}ms): ${command} ${args.join(" ")}` : "");
      resolveRun({
        status: timedOut ? 124 : (code ?? 1),
        signal,
        timedOut,
        elapsedMs,
        stdout,
        stderr,
      });
    });
  });
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
      const isTwoPhaseUpdate = args[0] === "update";
      const defaultTimeout = isTwoPhaseUpdate ? 180_000 : 60_000;
      return spawnAsync(command, fullArgs, {
        cwd: options.cwd || spaceBase,
        env,
        input: options.input ?? "",
        timeoutMs: options.timeoutMs ?? defaultTimeout,
        tracker: activeChildren,
      });
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
        safeExtractArchive(depTarballPath, unpackDepDir);
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

async function verifyPackAndInventory(ctx, registry, candidateTarballPath = null) {
  const rootVer = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim();
  let tarballPath = candidateTarballPath ? resolve(candidateTarballPath) : null;
  if (!tarballPath) {
    const packRes = await ctx.runNpm(["pack", "--ignore-scripts", "--pack-destination", ctx.tempPackDir], REPO_ROOT);
    assert.equal(packRes.status, 0, `npm pack failed: ${packRes.stderr}`);
    tarballPath = join(ctx.tempPackDir, `nullform-workflow-${rootVer}.tgz`);
  }
  assert.ok(existsSync(tarballPath) && statSync(tarballPath).size > 1024, "Tarball must be non-empty");

  const inspectDir = join(ctx.spaceBase, "candidate_inspect");
  const { pkgJson, pkgDir } = inspectArchiveContents(tarballPath, inspectDir);
  const packedFiles = listFilesRecursive(pkgDir).map((f) => f.slice(pkgDir.length + 1).replace(/\\/g, "/"));
  const banned = [".tmp", ".workflow", "bench/runs", "history", "openspec", "tools/tests", "tools/npm-smoke.mjs", "tools/certify-package.mjs", "tools/publish-release.mjs", "tools/package-archive.mjs", ".git", "node_modules", "agent/config.yml", "agent/models.yml", "agent/mcp.json"];
  for (const f of packedFiles) {
    for (const b of banned) assert.ok(f !== b && !f.startsWith(`${b}/`) && !f.includes("/node_modules/"), `Banned: ${f}`);
    assert.ok(!f.endsWith("CODEMAP.md") && !(/\.env(\.|$)/i.test(f) && !f.endsWith("secrets.example.env")));
  }
  const reqs = ["package.json", "VERSION", "LICENSE", "jev/LICENSE", "README.md", "CONTEXT.md", ".code-size.baseline.json", "bin/nullform.mjs", "tools/install-harness.mjs", "tools/harness-config.mjs", "tools/installation-state.mjs", "tools/doctor.mjs", "tools/self-update.mjs", "tools/workflow.mjs", "tools/verify.mjs", "tools/sync-manifest.json", "verify.ps1", "verify.sh"];
  for (const req of reqs) assert.ok(packedFiles.includes(req), `Missing asset: ${req}`);

  const digests = computeFileDigests(tarballPath);
  await prepareDependencyTarballs(ctx, registry, pkgJson);
  registry.addPackage({ name: "nullform-workflow", version: pkgJson.version, tarballPath, manifest: pkgJson });
  return { pkgJson, packedFiles, tarballName: basename(tarballPath), tarballPath, sha256: digests.sha256, sha512: digests.sha512, size: digests.size };
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

async function verifyRegistryUpgrade(ctx, registry, candidateTarballPath, pkgJson) {
  const upgradeVersion = deriveHigherVersion(pkgJson.version, 1);
  const brokenVersion = deriveHigherVersion(pkgJson.version, 2);
  const unpackDir = join(ctx.spaceBase, "upgrade_unpack");
  mkdirSync(unpackDir, { recursive: true });
  safeExtractArchive(candidateTarballPath, unpackDir);

  const vUpSource = join(unpackDir, "package");
  const vUpPkg = { ...pkgJson, version: upgradeVersion };
  writeFileSync(join(vUpSource, "package.json"), JSON.stringify(vUpPkg, null, 2) + "\n", "utf8");
  writeFileSync(join(vUpSource, "VERSION"), `${upgradeVersion}\n`, "utf8");

  const opencodeSkills = join(ctx.spaceBase, "home_opencode", ".config", "opencode", "skills");
  const ownedSkillFile = join(opencodeSkills, "ui-ux-pro-max", "scripts", "core.py");
  const userSkillFile = join(opencodeSkills, "ui-ux-pro-max", "scripts", "validate_data.py");
  writeFileSync(userSkillFile, "# User edit to validate_data.py preserved\n", "utf8");
  writeFileSync(join(vUpSource, "skills", "ui-ux-pro-max", "scripts", "core.py"), `# Upgraded core.py v${upgradeVersion}\n`, "utf8");
  writeFileSync(join(vUpSource, "skills", "ui-ux-pro-max", "scripts", "validate_data.py"), `# Upgraded validate_data.py v${upgradeVersion}\n`, "utf8");
  assert.equal((await ctx.runNpm(["pack", "--ignore-scripts", "--pack-destination", ctx.tempPackDir], vUpSource)).status, 0);
  const vUpTarballPath = join(ctx.tempPackDir, `nullform-workflow-${upgradeVersion}.tgz`);

  registry.addPackage({ name: "nullform-workflow", version: upgradeVersion, tarballPath: vUpTarballPath, manifest: vUpPkg });
  const metaRes = await fetch(`${registry.url}/nullform-workflow`);
  assert.equal(metaRes.status, 200);
  assert.equal((await metaRes.json())["dist-tags"]?.latest, upgradeVersion);

  const opencodeHome = join(ctx.spaceBase, "home_opencode");
  const opencodeRoot = join(ctx.spaceBase, "root_opencode");
  const envReg = { npm_config_registry: registry.url, NPM_CONFIG_REGISTRY: registry.url, NULLFORM_REGISTRY: registry.url };
  const updateRes = await ctx.runInstalledBin(["update", "--yes", "--user-home", opencodeHome, "--registry", registry.url], { extraEnv: envReg, timeoutMs: 180_000 });
  assert.equal(updateRes.status, 0, `R06: update failed (status: ${updateRes.status}, elapsed: ${updateRes.elapsedMs}ms): ${updateRes.stderr || updateRes.stdout}`);
  assert.equal((await ctx.runInstalledBin(["--version"])).stdout.trim(), upgradeVersion);

  const updatedState = JSON.parse(readFileSync(join(opencodeHome, ".nullform", "installation.json"), "utf8"));
  assert.equal(updatedState.version, upgradeVersion);
  assert.equal(readFileSync(join(opencodeRoot, "VERSION"), "utf8").trim(), upgradeVersion);
  assert.equal(readFileSync(ownedSkillFile, "utf8"), `# Upgraded core.py v${upgradeVersion}\n`, "R03/R06: Owned asset updated");
  assert.equal(readFileSync(userSkillFile, "utf8"), "# User edit to validate_data.py preserved\n", "R03/R06: User edit preserved");

  for (const h of HARNESS_CHOICES.filter((c) => c !== "opencode")) {
    const hHome = join(ctx.spaceBase, `home_${h}`);
    const hRoot = join(ctx.spaceBase, `root_${h}`);
    const hProj = h === "cursor" ? join(ctx.spaceBase, `project_${h}`) : null;
    const hSecret = `sk-secret-${h}-98765`;
    const fixture = buildHarnessFixture(h, hRoot, hHome, hProj || hRoot, hSecret);

    const hUp = await ctx.runInstalledBin(["update", "--yes", "--user-home", hHome, "--registry", registry.url], { extraEnv: envReg, timeoutMs: 180_000 });
    assert.equal(hUp.status, 0, `R06: ${h} update failed: ${hUp.stderr || hUp.stdout}`);
    const hState = JSON.parse(readFileSync(join(hHome, ".nullform", "installation.json"), "utf8"));
    assert.equal(hState.version, upgradeVersion);
    assert.equal(hState.harness, h);
    assert.equal(resolve(hState.root), resolve(hRoot));
    if (hProj) assert.equal(resolve(hState.projectRoot), resolve(hProj));
    assert.equal(readFileSync(join(hRoot, "VERSION"), "utf8").trim(), upgradeVersion);

    for (const mdPath of fixture.mdFiles) {
      const md = readFileSync(mdPath, "utf8");
      assert.ok(md.includes(fixture.humanBefore) && md.includes(fixture.humanAfter), `Human notes lost in ${mdPath}`);
      assert.ok(md.includes("NULLFORM WORKFLOW"), `Adapter missing in ${mdPath}`);
    }
    for (const cfgPath of fixture.cfgFiles) {
      assert.ok(readFileSync(cfgPath, "utf8").includes(hSecret), `Secret lost in ${cfgPath}`);
    }
    assert.equal(readFileSync(join(hRoot, "unrelated-notes.txt"), "utf8"), "Unrelated user file content.\n");
    assert.equal(readFileSync(join(hRoot, ".env"), "utf8"), `USER_ENV_SECRET=${hSecret}\n`);
  }

  registry.addPackage({ name: "nullform-workflow", version: brokenVersion, tarballPath: vUpTarballPath, manifest: { ...pkgJson, version: brokenVersion }, tarballStatus: 404 });
  const tarballFailRes = await ctx.runInstalledBin(["update", "--yes", "--user-home", opencodeHome, "--registry", registry.url], {
    timeoutMs: 30_000,
    extraEnv: { ...envReg, npm_config_fetch_retries: "0", NPM_CONFIG_FETCH_RETRIES: "0" },
  });
  assert.notEqual(tarballFailRes.status, 0, "R06: Broken 404 tarball must exit nonzero");
  assert.equal((await ctx.runInstalledBin(["--version"])).stdout.trim(), upgradeVersion);
  assert.equal(JSON.parse(readFileSync(join(opencodeHome, ".nullform", "installation.json"), "utf8")).version, upgradeVersion);

  const failRes = await ctx.runInstalledBin(["update", "--yes", "--timeout", "2", "--user-home", opencodeHome, "--registry", "http://127.0.0.1:1/unreachable"], {
    timeoutMs: 15_000,
    extraEnv: { npm_config_registry: "http://127.0.0.1:1/unreachable", npm_config_fetch_retries: "0" },
  });
  assert.notEqual(failRes.status, 0, "R06: Unreachable registry must exit nonzero");
}

let inProcessSmokePromise = Promise.resolve();

async function acquireHostLock(lockPath, timeoutMs = 60_000) {
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      closeSync(fd);
      return () => { try { rmSync(lockPath, { force: true }); } catch {} };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const [p, t] = readFileSync(lockPath, "utf8").trim().split("\n");
        let alive = false;
        if (p) { try { process.kill(parseInt(p, 10), 0); alive = true; } catch {} }
        if (!alive || (Date.now() - parseInt(t, 10) > 180_000)) { rmSync(lockPath, { force: true }); continue; }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`npm-smoke lock timeout at ${lockPath}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function runSmoke(options = {}) {
  const prior = inProcessSmokePromise;
  let releaseInProcess = null;
  inProcessSmokePromise = new Promise((res) => { releaseInProcess = res; });
  await prior;

  const lockPath = join(tmpdir(), "nullform-smoke.lock");
  let releaseHostLock = null;
  const keepTemp = Boolean(options.keepTemp);
  const baseTemp = options.baseTemp || mkdtempSync(join(tmpdir(), "nullform-smoke-"));
  const candidateTarballPath = options.tarballPath ? resolve(options.tarballPath) : null;
  let registry = null;
  let ctx = null;
  let primaryError = null;

  try {
    releaseHostLock = await acquireHostLock(lockPath);
    ctx = createSmokeEnv(baseTemp);
    const registryServer = createLocalRegistry({ host: "127.0.0.1", port: 0 });
    registry = await registryServer.start();

    const packInfo = await verifyPackAndInventory(ctx, registry, candidateTarballPath);
    const binExecutable = await verifyGlobalInstall(ctx, registry, packInfo.pkgJson);

    for (const harness of HARNESS_CHOICES) {
      await seedAndVerifyHarness(ctx, harness, packInfo.pkgJson.version);
    }
    await verifyBoundaries(ctx);
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
      tarballPath: packInfo.tarballPath,
      tarballName: packInfo.tarballName,
      tarballSha256: packInfo.sha256,
      tarballSha512: packInfo.sha512,
      version: packInfo.pkgJson.version,
      evidence: {
        R01: `Packed ${packInfo.tarballName} (${packInfo.packedFiles.length} files, private/node_modules excluded) with real json5@2.2.3, yaml@2.9.1, and jsonc-parser@3.3.1 dependency tarballs; installed globally via --ignore-scripts at ${binExecutable}`,
        R02: `Initialized all 8 harnesses (${HARNESS_CHOICES.join(", ")}); non-TTY missing selection, --harness auto, and cancelled prompt fail closed without writes`,
        R03: `Source-verified native routes and skills validated for all 8 harnesses; doctor verified targetHarness and excluded OMP-only checks for non-OMP`,
        R04: `Mixed managed-block human notes, JSONC/JSON5/YAML/TOML secrets, YAML #/multiline/anchors, and unrelated files preserved across repeat init and update; dry-run, malformed config, and malformed marker preflight made zero writes`,
        R05: `Persisted schemaVersion 1 installation.json (including custom root and Cursor projectRoot) verified across all 8 harnesses and respected by doctor/update`,
        R06: `Upgraded global bin, installation.json, and target VERSION from ${packInfo.pkgJson.version} to ${deriveHigherVersion(packInfo.pkgJson.version, 1)} via loopback registry without Git; bounded unreachable registry exited nonzero`,
        R07: `Single package nullform-workflow with nullform CLI backed by installHarness`,
        R08: `Verified tarball delivered at ${deliveredTarball} and upgraded via loopback registry ${registry.url}`,
      },
      outcomes: {
        globalInstall: "passed",
        harnesses: HARNESS_CHOICES,
        updatedHarnesses: HARNESS_CHOICES,
        doctor: "passed",
        boundaries: "passed",
        registryUpgrade: "passed",
      },
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (releaseHostLock) {
      try { releaseHostLock(); } catch {}
    }
    if (releaseInProcess) releaseInProcess();
    let cleanupError = null;
    if (ctx) {
      try { await ctx.dispose(); } catch (err) { cleanupError ||= err; }
    }
    if (registry) {
      try { await registry.close(); } catch (err) { cleanupError ||= err; }
    }
    if (!keepTemp && !primaryError && existsSync(baseTemp)) {
      try {
        rmSync(baseTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        cleanupError ||= err;
      }
    }
    if (primaryError && existsSync(baseTemp)) {
      try { primaryError.diagnosticsPath = baseTemp; } catch {}
      console.error(`[npm-smoke] Failure diagnostics preserved at ${baseTemp}`);
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
  let tarballPath = null;
  const tarballIdx = process.argv.indexOf("--tarball");
  if (tarballIdx !== -1 && process.argv[tarballIdx + 1]) {
    tarballPath = process.argv[tarballIdx + 1];
  } else {
    const tarballEq = process.argv.find((a) => a.startsWith("--tarball="));
    if (tarballEq) tarballPath = tarballEq.slice("--tarball=".length);
  }
  runSmoke({ keepTemp, tarballPath })
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
