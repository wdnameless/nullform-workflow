#!/usr/bin/env node
/**
 * tools/npm-smoke-harness.mjs — Per-harness npm smoke lifecycle verification
 * (init/doctor/seed) shared with tools/npm-smoke.mjs.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildHarnessFixture, seedHarnessFiles } from "./package-archive.mjs";

// Deployment includes asset copies, durable writes, native adapters, and doctor.
export const DEPLOYMENT_TIMEOUT_MS = 180_000;

export async function verifyHarnessInit(ctx, harness, fixture, customRoot, harnessHome, projectDir, secretToken, pkgVersion) {
  const hermesHostHome = harness === "hermes" ? join(harnessHome, ".hermes") : null;
  const initArgs = [
    "init", "--harness", harness, "--root", customRoot, "--user-home", harnessHome,
    ...(hermesHostHome ? ["--host-home", hermesHostHome] : []),
    ...(projectDir ? ["--project-root", projectDir] : []), "--yes",
  ];

  let firstPassMdSnapshots = {};
  for (let pass = 1; pass <= 2; pass++) {
    const res = await ctx.runInstalledBin(initArgs, { timeoutMs: DEPLOYMENT_TIMEOUT_MS });
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
    if (fixture.mdSoul && pass === 1) {
      // SOUL.md is identity: adaptive installer must leave human bytes untouched, no managed block.
      const soul = readFileSync(fixture.mdSoul, "utf8");
      assert.ok(soul.includes(fixture.humanBefore) && soul.includes(fixture.humanAfter), "R04: Human SOUL notes lost");
      assert.equal(soul.includes("NULLFORM WORKFLOW"), false, "R04: Installer must not write managed policy into SOUL.md");
    }
    if (fixture.mdHomeAgents && pass === 1) {
      const home = readFileSync(fixture.mdHomeAgents, "utf8");
      assert.ok(home.includes(fixture.humanBefore) && home.includes(fixture.humanAfter), "R04: Human home AGENTS notes lost");
      assert.equal(home.includes("NULLFORM WORKFLOW"), false, "R04: Installer must not write managed policy into home AGENTS.md");
    }
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

    if (harness === "omp") {
          assert.equal(existsSync(fixture.skillsDir), true, `R03: Skills directory missing at ${fixture.skillsDir} for ${harness}`);
          const skills = readdirSync(fixture.skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
          assert.ok(skills.length > 0, `R03: No skills installed in ${fixture.skillsDir} for ${harness}`);
        } else if (harness === "hermes") {
          const nativePath = fixture.cfgFiles.at(-1);
          const config = createRequire(import.meta.url)("yaml").parse(readFileSync(nativePath, "utf8"));
          const prompt = config.agent.system_prompt;
          assert.equal(prompt.split("<!-- BEGIN NULLFORM WORKFLOW -->").length - 1, 1, "R03: Native prompt needs exactly one owned block");
          assert.equal(prompt.split("<!-- END NULLFORM WORKFLOW -->").length - 1, 1, "R03: Native prompt block must be complete");
          assert.equal(existsSync(fixture.skillsDir), false, "R03: Native prompt activation must not copy a duplicate skill");
        } else if (harness === "cursor") {
          // Cursor is project-scoped: target-root skills/ is legitimate project context, not a home catalogue.
          assert.equal(existsSync(fixture.skillsDir), true, `R03: Cursor project skills missing at ${fixture.skillsDir}`);
        } else {
          // Adaptive non-OMP: no bulk home-skill catalogue by design (doctor reports skills:skip).
          assert.equal(existsSync(fixture.skillsDir), false, `R03: Unexpected bulk skills catalogue at ${fixture.skillsDir} for adaptive ${harness}`);
        }
    if (fixture.noSymlinkSkills && existsSync(fixture.skillsDir)) {
      for (const entry of readdirSync(fixture.skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
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

export async function verifyHarnessDoctor(ctx, harness, harnessHome) {
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
    // Adaptive non-OMP reports skills:skip (no bulk catalogue by design); OMP still requires pass.
    assert.equal(skillsCheck?.status, "skip", `R03: skills check must skip for adaptive ${harness}`);
    const runtimeCheck = (docJson.checks || []).find((c) => c.id === "host-runtime");
    assert.ok(runtimeCheck, `R03: host-runtime check must be present for ${harness}`);
    assert.notEqual(runtimeCheck.status, "fail", `R03: Missing host runtime for ${harness} must be SETUP/warn, never FAIL`);
  }
}

export async function seedAndVerifyHarness(ctx, harness, pkgVersion) {
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
