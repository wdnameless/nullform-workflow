import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { detectInstall, suggestUpgrade, detectConflicts } from "../install-detect.mjs";
import { doctorLite } from "../doctor-lite.mjs";
import { cmdStart, cmdCheck } from "../workflow.mjs";
import { installHarness } from "../install-harness.mjs";

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "u-install-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setupValidHarnessFixture(dir) {
  mkdirSync(join(dir, "agent"), { recursive: true });
  mkdirSync(join(dir, "rules"), { recursive: true });
  mkdirSync(join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });

  writeFileSync(join(dir, "agent", "AGENTS.md"), "# Agents\n", "utf8");
  writeFileSync(join(dir, "rules", "enterprise-directives.md"), "# Directives\n", "utf8");
  writeFileSync(join(dir, "core", "PORTABLE.md"), "# Portable\n", "utf8");
  writeFileSync(join(dir, "CONTEXT.md"), "# Context\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# Readme\n", "utf8");
  writeFileSync(join(dir, "tools", "workflow.mjs"), "export const ok = true;\n", "utf8");
}

// ---------------------------------------------------------------------------
// 1. detectInstall (R01)
// ---------------------------------------------------------------------------

test("detectInstall: returns present: false when no installation exists", () => {
  withTmpDir((tmp) => {
    const res = detectInstall(tmp);
    assert.equal(res.present, false);
    assert.equal(res.version, null);
    assert.equal(res.root, null);
    assert.deepEqual(res.conflicts, []);
  });
});

test("detectInstall: detects installation via .nullform/installation.json (v1.2.0 vs v1.3.0)", () => {
  withTmpDir((tmp) => {
    const nullformDir = join(tmp, ".nullform");
    mkdirSync(nullformDir, { recursive: true });
    const targetRoot = join(tmp, "installed-root");
    mkdirSync(targetRoot, { recursive: true });

    writeFileSync(
      join(nullformDir, "installation.json"),
      JSON.stringify({
        schemaVersion: 1,
        harness: "omp",
        root: targetRoot,
        userHome: tmp,
        version: "1.2.0",
      }),
      "utf8"
    );

    const res1 = detectInstall(tmp);
    assert.equal(res1.present, true);
    assert.equal(res1.version, "1.2.0");
    assert.equal(res1.root, targetRoot);

    // Update to 1.3.0
    writeFileSync(
      join(nullformDir, "installation.json"),
      JSON.stringify({
        schemaVersion: 1,
        harness: "omp",
        root: targetRoot,
        userHome: tmp,
        version: "1.3.0",
      }),
      "utf8"
    );

    const res2 = detectInstall(tmp);
    assert.equal(res2.present, true);
    assert.equal(res2.version, "1.3.0");
  });
});

test("detectInstall: detects installation via .omp/agent/.harness-root and VERSION", () => {
  withTmpDir((tmp) => {
    const harnessRoot = join(tmp, "custom-harness");
    mkdirSync(harnessRoot, { recursive: true });
    writeFileSync(join(harnessRoot, "VERSION"), "1.2.0\n", "utf8");

    const agentDir = join(tmp, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, ".harness-root"), harnessRoot + "\n", "utf8");

    const res = detectInstall(tmp);
    assert.equal(res.present, true);
    assert.equal(res.version, "1.2.0");
    assert.equal(res.root, harnessRoot);
  });
});

test("detectInstall: detects installation directly from VERSION in homeDir", () => {
  withTmpDir((tmp) => {
    writeFileSync(join(tmp, "VERSION"), "1.3.0\n", "utf8");
    const res = detectInstall(tmp);
    assert.equal(res.present, true);
    assert.equal(res.version, "1.3.0");
    assert.equal(res.root, tmp);
  });
});

// ---------------------------------------------------------------------------
// 2. suggestUpgrade (R02)
// ---------------------------------------------------------------------------

test("suggestUpgrade: suggests upgrade when cur < latest", () => {
  const up = suggestUpgrade("1.2.0", "1.3.0");
  assert.equal(up.needed, true);
  assert.equal(up.current, "1.2.0");
  assert.equal(up.latest, "1.3.0");
  assert.equal(typeof up.message, "string");
  assert.match(up.message, /1\.2\.0/);
  assert.match(up.message, /1\.3\.0/);
  assert.equal(up.command, "nullform update");
});

test("suggestUpgrade: does not suggest upgrade when cur >= latest", () => {
  const upSame = suggestUpgrade("1.3.0", "1.3.0");
  assert.equal(upSame.needed, false);
  assert.equal(upSame.command, null);

  const upNewer = suggestUpgrade("1.4.0", "1.3.0");
  assert.equal(upNewer.needed, false);
});

// ---------------------------------------------------------------------------
// 3. detectConflicts (R03)
// ---------------------------------------------------------------------------

test("detectConflicts: detects .autopilot/ fixture with removal advice, never deletes files", () => {
  withTmpDir((tmp) => {
    const apDir = join(tmp, ".autopilot");
    mkdirSync(apDir, { recursive: true });
    writeFileSync(join(apDir, "ap.py"), "# autopilot runner\n", "utf8");

    const conflicts = detectConflicts(tmp);
    assert.ok(conflicts.length >= 1);
    const apConflict = conflicts.find((c) => c.marker === ".autopilot");
    assert.ok(apConflict);
    assert.equal(apConflict.path, apDir);
    assert.match(apConflict.advice, /rm/i);

    // Invariant: NEVER delete or move anything
    assert.equal(existsSync(apDir), true);
    assert.equal(existsSync(join(apDir, "ap.py")), true);
  });
});

test("detectConflicts: detects foreign skills and foreign CLAUDE.md routes", () => {
  withTmpDir((tmp) => {
    const foreignSkills = join(tmp, ".skills");
    mkdirSync(foreignSkills, { recursive: true });
    writeFileSync(join(foreignSkills, "some-skill.md"), "# foreign\n", "utf8");

    const claudePath = join(tmp, "CLAUDE.md");
    writeFileSync(claudePath, "# Rules\nRoute all tasks to .autopilot/ap.py\n", "utf8");

    const conflicts = detectConflicts(tmp);
    assert.ok(conflicts.length >= 2);

    const skillConf = conflicts.find((c) => c.marker === ".skills");
    assert.ok(skillConf);
    assert.match(skillConf.advice, /rm/i);

    const claudeConf = conflicts.find((c) => c.marker === "CLAUDE.md");
    assert.ok(claudeConf);
    assert.match(claudeConf.advice, /rm/i);

    // Invariant: untouched
    assert.equal(existsSync(foreignSkills), true);
    assert.equal(existsSync(claudePath), true);
  });
});

// ---------------------------------------------------------------------------
// 4. doctorLite (R04)
// ---------------------------------------------------------------------------

test("doctorLite: passes on complete valid fixture within 2000ms", () => {
  withTmpDir((tmp) => {
    setupValidHarnessFixture(tmp);

    const res = doctorLite(tmp);
    assert.equal(res.ok, true);
    assert.deepEqual(res.warns, []);
    assert.ok(res.ms <= 2000, `doctorLite exceeded 2000ms: took ${res.ms}ms`);
  });
});
test("doctorLite: passes on live repository root within 2000ms", () => {
  const res = doctorLite(".");
  assert.equal(res.ok, true);
  assert.deepEqual(res.warns, []);
  assert.ok(res.ms <= 2000, `doctorLite on repo root exceeded 2000ms: took ${res.ms}ms`);
});


test("doctorLite: returns warns and ok: false on missing harness files", () => {
  withTmpDir((tmp) => {
    // Empty directory missing all harness files and tools
    const res = doctorLite(tmp);
    assert.equal(res.ok, false);
    assert.ok(res.warns.length > 0);
    assert.ok(res.ms <= 2000);
  });
});

test("doctorLite: flags syntax errors in tools/ via node --check", () => {
  withTmpDir((tmp) => {
    setupValidHarnessFixture(tmp);
    writeFileSync(join(tmp, "tools", "broken.mjs"), "const x = ;;;; }}\n", "utf8");

    const res = doctorLite(tmp);
    assert.equal(res.ok, false);
    assert.ok(res.warns.some((w) => w.includes("broken.mjs") || w.includes("Syntax")));
    assert.ok(res.ms <= 2000);
  });
});

test("doctorLite: verifies skills-lock when present", () => {
  withTmpDir((tmp) => {
    setupValidHarnessFixture(tmp);

    const skillDir = join(tmp, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    const content = "# My Skill\n";
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");

    const lockPath = join(tmp, "skills-lock.json");
    writeFileSync(lockPath, JSON.stringify({ skills: { "my-skill": hash } }), "utf8");

    const okRes = doctorLite(tmp);
    assert.equal(okRes.ok, true);

    // Tamper with skill content
    writeFileSync(join(skillDir, "SKILL.md"), "# Tampered Skill\n", "utf8");
    const badRes = doctorLite(tmp);
    assert.equal(badRes.ok, false);
    assert.ok(badRes.warns.some((w) => w.includes("skills-lock")));
  });
});

test("workflow start and check: call doctorLite without changing exit code", () => {
  withTmpDir((tmp) => {
    // Empty directory: doctorLite is not ok, but cmdStart and cmdCheck still succeed
    const code = cmdStart(tmp, { tier: "T0", task: "doctor-lite-hook-test" });
    assert.equal(code, 0);

    const checkCode = cmdCheck(tmp);
    assert.equal(checkCode, 0);
  });
});

test("installHarness: integrates detectInstall, records detection/upgrade/conflicts on plan", () => {
  withTmpDir((tmp) => {
    const userHome = join(tmp, "home");
    const targetRoot = join(tmp, "installed");
    mkdirSync(join(userHome, ".nullform"), { recursive: true });
    mkdirSync(targetRoot, { recursive: true });

    writeFileSync(
      join(userHome, ".nullform", "installation.json"),
      JSON.stringify({
        schemaVersion: 1,
        harness: "claude",
        root: targetRoot,
        userHome,
        version: "1.2.0",
      }),
      "utf8"
    );

    // Foreign conflict in project
    mkdirSync(join(userHome, ".autopilot"), { recursive: true });

    const plan = installHarness({
      harness: "claude",
      root: targetRoot,
      userHome,
      dryRun: true,
    });

    assert.ok(plan.detection);
    assert.equal(plan.detection.present, true);
    assert.equal(plan.detection.version, "1.2.0");
    assert.ok(plan.upgrade);
    assert.equal(plan.upgrade.needed, true);
    assert.ok(plan.conflicts.length > 0);
    assert.ok(plan.warnings.some((w) => w.includes("Conflict with .autopilot")));
  });
});
