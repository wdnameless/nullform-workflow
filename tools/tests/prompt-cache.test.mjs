/**
 * prompt-cache.test.mjs — tests for prompt-lint fingerprinting and cache-policy gates.
 *
 * Verifies:
 *   - Fingerprint contains four layers: baseInstructions, agentRoles, rules, skills
 *   - Fingerprint determinism: identical on repeated runs
 *   - Fingerprint output structure and normalized forward-slash paths
 *   - Cache policy check: safe advisory gates, exits 0, does not mutate model config
 *   - Cache policy notice is printed: 'quality-sensitive settings are advisory; no model/context changes performed'
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFingerprint, collectSizes, parseSkillFrontmatterText } from "../prompt-lint.mjs";
import { runCachePolicyCheck, loadPolicy } from "../cache-policy.mjs";

test("collectFingerprint returns four deterministic layers with normalized paths", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-test-"));
  try {
    mkdirSync(join(tmp, "agent", "agents"), { recursive: true });
    mkdirSync(join(tmp, "rules"), { recursive: true });
    mkdirSync(join(tmp, "skills", "skill-a"), { recursive: true });

    writeFileSync(join(tmp, "agent", "AGENTS.md"), "# Base Instructions\nStable content.\n");
    writeFileSync(join(tmp, "agent", "agents", "fixer.md"), "# Fixer role\n");
    writeFileSync(join(tmp, "agent", "agents", "scout.md"), "# Scout role\n");
    writeFileSync(join(tmp, "rules", "enterprise.md"), "# Enterprise rules\n");
    writeFileSync(join(tmp, "skills", "skill-a", "SKILL.md"), "# Skill A\n");

    const fp1 = collectFingerprint(tmp, tmp);
    const fp2 = collectFingerprint(tmp, tmp);

    assert.equal(fp1.compositeSha, fp2.compositeSha, "Composite sha must be deterministic");
    assert.deepEqual(fp1.layers, fp2.layers, "Layers must be identical across runs");

    // Check layer presence
    assert.ok(fp1.layers.baseInstructions, "Must have baseInstructions");
    assert.equal(fp1.layers.baseInstructions.count, 1);
    assert.ok(fp1.layers.agentRoles, "Must have agentRoles");
    assert.equal(fp1.layers.agentRoles.count, 2);
    assert.ok(fp1.layers.rules, "Must have rules");
    assert.equal(fp1.layers.rules.count, 1);
    assert.ok(fp1.layers.skills, "Must have skills");
    assert.equal(fp1.layers.skills.count, 1);

    // Check files array
    assert.equal(fp1.files.length, 5);
    for (const f of fp1.files) {
      assert.ok(!f.path.includes("\\"), `Path must be normalized with forward slashes: ${f.path}`);
      assert.ok(f.sha && f.sha.length > 0, "File entry must have sha");
      assert.ok(["baseInstructions", "agentRoles", "rules", "skills"].includes(f.layer));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cache-policy check passes on clean repo and does not modify config", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cp-test-"));
  try {
    mkdirSync(join(tmp, "agent", "agents"), { recursive: true });
    mkdirSync(join(tmp, ".workflow"), { recursive: true });

    writeFileSync(join(tmp, "agent", "AGENTS.md"), "# Agents\n");
    writeFileSync(join(tmp, "agent", "agents", "task.md"), "# Task\n");
    const examplePolicy = {
      version: 1,
      maxModelsPerTask: 3,
      compactionThreshold: 0.8,
    };
    writeFileSync(join(tmp, ".workflow", "cache-policy.json"), JSON.stringify(examplePolicy, null, 2));

    const result = runCachePolicyCheck({ root: tmp });

    assert.equal(result.passed, true, "Safety check must pass on clean repo");
    assert.ok(result.notice.includes("quality-sensitive settings are advisory; no model/context changes performed"));
    assert.ok(result.compositeSha, "Must have compositeSha");

    // Verify no models.yml or configuration file was created or modified
    assert.equal(existsSync(join(tmp, "models.yml")), false, "Must never create or write to models.yml");
    assert.equal(existsSync(join(tmp, "agent", "models.yml")), false, "Must never create or write to agent/models.yml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cache-policy loads default policy when none exists", () => {
  const { policy, source } = loadPolicy(join(tmpdir(), "non-existent-" + Date.now()));
  assert.equal(source, "defaults");
  assert.equal(policy.version, 1);
  assert.equal(policy.maxModelsPerTask, 2);
  assert.equal(policy.compactionThreshold, 0.78);
});

test("prompt-lint sizes calculates budgets correctly and succeeds on valid structure", () => {
  const tmp = join(tmpdir(), "prompt-lint-sizes-ok-" + Date.now());
  try {
    mkdirSync(join(tmp, "agent", "agents"), { recursive: true });
    mkdirSync(join(tmp, "rules"), { recursive: true });
    mkdirSync(join(tmp, "skills", "demo-skill"), { recursive: true });

    writeFileSync(join(tmp, "agent", "AGENTS.md"), "# Base Instructions\nShort content.\n");
    writeFileSync(join(tmp, "agent", "agents", "test-agent.md"), "# Role Def\nAgent description.\n");
    writeFileSync(join(tmp, "rules", "test-rule.md"), "# Rule\nRule content.\n");
    writeFileSync(join(tmp, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: A test skill\n---\n# Full body that is very long\n" + "x".repeat(5000));

    const res = collectSizes(tmp, null);
    assert.equal(res.ok, true);
    assert.equal(res.groups.always.ok, true);
    assert.equal(res.groups["role-defs"].ok, true);
    assert.equal(res.groups.rules.ok, true);
    assert.equal(res.groups.skills.ok, true);
    assert.equal(res.groups.always.fileCount, 1);
    assert.equal(res.groups["role-defs"].fileCount, 1);
    assert.equal(res.groups.rules.fileCount, 1);
    assert.equal(res.groups.skills.fileCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prompt-lint sizes detects violations when budgets exceeded", () => {
  const tmp = join(tmpdir(), "prompt-lint-sizes-violation-" + Date.now());
  try {
    mkdirSync(join(tmp, "agent", "agents"), { recursive: true });
    mkdirSync(join(tmp, "rules"), { recursive: true });
    mkdirSync(join(tmp, "skills", "demo"), { recursive: true });

    // 1. always violation (> 16384 bytes)
    writeFileSync(join(tmp, "agent", "AGENTS.md"), "a".repeat(20000));
    const res1 = collectSizes(tmp, null);
    assert.equal(res1.ok, false);
    assert.equal(res1.groups.always.ok, false);

    // 2. role-defs violation (> 65536 bytes)
    writeFileSync(join(tmp, "agent", "AGENTS.md"), "short");
    writeFileSync(join(tmp, "agent", "agents", "heavy.md"), "b".repeat(70000));
    const res2 = collectSizes(tmp, null);
    assert.equal(res2.ok, false);
    assert.equal(res2.groups["role-defs"].ok, false);

    // 3. rules violation (> 250 lines)
    writeFileSync(join(tmp, "agent", "agents", "heavy.md"), "short");
    writeFileSync(join(tmp, "rules", "long.md"), "line\n".repeat(300));
    const res3 = collectSizes(tmp, null);
    assert.equal(res3.ok, false);
    assert.equal(res3.groups.rules.ok, false);

    // 4. skills violation (> 400 lines in frontmatter)
    writeFileSync(join(tmp, "rules", "long.md"), "short");
    // Write a skill with > 32768 bytes in frontmatter
    writeFileSync(join(tmp, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: " + "a".repeat(35000) + "\n---\n");
    const res4 = collectSizes(tmp, null);
    assert.equal(res4.ok, false);
    assert.equal(res4.groups.skills.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prompt-lint sizes respects .prompt-lint/budget.json overrides (partial merge)", () => {
  const tmp = join(tmpdir(), "prompt-lint-sizes-budget-" + Date.now());
  try {
    mkdirSync(join(tmp, ".prompt-lint"), { recursive: true });
    mkdirSync(join(tmp, "agent"), { recursive: true });

    writeFileSync(join(tmp, ".prompt-lint", "budget.json"), JSON.stringify({
      always: { maxBytes: 50 },
    }));
    writeFileSync(join(tmp, "agent", "AGENTS.md"), "x".repeat(100));

    const res = collectSizes(tmp, null);
    assert.equal(res.groups.always.maxBytes, 50);
    // maxLines kept default
    assert.equal(res.groups.always.maxLines, 200);
    assert.equal(res.groups.always.ok, false);
    // other groups kept defaults
    assert.equal(res.groups["role-defs"].maxBytes, 65536);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("skills are measured only by frontmatter name + description, not body", () => {
  const textWithHugeBody = `---
name: test-skill
description: A short description for test skill
author: somebody
---
# Massive Body
` + "y".repeat(100000);

  const fm = parseSkillFrontmatterText(textWithHugeBody);
  assert.ok(fm.includes("name: test-skill"));
  assert.ok(fm.includes("description: A short description for test skill"));
  assert.ok(!fm.includes("author: somebody"));
  assert.ok(!fm.includes("Massive Body"));
  assert.ok(Buffer.byteLength(fm, "utf8") < 200);
});

test("prompt-lint sizes JSON output format matches contract", () => {
  const tmp = join(tmpdir(), "prompt-lint-sizes-json-" + Date.now());
  try {
    mkdirSync(join(tmp, "agent"), { recursive: true });
    writeFileSync(join(tmp, "agent", "AGENTS.md"), "# Test\n");

    const res = collectSizes(tmp, null);
    assert.equal(typeof res.ok, "boolean");
    assert.ok(res.groups);
    for (const group of ["always", "role-defs", "rules", "skills"]) {
      const g = res.groups[group];
      assert.equal(typeof g.bytes, "number");
      assert.equal(typeof g.maxBytes, "number");
      assert.equal(typeof g.lines, "number");
      assert.equal(typeof g.maxLines, "number");
      assert.equal(typeof g.ok, "boolean");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
