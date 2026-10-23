import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { verifySkillsLock } from "../carry.mjs";

const rootDir = resolve(".");
const versionExpected = readFileSync(join(rootDir, "VERSION"), "utf8").trim();

function parseSkillFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return null;
  const rawLines = m[1].split(/\r?\n/);
  const data = {};
  let currentKey = null;

  for (const line of rawLines) {
    if (!line.trim()) continue;
    const indentMatch = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (indentMatch && currentKey) {
      if (typeof data[currentKey] !== "object" || data[currentKey] === null) {
        data[currentKey] = {};
      }
      data[currentKey][indentMatch[1]] = indentMatch[2].replace(/^["']|["']$/g, "").trim();
      continue;
    }

    const topMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (topMatch) {
      const key = topMatch[1];
      const val = topMatch[2].trim();
      currentKey = key;
      if (val === "") {
        data[key] = {};
      } else {
        data[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  return data;
}

function getAllFilesRelative(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFilesRelative(full, base));
    } else if (entry.isFile()) {
      files.push(full.slice(base.length + 1).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// 1. Frontmatter Validation
// ---------------------------------------------------------------------------
test("skills/nullform/SKILL.md: frontmatter parses correctly with required fields", () => {
  const skillFile = join(rootDir, "skills", "nullform", "SKILL.md");
  assert.ok(existsSync(skillFile), "skills/nullform/SKILL.md must exist");
  const content = readFileSync(skillFile, "utf8");

  const fm = parseSkillFrontmatter(content);
  assert.ok(fm, "Frontmatter must parse successfully");
  assert.equal(fm.name, "nullform", "name must be nullform");
  assert.ok(fm.description && fm.description.length > 10, "description must be non-empty");
  assert.equal(fm.version, versionExpected, `version must match VERSION (${versionExpected})`);
  assert.equal(fm["disable-model-invocation"], "true", "disable-model-invocation must be true");
  assert.equal(fm["argument-hint"], "[tier] [task]", "argument-hint must declare [tier] [task]");

  assert.ok(fm.metadata, "metadata must be defined in frontmatter");
  assert.equal(fm.metadata.version, versionExpected, `metadata.version must match VERSION (${versionExpected})`);
});

// ---------------------------------------------------------------------------
// 2. Canonical Repo Path & Version Check Documentation
// ---------------------------------------------------------------------------
test("skills/nullform/SKILL.md: repo path points to wdnameless/nullform-workflow without legacy paths", () => {
  const skillFile = join(rootDir, "skills", "nullform", "SKILL.md");
  const content = readFileSync(skillFile, "utf8");

  assert.ok(
    content.includes("wdnameless/nullform-workflow"),
    "SKILL.md must reference canonical repo wdnameless/nullform-workflow",
  );
  assert.ok(
    !content.includes("nullform/workflow-repo"),
    "SKILL.md must not reference old repository path nullform/workflow-repo",
  );
  assert.ok(
    content.includes("npx skills add wdnameless/nullform-workflow --skill nullform"),
    "SKILL.md must document exact skills add command",
  );
  assert.ok(
    content.includes("npx skills update nullform"),
    "SKILL.md must document update command",
  );
  assert.ok(
    content.includes("VERSION"),
    "SKILL.md must document VERSION check comparison",
  );
});

// ---------------------------------------------------------------------------
// 3. Phase References
// ---------------------------------------------------------------------------
test("skills/nullform/phases: briefing, build, and review markdown guides exist with commands", () => {
  const phasesDir = join(rootDir, "skills", "nullform", "phases");
  assert.ok(existsSync(phasesDir), "phases directory must exist");

  const briefing = readFileSync(join(phasesDir, "briefing.md"), "utf8");
  assert.ok(briefing.includes("doctor-lite.mjs"), "briefing phase must mention doctor-lite.mjs");
  assert.ok(briefing.includes("workflow.mjs brief"), "briefing phase must mention workflow.mjs brief");
  assert.ok(briefing.includes("R##"), "briefing phase must mention R## requirements");

  const build = readFileSync(join(phasesDir, "build.md"), "utf8");
  assert.ok(build.includes("workflow.mjs start"), "build phase must mention workflow.mjs start");
  assert.ok(build.includes("dashboard.mjs"), "build phase must mention dashboard.mjs");
  assert.ok(build.includes("test-lens.mjs"), "build phase must mention test-lens.mjs");
  assert.ok(build.includes("workflow.mjs check"), "build phase must mention workflow.mjs check");

  const review = readFileSync(join(phasesDir, "review.md"), "utf8");
  assert.ok(review.includes("stage-b"), "review phase must mention stage-b simplification");
  assert.ok(review.includes("check-ci"), "review phase must mention check-ci quality gates");
  assert.ok(review.includes("oracle"), "review phase must mention blind oracle acceptance");
  assert.ok(review.includes("workflow.mjs close"), "review phase must mention workflow.mjs close");
});

// ---------------------------------------------------------------------------
// 4. Byte-for-Byte Mirror Parity (.claude and .agents)
// ---------------------------------------------------------------------------
test("skills mirrors: .claude/skills/nullform and .agents/skills/nullform match skills/nullform byte-for-byte", () => {
  const canonicalDir = join(rootDir, "skills", "nullform");
  const claudeDir = join(rootDir, ".claude", "skills", "nullform");
  const agentsDir = join(rootDir, ".agents", "skills", "nullform");

  assert.ok(existsSync(claudeDir), ".claude/skills/nullform directory must exist");
  assert.ok(existsSync(agentsDir), ".agents/skills/nullform directory must exist");

  const canonicalFiles = getAllFilesRelative(canonicalDir);
  const claudeFiles = getAllFilesRelative(claudeDir);
  const agentsFiles = getAllFilesRelative(agentsDir);

  assert.deepEqual(claudeFiles, canonicalFiles, ".claude files list must match canonical");
  assert.deepEqual(agentsFiles, canonicalFiles, ".agents files list must match canonical");

  for (const rel of canonicalFiles) {
    const origBuf = readFileSync(join(canonicalDir, rel));
    const claudeBuf = readFileSync(join(claudeDir, rel));
    const agentsBuf = readFileSync(join(agentsDir, rel));

    assert.equal(
      Buffer.compare(origBuf, claudeBuf),
      0,
      `.claude/skills/nullform/${rel} is not byte-for-byte identical to skills/nullform/${rel}`,
    );
    assert.equal(
      Buffer.compare(origBuf, agentsBuf),
      0,
      `.agents/skills/nullform/${rel} is not byte-for-byte identical to skills/nullform/${rel}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. skills-lock.json Conformance & Hash Integrity
// ---------------------------------------------------------------------------
test("skills-lock.json: valid lock file with matching computedHash", () => {
  const lockFile = join(rootDir, "skills-lock.json");
  assert.ok(existsSync(lockFile), "skills-lock.json must exist in root");

  const lockContent = readFileSync(lockFile, "utf8");
  const lock = JSON.parse(lockContent);

  assert.equal(lock.version, 1, "lock version must be 1");
  assert.ok(lock.skills && lock.skills.nullform, "lock must contain skills.nullform entry");

  const entry = lock.skills.nullform;
  assert.equal(entry.source, "wdnameless/nullform-workflow", "source must be wdnameless/nullform-workflow");
  assert.equal(entry.sourceType, "github", "sourceType must be github");
  assert.equal(entry.skillPath, "skills/nullform/SKILL.md", "skillPath must be skills/nullform/SKILL.md");

  const skillBytes = readFileSync(join(rootDir, "skills", "nullform", "SKILL.md"));
  const expectedSha = createHash("sha256").update(skillBytes).digest("hex");

  assert.equal(entry.computedHash, expectedSha, "computedHash must match SHA-256 of skills/nullform/SKILL.md");

  const verifyRes = verifySkillsLock(lockFile, rootDir, { throws: false });
  assert.equal(verifyRes.ok, true, `verifySkillsLock must succeed: ${verifyRes.error || ""}`);
});

// ---------------------------------------------------------------------------
// 6. skills-doctor Simulation on Simulated Agents Home
// ---------------------------------------------------------------------------
test("skills-doctor: reports 0 problems on simulated agents-home installation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "p-publish-sim-"));
  try {
    const simRepo = join(tmp, "repo", "skills");
    const simAgentsHome = join(tmp, "agents-home");
    const simInstalled = join(simAgentsHome, "skills");

    cpSync(join(rootDir, "skills", "nullform"), join(simRepo, "nullform"), { recursive: true });
    cpSync(join(rootDir, "skills", "nullform"), join(simInstalled, "nullform"), { recursive: true });

    const doctorScript = join(rootDir, "tools", "skills-doctor.mjs");
    const proc = spawnSync(
      process.execPath,
      [
        doctorScript,
        "--installed",
        simInstalled,
        "--repo",
        simRepo,
        "--agents-home",
        simAgentsHome,
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(proc.status, 0, `skills-doctor exited with status ${proc.status}: ${proc.stderr}`);
    const report = JSON.parse(proc.stdout);

    assert.equal(report.ok, true, "skills-doctor report.ok must be true");
    assert.equal(report.parityStatus, "VERIFIED", "parityStatus must be VERIFIED");
    assert.equal(report.problems.length, 0, `Expected 0 problems, got: ${JSON.stringify(report.problems)}`);
    assert.equal(report.installedCount, 1, "installedCount must be 1");
    assert.equal(report.repoCount, 1, "repoCount must be 1");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. README.md: Badge & Install Section
// ---------------------------------------------------------------------------
test("README.md: contains skills.sh badge and npx skills add instruction", () => {
  const readmeContent = readFileSync(join(rootDir, "README.md"), "utf8");

  assert.ok(
    readmeContent.includes("https://skills.sh/b/wdnameless/nullform-workflow/nullform") ||
      readmeContent.includes("https://skills.sh/wdnameless/nullform-workflow/nullform"),
    "README.md must include skills.sh badge",
  );
  assert.ok(
    readmeContent.includes("npx skills add wdnameless/nullform-workflow --skill nullform"),
    "README.md must include npx skills add instruction",
  );
});
