import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TOOL = resolve(import.meta.dirname, "../skills-doctor.mjs");

const skillMd = (name) => `---\nname: ${name}\ndescription: "Fixture skill ${name}"\n---\n\nBody of ${name}\n`;

/** installed root is <root>/agents/skills, so the default agents home is <root>/agents. */
function fixture(root, { repo = [], installed = [], disabled = null, brokenDisabled = null } = {}) {
  const agentsHome = join(root, "agents");
  const installedRoot = join(agentsHome, "skills");
  const repoRoot = join(root, "repo/skills");
  for (const [base, names] of [[installedRoot, installed], [repoRoot, repo]]) {
    for (const name of names) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(join(base, name, "SKILL.md"), skillMd(name), "utf8");
    }
  }
  mkdirSync(installedRoot, { recursive: true });
  if (disabled) writeFileSync(join(agentsHome, ".skills-disabled.json"), JSON.stringify(disabled), "utf8");
  if (brokenDisabled) writeFileSync(join(agentsHome, ".skills-disabled.json"), brokenDisabled, "utf8");
  return { agentsHome, installedRoot, repoRoot };
}

function doctor(installedRoot, repoRoot, extra = []) {
  return spawnSync(process.execPath, [TOOL, "--installed", installedRoot, "--repo", repoRoot, ...extra], { encoding: "utf8" });
}

test("skill disabled by the operator and absent from disk is info, not an orphan", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, {
      repo: ["alpha", "beta"],
      installed: ["alpha"],
      disabled: { version: 1, disabled: ["beta"], note: "fixture" },
    });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 0);
    assert.match(res.stdout, /beta: disabled by operator/);
    assert.match(res.stdout, /1 installed, 2 in repo, 1 disabled/);
    assert.doesNotMatch(res.stdout, /beta\s+orphan/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the same tree without the disabled list is reported as an orphan", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, { repo: ["alpha", "beta"], installed: ["alpha"] });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /beta\s+orphan/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a disabled skill that is still on disk escapes the frontmatter check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { agentsHome, installedRoot, repoRoot } = fixture(tmp, { repo: ["alpha"], installed: ["alpha", "beta"] });
    // beta ships an unparsable description quote -> the registry would drop it silently
    writeFileSync(join(installedRoot, "beta", "SKILL.md"), "---\nname: beta\ndescription: \"unclosed\n---\n\nBody\n", "utf8");

    const before = doctor(installedRoot, repoRoot);
    assert.equal(before.status, 1);
    assert.match(before.stdout, /beta\s+frontmatter/);

    writeFileSync(join(agentsHome, ".skills-disabled.json"), JSON.stringify({ version: 1, disabled: ["beta"] }), "utf8");
    const after = doctor(installedRoot, repoRoot);

    assert.equal(after.status, 0);
    assert.match(after.stdout, /beta: disabled by operator \(still on disk/);
    assert.doesNotMatch(after.stdout, /beta\s+frontmatter/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a broken disabled list falls back to an empty list and says so", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, {
      repo: ["alpha", "beta"],
      installed: ["alpha"],
      brokenDisabled: '{ "version": 1, "disabled": ["beta",',
    });

    const res = doctor(installedRoot, repoRoot);

    // The exemption is gone, so the orphan is back — but the reason is stated, not silent.
    assert.equal(res.status, 1);
    assert.match(res.stdout, /invalid JSON/);
    assert.match(res.stdout, /beta\s+orphan/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a broken disabled list on a healthy tree is a note, not a failure", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, {
      repo: ["alpha"],
      installed: ["alpha"],
      brokenDisabled: "not json at all",
    });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 0);
    assert.match(res.stdout, /invalid JSON/);
    assert.match(res.stdout, /all checks passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a disabled list without a 'disabled' array is treated as empty", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, {
      repo: ["alpha", "beta"],
      installed: ["alpha"],
      brokenDisabled: '{ "version": 1, "disabled": "beta" }',
    });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /no 'disabled' array/);
    assert.match(res.stdout, /beta\s+orphan/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("disabled names are normalised: padded, duplicated and non-string entries", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, {
      repo: ["alpha", "beta"],
      installed: ["alpha"],
      disabled: { version: 1, disabled: ["  beta  ", "beta", 42, null, ""] },
    });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 0);
    assert.equal(res.stdout.match(/beta: disabled by operator/g).length, 1);
    assert.match(res.stdout, /1 disabled by operator/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--agents-home reads the disabled list from a directory other than the installed root's parent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, { repo: ["alpha", "beta"], installed: ["alpha"] });
    const ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
    writeFileSync(join(ops, ".skills-disabled.json"), JSON.stringify({ version: 1, disabled: ["beta"] }), "utf8");

    const withoutFlag = doctor(installedRoot, repoRoot);
    assert.equal(withoutFlag.status, 1);

    const withFlag = doctor(installedRoot, repoRoot, ["--agents-home", ops]);
    assert.equal(withFlag.status, 0);
    assert.match(withFlag.stdout, /beta: disabled by operator/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("absent comparison repo reports parity UNVERIFIED and exits nonzero", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot } = fixture(tmp, { installed: ["alpha"] });
    const nonExistentRepo = join(tmp, "does-not-exist/skills");

    const res = doctor(installedRoot, nonExistentRepo);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /parity UNVERIFIED/);
    assert.doesNotMatch(res.stdout, /all checks passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("empty comparison repo reports parity UNVERIFIED and exits nonzero", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, { repo: [], installed: ["alpha"] });

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /parity UNVERIFIED/);
    assert.doesNotMatch(res.stdout, /all checks passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("installed skill drift reports parity problem and exits 1", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, { repo: ["alpha"], installed: ["alpha"] });
    writeFileSync(join(installedRoot, "alpha", "SKILL.md"), skillMd("alpha") + "\n# Extra drifted line\n", "utf8");

    const res = doctor(installedRoot, repoRoot);

    assert.equal(res.status, 1);
    assert.match(res.stdout, /alpha\s+parity/);
    assert.match(res.stdout, /installed copy differs from repo/);
    assert.doesNotMatch(res.stdout, /all checks passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--json outputs structured status including parityStatus", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const { installedRoot, repoRoot } = fixture(tmp, { repo: ["alpha"], installed: ["alpha"] });

    const res = doctor(installedRoot, repoRoot, ["--json"]);

    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.parityStatus, "VERIFIED");
    assert.equal(parsed.installedCount, 1);
    assert.equal(parsed.repoCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deployed script auto-resolves sibling workflow-repo over live skills and detects drift", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-doctor-"));
  try {
    const harness = join(tmp, "harness");
    const agents = join(tmp, "agents");
    const liveSkills = join(harness, "skills");
    const repoDir = join(harness, "workflow-repo");
    const repoSkills = join(repoDir, "skills");
    const installedSkills = join(agents, "skills");

    mkdirSync(join(harness, "tools"), { recursive: true });
    mkdirSync(join(liveSkills, "alpha"), { recursive: true });
    mkdirSync(join(repoDir, "agent"), { recursive: true });
    mkdirSync(join(repoSkills, "alpha"), { recursive: true });
    mkdirSync(join(installedSkills, "alpha"), { recursive: true });

    copyFileSync(TOOL, join(harness, "tools", "skills-doctor.mjs"));
    writeFileSync(join(repoDir, "install.ps1"), "# marker", "utf8");
    writeFileSync(join(repoDir, "agent", "models.yml.example"), "# marker", "utf8");

    // Canonical repo has one content; live and installed both share a drifting content
    const repoContent = skillMd("alpha") + "\n# Repo canonical\n";
    const liveContent = skillMd("alpha") + "\n# Live drifted\n";
    writeFileSync(join(repoSkills, "alpha", "SKILL.md"), repoContent, "utf8");
    writeFileSync(join(liveSkills, "alpha", "SKILL.md"), liveContent, "utf8");
    writeFileSync(join(installedSkills, "alpha", "SKILL.md"), liveContent, "utf8");

    const deployedTool = join(harness, "tools", "skills-doctor.mjs");
    const res = spawnSync(process.execPath, [deployedTool, "--installed", installedSkills, "--agents-home", agents], { encoding: "utf8" });

    // Default must select sibling workflow-repo (canonical), NOT harness/skills (live), so it detects drift!
    assert.equal(res.status, 1);
    assert.match(res.stdout, /alpha\s+parity/);
    assert.match(res.stdout, /installed copy differs from repo/);
    assert.doesNotMatch(res.stdout, /all checks passed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sync.sh does not execute command substitution in skill name or detail", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-sec-"));
  try {
    const canary = join(tmp, "evil-executed.txt");
    const SYNC_SH = resolve(import.meta.dirname, "../sync.sh");
    const bashCandidates = [
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "sh",
      "bash",
    ];
    let shBin = null;
    for (const bin of bashCandidates) {
      if (existsSync(bin)) { shBin = bin; break; }
    }
    if (shBin && existsSync(SYNC_SH)) {
      const repoDir = join(tmp, "repo");
      const harnessDir = join(tmp, "harness");
      const agentsDir = join(tmp, "agents");
      mkdirSync(join(repoDir, "tools"), { recursive: true });
      mkdirSync(join(repoDir, "agent"), { recursive: true });
      mkdirSync(join(repoDir, "skills", "evil$(touch evil-executed.txt)"), { recursive: true });
      mkdirSync(join(harnessDir), { recursive: true });
      mkdirSync(join(agentsDir, "skills"), { recursive: true });
      writeFileSync(join(repoDir, "install.ps1"), "# marker", "utf8");
      writeFileSync(join(repoDir, "agent", "models.yml.example"), "# marker", "utf8");
      writeFileSync(join(repoDir, "skills", "evil$(touch evil-executed.txt)", "SKILL.md"),
        `---\nname: evil\ndescription: "$(touch ${canary.replace(/\\/g, "/")})"\n---\n`, "utf8");
      copyFileSync(TOOL, join(repoDir, "tools", "skills-doctor.mjs"));

      spawnSync(shBin, [SYNC_SH, "--harness", harnessDir, "--repo", repoDir, "--agents-root", agentsDir], {
        cwd: tmp,
        encoding: "utf8",
      });

      assert.equal(existsSync(canary), false, "sync.sh must not execute commands in skill description");
      assert.equal(existsSync(join(tmp, "evil-executed.txt")), false, "sync.sh must not execute commands in skill name");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
