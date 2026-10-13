import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTempDir } from "./test-helpers.mjs";
import { installHarness } from "../install-harness.mjs";
import { CORE_FILES, getStateFilePath, readInstallationState } from "../installation-state.mjs";
import { hashContent, resolveRuntimePackageDir, RUNTIME_PARSER_DEPS } from "../harness-config.mjs";
import { deriveHigherVersion } from "../package-archive.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "tools/install-harness.mjs");

test("actual skill asset ownership transition across versions preserves user edits and propagates unchanged scripts and binaries", async () => {
  const tempRoot = createTempDir("harness-asset-transition-root-");
  const tempHome = createTempDir("harness-asset-transition-home-");
  try {
    const res1 = spawnSync(process.execPath, [
      SCRIPT_PATH, "--harness", "opencode", "--root", tempRoot, "--user-home", tempHome, "--json",
    ], { encoding: "utf8" });
    assert.equal(res1.status, 0, `Initial install failed: ${res1.stderr}`);
    const plan1 = JSON.parse(res1.stdout);

    const skillsDir = join(tempHome, ".config", "opencode", "skills");
    const pyAsset = join(skillsDir, "ui-ux-pro-max", "scripts", "core.py");
    const userModifiedAsset = join(skillsDir, "ui-ux-pro-max", "scripts", "validate_data.py");
    const binaryAsset = join(skillsDir, "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf");
    const skillMd = join(skillsDir, "ui-ux-pro-max", "SKILL.md");

    assert.ok(existsSync(pyAsset), "Script asset must exist after initial deploy");
    assert.ok(existsSync(userModifiedAsset), "Script asset to be user-modified must exist");
    assert.ok(existsSync(binaryAsset), "Binary font asset must exist after initial deploy");
    assert.ok(existsSync(skillMd), "Markdown skill prompt must exist after initial deploy");

    assert.ok(plan1.managedFiles[pyAsset], "Managed hash must be recorded for .py script");
    assert.ok(plan1.managedFiles[userModifiedAsset], "Managed hash must be recorded for user script");
    assert.ok(plan1.managedFiles[binaryAsset], "Managed hash must be recorded for binary .ttf asset");
    assert.ok(plan1.managedFiles[skillMd], "Managed hash must be recorded for .md prompt");

    const originalPyHash = plan1.managedFiles[pyAsset];
    const originalUserHash = plan1.managedFiles[userModifiedAsset];
    const originalBinaryHash = plan1.managedFiles[binaryAsset];

    const humanCustomNote = "# Human local custom modifications to validate_data.py\n";
    writeFileSync(userModifiedAsset, humanCustomNote, "utf8");

    const unownedFile = join(skillsDir, "ui-ux-pro-max", "scripts", "custom_helper.py");
    writeFileSync(unownedFile, "# Human unowned helper\n", "utf8");

    const newPyContent = "# Upgraded package core.py v2.0.0\n";
    const newValidateContent = "# Upgraded package validate_data.py v2.0.0\n";
    const newBinaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xaa, 0x55]);

    const rootSkillsDir = join(tempRoot, "skills");
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "core.py"), newPyContent, "utf8");
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "validate_data.py"), newValidateContent, "utf8");
    writeFileSync(join(rootSkillsDir, "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf"), newBinaryContent);
    writeFileSync(join(rootSkillsDir, "ui-ux-pro-max", "scripts", "custom_helper.py"), "# Shipped package helper\n", "utf8");

    const { installHarness: installV2Harness } = await import(
      pathToFileURL(join(tempRoot, "tools", "install-harness.mjs")).href
    );
    const plan2 = installV2Harness({
      harness: "opencode",
      root: tempRoot,
      userHome: tempHome,
      managedFiles: plan1.managedFiles,
    });

    assert.equal(readFileSync(pyAsset, "utf8"), newPyContent, "Unchanged owned .py asset must update from new package");
    assert.notEqual(plan2.managedFiles[pyAsset], originalPyHash, "Managed hash for updated .py asset must change");

    assert.deepEqual(readFileSync(binaryAsset), newBinaryContent, "Unchanged owned binary asset must update from new package");
    assert.notEqual(plan2.managedFiles[binaryAsset], originalBinaryHash, "Managed hash for updated binary asset must change");

    assert.equal(readFileSync(userModifiedAsset, "utf8"), humanCustomNote, "Locally modified user asset must stay untouched");
    assert.equal(plan2.managedFiles[userModifiedAsset], originalUserHash, "Locally modified asset must retain prior hash in managedFiles");

    assert.equal(readFileSync(unownedFile, "utf8"), "# Human unowned helper\n", "Unowned human file must not be overwritten by package");

    const lockDir = join(tempHome, ".agents");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, ".skill-lock.json"), JSON.stringify({ skills: { "ui-ux-pro-max": { version: "1.0.0" } } }), "utf8");
    writeFileSync(join(lockDir, ".skills-disabled.json"), JSON.stringify({ disabled: ["web-search"] }), "utf8");

    const testLockedFile = join(skillsDir, "ui-ux-pro-max", "scripts", "test_core.py");
    if (existsSync(testLockedFile)) rmSync(testLockedFile, { force: true });

    installV2Harness({
      harness: "opencode",
      root: tempRoot,
      userHome: tempHome,
      managedFiles: plan2.managedFiles,
    });
    assert.equal(existsSync(testLockedFile), false, "Locked skill must be skipped by installer");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function copyPublicPackageFixture(dest) {
  const entries = [
    ...CORE_FILES, "LICENSE", "bin", "core", "rules", "skills", "templates", "paseo",
    "agent/AGENTS.md", "agent/plugins.json", "agent/agents", "agent/extensions",
  ];
  for (const entry of readdirSync(join(REPO_ROOT, "agent"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.includes(".example")) entries.push(`agent/${entry.name}`);
  }
  for (const entry of readdirSync(join(REPO_ROOT, "tools"), { withFileTypes: true })) {
    if (entry.isFile() && (/\.(mjs|cjs|ts|py|ps1|sh)$/.test(entry.name) || entry.name === "sync-manifest.json")) {
      entries.push(`tools/${entry.name}`);
    }
  }
  for (const entry of entries) {
    cpSync(join(REPO_ROOT, entry), join(dest, entry), {
      recursive: true, filter: (path) => ![".git", ".tmp", "node_modules", "__pycache__"].includes(basename(path)),
    });
  }
  for (const name of RUNTIME_PARSER_DEPS) {
    const src = resolveRuntimePackageDir(name, REPO_ROOT);
    assert.ok(src, `Installed public parser dependency required: ${name}`);
    cpSync(src, join(dest, "tools", "node_modules", name), { recursive: true, dereference: true });
  }
}

function runPublicInit(packageRoot, harness, root, home, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    join(packageRoot, "bin", "nullform.mjs"), "init", "--harness", harness, "--root", root,
    "--user-home", home, "--yes", "--json", "--skip-release-check", ...extraArgs,
  ], { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: join(home, ".hermes") } });
  assert.equal(result.error, undefined, "Public CLI must remain within the default output buffer");
  return { result, payload: JSON.parse(result.stdout) };
}

function publicInit(packageRoot, harness, root, home, extraArgs = []) {
  const { result, payload } = runPublicInit(packageRoot, harness, root, home, extraArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(payload.ok, true);
  return { result, payload };
}

function appendFixtureBytes(path, suffix) {
  const bytes = Buffer.concat([readFileSync(path), Buffer.from(suffix)]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

function makeLinkOrSkip(t, targetPath, linkPath) {
  try {
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (err) {
    if (err.code === "EPERM") {
      t.skip("symlink privilege unavailable");
      return false;
    }
    throw err;
  }
}

function linkTarget(linkPath) {
  const raw = readlinkSync(linkPath);
  return resolve(dirname(linkPath), raw);
}

function assertCustomRosterLinkIntact(t, sandbox) {
  const pkg = join(sandbox, "package"), root = join(sandbox, "target"), home = join(sandbox, "home");
  const customRoles = join(home, "custom-roles");
  for (const dir of [pkg, root, home, customRoles]) mkdirSync(dir, { recursive: true });
  copyPublicPackageFixture(pkg);
  const customRole = join(customRoles, "orchestrator.md");
  writeFileSync(customRole, "# HUMAN CUSTOM ORCHESTRATOR ROLE\n", "utf8");
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  const rosterLink = join(home, ".omp", "agent", "agents");
  if (!makeLinkOrSkip(t, customRoles, rosterLink)) return;
  return { pkg, root, home, customRoles, customRole, rosterLink };
}

test("public OMP --dry-run is a pure preview: custom agents link and role bytes survive untouched", (t) => {
  const sandbox = createTempDir("public-roster-dryrun-");
  try {
    const fx = assertCustomRosterLinkIntact(t, sandbox);
    if (!fx) return;
    const { result, payload } = publicInit(fx.pkg, "omp", fx.root, fx.home, ["--dry-run"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(lstatSync(fx.rosterLink).isSymbolicLink(), true, "Dry-run must not remove the custom roster link");
    assert.equal(linkTarget(fx.rosterLink), resolve(fx.customRoles), "Dry-run must not redirect the custom link");
    assert.equal(readFileSync(fx.customRole, "utf8"), "# HUMAN CUSTOM ORCHESTRATOR ROLE\n", "Human role bytes must survive dry-run");
    assert.equal(existsSync(getStateFilePath(fx.home)), false, "Dry-run must not write installation identity");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("public OMP real init preserves an unknown custom agents link and its human role bytes", (t) => {
  const sandbox = createTempDir("public-roster-apply-");
  try {
    const fx = assertCustomRosterLinkIntact(t, sandbox);
    if (!fx) return;
    const { result } = runPublicInit(fx.pkg, "omp", fx.root, fx.home);
    // Doctor may warn or fail on the incomplete custom roster; bytes and link must survive either way.
    assert.ok(Number.isInteger(result.status), "Public CLI must terminate deterministically");
    assert.equal(lstatSync(fx.rosterLink).isSymbolicLink(), true, "Unknown custom link must not be unlinked");
    assert.equal(linkTarget(fx.rosterLink), resolve(fx.customRoles), "Unknown custom link must not be silently redirected");
    assert.equal(readFileSync(fx.customRole, "utf8"), "# HUMAN CUSTOM ORCHESTRATOR ROLE\n", "Human role bytes must survive real install");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("public OMP init preserves unowned and modified-owned assets while advancing unchanged assets across real package versions", () => {
  const sandbox = createTempDir("public-asset-transitions-");
  const pkg = join(sandbox, "package"), root = join(sandbox, "target"), home = join(sandbox, "home");
  try {
    mkdirSync(pkg);
    mkdirSync(root);
    mkdirSync(home);
    copyPublicPackageFixture(pkg);
    const core = join(root, "tools", "workflow.mjs");
    const guard = join(home, ".omp", "agent", "extensions", "nullform-delete-guard.ts");
    const role = join(home, ".omp", "agent", "agents", "fixer.md");
    const unowned = new Map();
    for (const [dest, src] of [[core, "tools/workflow.mjs"], [guard, "agent/extensions/nullform-delete-guard.ts"], [role, "agent/agents/fixer.md"]]) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(pkg, src), dest);
      unowned.set(dest, appendFixtureBytes(dest, "\n// HUMAN UNOWNED MODIFICATION\n"));
    }
    const law = join(root, "agent", "AGENTS.md");
    const lawBytes = Buffer.from(readFileSync(join(pkg, "agent", "AGENTS.md"), "utf8").split("<HARNESS>").join(root.replace(/\\/g, "/")) + "\n<!-- HUMAN ROOT LAW -->\n");
    mkdirSync(dirname(law), { recursive: true });
    writeFileSync(law, lawBytes);
    unowned.set(law, lawBytes);
    publicInit(pkg, "omp", root, home);
    let state = readInstallationState(home);
    for (const [path, bytes] of unowned) {
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(state.managedFiles[path], undefined, "Human bytes must not be adopted as owned");
    }
    const changed = new Map();
    const priorHashes = new Map();
    for (const path of [
      join(root, "tools", "harness-capabilities.mjs"),
      join(home, ".agents", "skills", "ui-ux-pro-max", "scripts", "validate_data.py"),
    ]) {
      assert.equal(state.managedFiles[path], hashContent(readFileSync(path)));
      priorHashes.set(path, state.managedFiles[path]);
      changed.set(path, appendFixtureBytes(path, path.endsWith(".py") ? "\n# HUMAN OWNED MODIFICATION\n" : "\n// HUMAN OWNED MODIFICATION\n"));
    }
    const parser = join(root, "tools", "node_modules", "json5", "package.json");
    priorHashes.set(parser, state.managedFiles[parser]);
    assert.equal(priorHashes.get(parser), hashContent(readFileSync(parser)));
    const parserBytes = Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(parser, "utf8")), humanNote: "KEEP" }) + "\n");
    writeFileSync(parser, parserBytes);
    changed.set(parser, parserBytes);
    const jev = join(home, ".omp", "agent", "extensions", "nullform-jev.ts");
    const unchangedCore = join(root, "tools", "installation-state.mjs");
    const fontRel = join("skills", "ui-styling", "canvas-fonts", "YoungSerif-Regular.ttf");
    const font = join(home, ".agents", fontRel);
    const baseVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
    for (const step of [1, 2]) {
      if (step === 2) {
        priorHashes.set(jev, state.managedFiles[jev]);
        changed.set(jev, appendFixtureBytes(jev, "\n// HUMAN OWNED JEV MODIFICATION\n"));
      }
      const version = deriveHigherVersion(baseVersion, step);
      const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...metadata, version }, null, 2) + "\n");
      writeFileSync(join(pkg, "VERSION"), version + "\n");
      for (const rel of ["tools/workflow.mjs", "tools/harness-capabilities.mjs", "tools/installation-state.mjs", "agent/extensions/nullform-jev.ts", "agent/extensions/nullform-delete-guard.ts"]) {
        appendFixtureBytes(join(pkg, rel), `\n// PACKAGE VERSION ${version}\n`);
      }
      const newFont = appendFixtureBytes(join(pkg, fontRel), Buffer.from([0, 255, step]));
      publicInit(pkg, "omp", root, home);
      state = readInstallationState(home);
      assert.equal(state.version, version);
      assert.equal(readFileSync(join(root, "VERSION"), "utf8"), version + "\n");
      for (const [path, bytes] of unowned) {
        assert.deepEqual(readFileSync(path), bytes);
        assert.equal(state.managedFiles[path], undefined);
      }
      for (const [path, bytes] of changed) {
        assert.deepEqual(readFileSync(path), bytes);
        assert.equal(state.managedFiles[path], priorHashes.get(path), "Modified owned bytes retain their prior ownership hash");
      }
      const incomingCore = readFileSync(join(pkg, "tools", "installation-state.mjs"));
      assert.deepEqual(readFileSync(unchangedCore), incomingCore);
      assert.equal(state.managedFiles[unchangedCore], hashContent(incomingCore));
      assert.deepEqual(readFileSync(font), newFont);
      assert.equal(state.managedFiles[font], hashContent(newFont));
      if (step === 1) {
        const incomingJev = readFileSync(join(pkg, "agent", "extensions", "nullform-jev.ts"));
        assert.deepEqual(readFileSync(jev), incomingJev);
        assert.equal(state.managedFiles[jev], hashContent(incomingJev));
      }
    }
    const preview = installHarness({ harness: "omp", root, userHome: home, managedFiles: state.managedFiles, dryRun: true });
    assert.ok(preview.preservedAssets.modifiedOwned >= changed.size);
    assert.ok(preview.preservedAssets.examples.length <= 3, "Preservation diagnostics must stay bounded");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("public in-place init (root == package) never rewrites the live tree or adopts its bytes as owned", () => {
  const sandbox = createTempDir("public-inplace-");
  const pkg = join(sandbox, "package"), home = join(sandbox, "home");
  try {
    mkdirSync(pkg);
    mkdirSync(home);
    copyPublicPackageFixture(pkg);
    const core = join(pkg, "tools", "workflow.mjs");
    const humanBytes = appendFixtureBytes(core, "\n// HUMAN LIVE-TREE MODIFICATION\n");
    publicInit(pkg, "omp", pkg, home);
    assert.deepEqual(readFileSync(core), humanBytes, "In-place init must not rewrite the live tree");
    const state = readInstallationState(home);
    assert.equal(state.managedFiles[core], undefined, "In-place root bytes must not be adopted as newly owned");
    assert.equal(state.managedFiles[join(pkg, "VERSION")], undefined);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
