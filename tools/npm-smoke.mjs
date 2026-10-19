#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  closeSync,
  cpSync,
  existsSync,
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
} from "./package-archive.mjs";
import { DEPLOYMENT_TIMEOUT_MS, seedAndVerifyHarness } from "./npm-smoke-harness.mjs";
export { computeFileDigests, deriveHigherVersion, resolveNpmInvocation, safeExtractArchive, inspectArchiveContents };

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
  for (const k of [...Object.keys(isolatedEnv).filter(key => key.startsWith("HERMES_")), "OMP_CONFIG_DIR", "OPENHUMAN_WORKSPACE", "OPENCLAW_CONFIG_PATH", "NULLFORM_RELEASE_URL", "NULLFORM_REGISTRY"]) {
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
      return spawnAsync(command, fullArgs, {
        cwd: options.cwd || spaceBase,
        env,
        input: options.input ?? "",
        timeoutMs: options.timeoutMs ?? 60_000,
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
  const reqs = ["package.json", "VERSION", "LICENSE", "jev/LICENSE", "README.md", "CONTEXT.md", ".code-size.baseline.json", "bin/nullform.mjs", "tools/install-harness.mjs", "tools/installation/config.mjs", "tools/installation/state.mjs", "tools/doctor.mjs", "tools/self-update.mjs", "tools/workflow.mjs", "tools/verify.mjs", "tools/sync-manifest.json", "verify.ps1", "verify.sh"];
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

  // Portable assets live under the installation root; OMP keeps no home skill catalogue.
  const ompSkills = join(ctx.spaceBase, "root_omp", "skills");
  const ownedSkillFile = join(ompSkills, "ui-ux-pro-max", "scripts", "core.py");
  const userSkillFile = join(ompSkills, "ui-ux-pro-max", "scripts", "validate_data.py");
  writeFileSync(userSkillFile, "# User edit to validate_data.py preserved\n", "utf8");
  writeFileSync(join(vUpSource, "skills", "ui-ux-pro-max", "scripts", "core.py"), `# Upgraded core.py v${upgradeVersion}\n`, "utf8");
  writeFileSync(join(vUpSource, "skills", "ui-ux-pro-max", "scripts", "validate_data.py"), `# Upgraded validate_data.py v${upgradeVersion}\n`, "utf8");
  assert.equal(existsSync(join(ctx.spaceBase, "home_omp", ".agents", "skills")), false, "R03/R06: OMP update must not create a home skill catalogue");
  // A pre-existing human global skill catalogue is not ours: it must survive the update
  // byte-identically and must not be joined by an installer-created catalogue.
  const humanGlobalSkills = join(ctx.spaceBase, "home_omp", ".agents", "skills");
  const humanGlobalSkill = join(humanGlobalSkills, "human-owned", "SKILL.md");
  mkdirSync(dirname(humanGlobalSkill), { recursive: true });
  writeFileSync(humanGlobalSkill, "# Human global skill\nNever adopt or rewrite.\n", "utf8");
  assert.equal((await ctx.runNpm(["pack", "--ignore-scripts", "--pack-destination", ctx.tempPackDir], vUpSource)).status, 0);
  const vUpTarballPath = join(ctx.tempPackDir, `nullform-workflow-${upgradeVersion}.tgz`);

  registry.addPackage({ name: "nullform-workflow", version: upgradeVersion, tarballPath: vUpTarballPath, manifest: vUpPkg });
  const metaRes = await fetch(`${registry.url}/nullform-workflow`);
  assert.equal(metaRes.status, 200);
  assert.equal((await metaRes.json())["dist-tags"]?.latest, upgradeVersion);

  const opencodeHome = join(ctx.spaceBase, "home_omp");
  const opencodeRoot = join(ctx.spaceBase, "root_omp");
  const envReg = { npm_config_registry: registry.url, NPM_CONFIG_REGISTRY: registry.url, NULLFORM_REGISTRY: registry.url };
  const updateRes = await ctx.runInstalledBin(["update", "--yes", "--user-home", opencodeHome, "--registry", registry.url], { extraEnv: envReg, timeoutMs: DEPLOYMENT_TIMEOUT_MS });
  assert.equal(updateRes.status, 0, `R06: update failed (status: ${updateRes.status}, elapsed: ${updateRes.elapsedMs}ms): ${updateRes.stderr || updateRes.stdout}`);
  assert.equal((await ctx.runInstalledBin(["--version"])).stdout.trim(), upgradeVersion);

  const updatedState = JSON.parse(readFileSync(join(opencodeHome, ".nullform", "installation.json"), "utf8"));
  assert.equal(updatedState.version, upgradeVersion);
  assert.equal(readFileSync(join(opencodeRoot, "VERSION"), "utf8").trim(), upgradeVersion);
  assert.equal(readFileSync(ownedSkillFile, "utf8"), `# Upgraded core.py v${upgradeVersion}\n`, "R03/R06: Owned asset updated");
  assert.equal(readFileSync(humanGlobalSkill, "utf8"), "# Human global skill\nNever adopt or rewrite.\n", "R03/R06: Human global skill must stay byte-identical across update");
  assert.deepEqual(readdirSync(humanGlobalSkills), ["human-owned"], "R03/R06: Update must not add its own skills to a human global catalogue");
  assert.equal(readFileSync(userSkillFile, "utf8"), "# User edit to validate_data.py preserved\n", "R03/R06: User edit preserved");

  for (const h of HARNESS_CHOICES.filter((c) => c !== "opencode")) {
    const hHome = join(ctx.spaceBase, `home_${h}`);
    const hRoot = join(ctx.spaceBase, `root_${h}`);
    const hProj = h === "cursor" ? join(ctx.spaceBase, `project_${h}`) : null;
    const hSecret = `sk-secret-${h}-98765`;
    const fixture = buildHarnessFixture(h, hRoot, hHome, hProj || hRoot, hSecret);

    const hUp = await ctx.runInstalledBin(["update", "--yes", "--user-home", hHome, "--registry", registry.url], { extraEnv: envReg, timeoutMs: DEPLOYMENT_TIMEOUT_MS });
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
      if (h === "omp") assert.ok(md.includes(hRoot.replace(/\\/g, "/")), `OMP law lost the portable root in ${mdPath}`);
      else assert.ok(md.includes("NULLFORM WORKFLOW"), `Adapter missing in ${mdPath}`);
    }
    // Identity surfaces and seeded legacy assets stay byte-identical across an upgrade.
    for (const identityPath of fixture.mdIdentity) {
      assert.equal(readFileSync(identityPath, "utf8"), fixture.mdContent, `Identity surface altered by update: ${identityPath}`);
    }
    for (const legacyPath of fixture.legacyFiles) {
      assert.equal(readFileSync(legacyPath, "utf8"), fixture.cfgContent, `Legacy asset altered by update: ${legacyPath}`);
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
        R03: `Native configuration surfaces validated for all 8 harnesses; Hermes uses agent.system_prompt without skill copies; doctor configuration checks are not native-session execution evidence`,
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
