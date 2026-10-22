import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { checkQualityGates, cmdCheckCi } from "../workflow.mjs";

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const WORKTREE_ROOT = resolve(import.meta.dirname, "../..");
const SKILLS_DOCTOR_TOOL = resolve(WORKTREE_ROOT, "tools/skills-doctor.mjs");
const NULLFORM_SKILL_PATH = resolve(WORKTREE_ROOT, "skills/nullform/SKILL.md");

/* ----------------------------------------------------------------- R08 tests */

test("R08: skills/nullform/SKILL.md exists and has valid frontmatter (name, description, version)", () => {
  assert.ok(existsSync(NULLFORM_SKILL_PATH), "skills/nullform/SKILL.md must exist");
  const content = readFileSync(NULLFORM_SKILL_PATH, "utf8");

  const fm = parseFrontmatter(content);
  assert.ok(fm, "Frontmatter must be parsable");
  assert.equal(fm.name, "nullform", "Skill name must be nullform");
  assert.ok(fm.description && fm.description.length > 20, "Description must be present and descriptive");
  assert.ok(fm.version, "Version must be present in frontmatter");

  // Mojibake check
  assert.equal(/[\u00c2\u00c3\u00e2][\u0080-\u00bf]/.test(content), false, "SKILL.md must not contain mojibake encoding artifacts");

  // Content requirements: Briefing -> Build -> Review, commands, npx skills add
  assert.match(content, /Briefing/i, "Must describe Briefing phase");
  assert.match(content, /Build/i, "Must describe Build phase");
  assert.match(content, /Review/i, "Must describe Review phase");
  assert.match(content, /workflow\.mjs/i, "Must mention workflow.mjs commands");
  assert.match(content, /doctor/i, "Must mention doctor diagnostic commands");
  assert.match(content, /dashboard/i, "Must mention dashboard command");
  assert.match(content, /npx skills add/i, "Must document npx skills add installation");
});

test("R08: skills-doctor validates nullform skill package with 0 problems and verified parity", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-doctor-"));
  try {
    const installedRoot = join(tmp, "agents/skills");
    const repoRoot = join(tmp, "repo/skills");
    mkdirSync(join(installedRoot, "nullform"), { recursive: true });
    mkdirSync(join(repoRoot, "nullform"), { recursive: true });

    copyFileSync(NULLFORM_SKILL_PATH, join(installedRoot, "nullform", "SKILL.md"));
    copyFileSync(NULLFORM_SKILL_PATH, join(repoRoot, "nullform", "SKILL.md"));

    const res = spawnSync(process.execPath, [
      SKILLS_DOCTOR_TOOL,
      "--installed", installedRoot,
      "--repo", repoRoot,
      "--json",
    ], { encoding: "utf8" });

    assert.equal(res.status, 0, `skills-doctor failed: ${res.stdout}\n${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.parityStatus, "VERIFIED");
    assert.deepEqual(report.problems, []);
    assert.equal(report.installedCount, 1);
    assert.equal(report.repoCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------- R09 tests */

function createMockOpenSpecChange(root, changeId) {
  const changeDir = join(root, "openspec", "changes", changeId);
  mkdirSync(join(changeDir, "specs"), { recursive: true });
  writeFileSync(join(changeDir, "manifest.md"), "# Manifest\n| R01 | requirement | acceptance |\n", "utf8");
  writeFileSync(join(changeDir, "proposal.md"), "# Proposal\nClean proposal\n", "utf8");
  writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- [x] Task 1\n", "utf8");
  writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\nSpecification\n", "utf8");
  writeFileSync(join(changeDir, "interfaces.md"), "# Interfaces\nexport function test(): void\n", "utf8");
  writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\nEvidence: all tests pass\n", "utf8");
  return changeDir;
}

test("R09: checkQualityGates passes all gates on clean fixture", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-clean-"));
  try {
    mkdirSync(join(tmp, "tools"), { recursive: true });
    writeFileSync(join(tmp, "tools", "clean.mjs"), "export function hello() {\n  return 'world';\n}\n", "utf8");

    const result = checkQualityGates(tmp);
    assert.equal(result.ok, true, "Clean fixture must pass all quality gates");
    assert.equal(result.violators.length, 0);

    const gateNames = result.gates.map((g) => g.name);
    assert.ok(gateNames.includes("code-size"), "code-size gate must be present");
    assert.ok(gateNames.includes("debt-ledger"), "debt-ledger gate must be present");
    assert.ok(gateNames.includes("logs-hygiene"), "logs-hygiene gate must be present");
    assert.ok(gateNames.includes("orphan-files"), "orphan-files gate must be present");

    for (const g of result.gates) {
      assert.equal(g.status, "pass", `Gate ${g.name} should pass, but was ${g.status}`);
      assert.ok(g.path, `Gate ${g.name} must report a path`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: code-size gate fails on bloated file (раздутый файл)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-size-"));
  try {
    mkdirSync(join(tmp, "tools"), { recursive: true });
    // Generate a file exceeding default maxLines (700)
    const longCode = Array.from({ length: 750 }, (_, i) => `// line ${i}`).join("\n") + "\n";
    writeFileSync(join(tmp, "tools", "bloated.mjs"), longCode, "utf8");

    const result = checkQualityGates(tmp);
    assert.equal(result.ok, false, "Bloated file must cause quality gates to fail");

    const sizeGate = result.gates.find((g) => g.name === "code-size");
    assert.ok(sizeGate);
    assert.equal(sizeGate.status, "fail");
    assert.match(sizeGate.path, /bloated\.mjs/);
    assert.ok(result.violators.some((v) => v.includes("bloated.mjs")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: debt-ledger gate fails on untriggered defer marker (defer-маркер)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-debt-"));
  try {
    mkdirSync(join(tmp, "tools"), { recursive: true });
    writeFileSync(
      join(tmp, "tools", "debt.mjs"),
      "// defer: untracked hack without upgrade trigger\nexport const x = 42;\n",
      "utf8"
    );

    const result = checkQualityGates(tmp);
    assert.equal(result.ok, false, "Untriggered defer marker must cause quality gates to fail");

    const debtGate = result.gates.find((g) => g.name === "debt-ledger");
    assert.ok(debtGate);
    assert.equal(debtGate.status, "fail");
    assert.match(debtGate.path, /debt\.mjs/);
    assert.ok(result.violators.some((v) => v.includes("debt.mjs")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: orphan-files gate fails on stray/orphan file (orphan)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-orphan-"));
  try {
    mkdirSync(join(tmp, "tools"), { recursive: true });
    writeFileSync(join(tmp, "tools", "normal.mjs"), "export const ok = 1;\n", "utf8");
    writeFileSync(join(tmp, "orphan.js"), "// stray orphan file\n", "utf8");
    writeFileSync(join(tmp, "scratch.tmp"), "stray temp file\n", "utf8");

    const result = checkQualityGates(tmp);
    assert.equal(result.ok, false, "Orphan/temp file must cause quality gates to fail");

    const orphanGate = result.gates.find((g) => g.name === "orphan-files");
    assert.ok(orphanGate);
    assert.equal(orphanGate.status, "fail");
    assert.ok(result.violators.some((v) => v.includes("orphan.js") || v.includes("scratch.tmp")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: logs-hygiene gate fails when log directory volume exceeds threshold", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-logs-"));
  try {
    const logsDir = join(tmp, "logs");
    mkdirSync(logsDir, { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `session-${i}.log`), `log entry ${i}\n`, "utf8");
    }

    const result = checkQualityGates(tmp, { "max-log-files": 10 });
    assert.equal(result.ok, false, "Excessive logs must fail logs-hygiene threshold");

    const logGate = result.gates.find((g) => g.name === "logs-hygiene");
    assert.ok(logGate);
    assert.equal(logGate.status, "fail");
    assert.ok(result.violators.some((v) => v.includes("logs")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: dirty fixture (мусор: bloated file + defer-marker + orphan) turns multiple gates red and reports all violators", () => {
  const tmp = mkdtempSync(join(tmpdir(), "u-quality-dirty-fixture-"));
  try {
    mkdirSync(join(tmp, "tools"), { recursive: true });
    const logsDir = join(tmp, "logs");
    mkdirSync(logsDir, { recursive: true });

    // 1. Bloated file (>700 lines)
    const longCode = Array.from({ length: 800 }, (_, i) => `const val_${i} = ${i};`).join("\n") + "\n";
    writeFileSync(join(tmp, "tools", "bloated.mjs"), longCode, "utf8");

    // 2. Untriggered defer marker
    writeFileSync(
      join(tmp, "tools", "dirty-debt.mjs"),
      "// defer: quick hack without trigger\nexport const a = 1;\n",
      "utf8"
    );

    // 3. Orphan file
    writeFileSync(join(tmp, "orphan-trash.js"), "// forgotten trash\n", "utf8");
    writeFileSync(join(tmp, "artifact.tmp"), "scratch\n", "utf8");

    // 4. Log clutter exceeding custom threshold
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(logsDir, `dump-${i}.log`), "log data\n", "utf8");
    }

    const result = checkQualityGates(tmp, { "max-log-files": 5 });
    assert.equal(result.ok, false, "Dirty fixture must fail quality check");

    const failedGates = result.gates.filter((g) => g.status === "fail").map((g) => g.name);
    assert.ok(failedGates.includes("code-size"), "code-size must fail");
    assert.ok(failedGates.includes("debt-ledger"), "debt-ledger must fail");
    assert.ok(failedGates.includes("orphan-files"), "orphan-files must fail");
    assert.ok(failedGates.includes("logs-hygiene"), "logs-hygiene must fail");

    // Verify violators list contains names of all offenders
    const violatorsText = result.violators.join(" ");
    assert.match(violatorsText, /bloated\.mjs/);
    assert.match(violatorsText, /dirty-debt\.mjs/);
    assert.match(violatorsText, /orphan-trash\.js|artifact\.tmp/);
    assert.match(violatorsText, /logs/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R09: cmdCheckCi integrates quality gates (passes clean, fails dirty with exit 1)", () => {
  const cleanTmp = mkdtempSync(join(tmpdir(), "u-quality-ci-clean-"));
  const dirtyTmp = mkdtempSync(join(tmpdir(), "u-quality-ci-dirty-"));
  try {
    // Clean directory
    mkdirSync(join(cleanTmp, "tools"), { recursive: true });
    writeFileSync(join(cleanTmp, "tools", "ok.mjs"), "export const ok = true;\n", "utf8");
    writeFileSync(
      join(cleanTmp, "recon.md"),
      "# Recon\n## Files touched\n- tools/ok.mjs\n## Acceptance check\n- verified ok\n",
      "utf8"
    );

    assert.equal(cmdCheckCi(cleanTmp, { quality: true }), 0, "Clean quality check must exit 0");
    assert.equal(cmdCheckCi(cleanTmp, { tier: "T0" }), 0, "T0 check-ci on clean code must exit 0");
    assert.equal(
      cmdCheckCi(cleanTmp, { tier: "T1", recon: "recon.md" }),
      0,
      "T1 check-ci on clean code must exit 0"
    );

    // Dirty directory with garbage
    mkdirSync(join(dirtyTmp, "tools"), { recursive: true });
    writeFileSync(
      join(dirtyTmp, "tools", "bad-debt.mjs"),
      "// defer: unmanaged rot\nexport const bad = 1;\n",
      "utf8"
    );
    writeFileSync(join(dirtyTmp, "orphan.tmp"), "orphan garbage\n", "utf8");
    writeFileSync(
      join(dirtyTmp, "recon.md"),
      "# Recon\n## Files touched\n- tools/bad-debt.mjs\n## Acceptance check\n- verified ok\n",
      "utf8"
    );

    assert.equal(cmdCheckCi(dirtyTmp, { quality: true }), 1, "Dirty quality check must exit 1");
    assert.equal(cmdCheckCi(dirtyTmp, { tier: "T0" }), 1, "T0 check-ci on dirty code must exit 1");
    assert.equal(
      cmdCheckCi(dirtyTmp, { tier: "T1", recon: "recon.md" }),
      1,
      "T1 check-ci on dirty code must exit 1"
    );
  } finally {
    rmSync(cleanTmp, { recursive: true, force: true });
    rmSync(dirtyTmp, { recursive: true, force: true });
  }
});
