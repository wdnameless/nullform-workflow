import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATEGORY_TARIFFS,
  ROLE_TARIFFS,
  computeTariffCost,
  validateAdmissionPolicy,
  loadSpendLedger,
  getSpendSummary,
  DEFAULT_PROGRAM_CEILING_USD } from "../bench-budget.mjs";

test("CATEGORY_TARIFFS defines strict, builder, and scout tariffs", () => {
  assert.ok(CATEGORY_TARIFFS.strict);
  assert.ok(CATEGORY_TARIFFS.builder);
  assert.ok(CATEGORY_TARIFFS.scout);
  assert.equal(CATEGORY_TARIFFS.strict.input, 3.0);
  assert.equal(CATEGORY_TARIFFS.strict.output, 15.0);
  assert.equal(CATEGORY_TARIFFS.builder.input, 0.75);
  assert.equal(CATEGORY_TARIFFS.builder.output, 3.75);
  assert.equal(CATEGORY_TARIFFS.scout.input, 0.15);
  assert.equal(CATEGORY_TARIFFS.scout.output, 0.60);
});

test("ROLE_TARIFFS maps all 9 roles to their respective category tariffs", () => {
  const roles = ["oracle", "reviewer", "orchestrator", "fixer", "designer", "explorer", "scout", "sonic", "librarian"];
  for (const role of roles) {
    assert.ok(ROLE_TARIFFS[role], `Missing role tariff for ${role}`);
  }
  assert.deepEqual(ROLE_TARIFFS.oracle, CATEGORY_TARIFFS.strict);
  assert.deepEqual(ROLE_TARIFFS.fixer, CATEGORY_TARIFFS.builder);
  assert.deepEqual(ROLE_TARIFFS.scout, CATEGORY_TARIFFS.scout);
});

test("computeTariffCost calculates costs for categories and roles", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  const strictCost = computeTariffCost(usage, "strict");
  assert.equal(strictCost.tariff_usd, 18.0);

  const oracleCost = computeTariffCost(usage, "oracle");
  assert.equal(oracleCost.tariff_usd, 18.0);

  const builderCost = computeTariffCost(usage, "builder");
  assert.equal(builderCost.tariff_usd, 4.5);

  const scoutCost = computeTariffCost(usage, "scout");
  assert.equal(scoutCost.tariff_usd, 0.75);
});

test("validateAdmissionPolicy validates valid policies with ceiling up to $50", () => {
  const policy = validateAdmissionPolicy({ ceiling_usd: 50, role: "fixer" });
  assert.equal(policy.ceiling_usd, 50);
  assert.equal(policy.category, "builder");
  assert.equal(policy.role, "fixer");

  assert.throws(() => validateAdmissionPolicy({ ceiling_usd: 51 }), /ceiling/i);
  assert.throws(() => validateAdmissionPolicy({ ceiling_usd: -5 }), /ceiling/i);
  assert.throws(() => validateAdmissionPolicy({ role: "nonexistent" }), /role/i);
});

test("loadSpendLedger supports $50 program ceiling", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-budget-matrix-"));
  try {
    const defaultLedger = loadSpendLedger(dir);
    assert.equal(defaultLedger.ceiling_usd, DEFAULT_PROGRAM_CEILING_USD);
    assert.equal(defaultLedger.ceiling_usd, 50);

    const summary = getSpendSummary(dir);
    assert.equal(summary.cumulative_tariff_usd, 0);
    assert.equal(summary.ceiling_usd, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
