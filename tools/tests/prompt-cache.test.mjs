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
import { collectFingerprint } from "../prompt-lint.mjs";
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
