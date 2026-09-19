/**
 * return-contract.test.mjs — tests for subagent return contract validation.
 *
 * Verifies:
 *   - Valid return contracts pass (both compact single-turn inline format and multi-line section format)
 *   - Status validation (DONE, DONE_WITH_CONCERNS, HANDOFF, BLOCKED, NEEDS_CONTEXT)
 *   - Rejection of invalid status
 *   - FILES validation: paths / internal URIs only, prose descriptions rejected
 *   - TESTS validation: numeric before->after or exact 'not-run(parent-owned)'
 *   - Line count limit: reject contracts exceeding 25 lines
 *   - Missing required sections rejected
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateReturnContract } from "../return-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("valid compact return contract passes", () => {
  const contract = `STATUS: DONE · FILES: tools/prompt-lint.mjs, tools/cache-policy.mjs · TESTS: not-run(parent-owned) · INTERFACES: tools/cache-policy.mjs · REQUIREMENTS: R01, R05-R09 · CONCERNS: none`;
  const result = validateReturnContract(contract);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE");
  assert.equal(result.errors.length, 0);
});

test("validates return-contract fixture file", () => {
  const fixturePath = join(__dirname, "fixtures", "return-contract", "valid.md");
  const content = readFileSync(fixturePath, "utf8");
  const result = validateReturnContract(content);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE");
  assert.equal(result.errors.length, 0);
});

test("valid multiline return contract with numeric test transition passes", () => {
  const contract = [
    "STATUS: DONE_WITH_CONCERNS",
    "FILES:",
    "tools/return-contract.mjs",
    "tools/tests/return-contract.test.mjs",
    "TESTS: node --test tools/tests/return-contract.test.mjs -> было 0 -> стало 6",
    "INTERFACES: validateReturnContract",
    "REQUIREMENTS: R07, R08",
    "CONCERNS: none",
  ].join("\n");

  const result = validateReturnContract(contract);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE_WITH_CONCERNS");
  assert.equal(result.errors.length, 0);
});

test("rejects invalid status", () => {
  const contract = `STATUS: SUCCESS · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R01 · CONCERNS: none`;
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("STATUS")));
});

test("rejects prose in FILES section", () => {
  const contract = `STATUS: DONE · FILES: I modified the entire authentication subsystem because it was broken · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R01 · CONCERNS: none`;
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("FILES")));
});

test("rejects missing numeric transition or exact not-run(parent-owned) in TESTS", () => {
  const contract = `STATUS: DONE · FILES: tools/a.mjs · TESTS: all tests passed successfully · INTERFACES: none · REQUIREMENTS: R01 · CONCERNS: none`;
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("TESTS")));
});

test("rejects contracts exceeding 25 lines", () => {
  const lines = [
    "STATUS: DONE",
    "FILES: tools/a.mjs",
    "TESTS: not-run(parent-owned)",
    "INTERFACES: none",
    "REQUIREMENTS: R01",
    "CONCERNS: none",
  ];
  for (let i = 0; i < 22; i++) {
    lines.push(`Extra comment line ${i}`);
  }
  const contract = lines.join("\n");
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Превышен лимит строк")));
});

test("rejects contract missing a required section", () => {
  const contract = `STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · CONCERNS: none`;
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("REQUIREMENTS")));
});
