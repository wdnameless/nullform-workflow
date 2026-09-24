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
import { spawnSync } from "node:child_process";
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

test("validates structured JSON worker output with tests transition", () => {
  const payload = {
    status: "DONE",
    files_modified: ["tools/a.mjs", "tools/b.mjs"],
    tests: "node --test tools/tests/a.test.mjs -> было 0 -> стало 3",
    interfaces: ["foo", "bar"],
    requirements: ["R11"],
    concerns: "none",
  };
  const result = validateReturnContract(payload);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE");
  assert.equal(result.errors.length, 0);
});

test("rejects bare tests_passed: true without executed command or count evidence", () => {
  const payload = {
    status: "DONE",
    files_modified: ["tools/a.mjs"],
    tests_passed: true,
    interfaces: ["foo"],
    requirements: ["R11"],
    summary: "all changes done cleanly",
  };
  const result = validateReturnContract(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tests_passed: true")));
});

test("accepts tests_passed: true when summary contains numeric count transition", () => {
  const payload = {
    status: "DONE",
    files_modified: ["tools/a.mjs"],
    tests_passed: true,
    interfaces: ["foo"],
    requirements: ["R11"],
    summary: "ran test suite: было 10 -> стало 12 pass",
  };
  const result = validateReturnContract(payload);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE");
});

test("validates actual subagent wrapper payload with structured summary contract", () => {
  const wrapperPayload = {
    status: "success",
    tests_passed: false,
    files_modified: ["tools/a.mjs"],
    summary: "STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: none",
  };
  const result = validateReturnContract(wrapperPayload);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE");
  assert.equal(result.errors.length, 0);
});

test("rejects tests_passed: true when combined with not-run(parent-owned)", () => {
  const wrapperPayload = {
    status: "success",
    tests_passed: true,
    summary: "STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: none",
  };
  const result = validateReturnContract(wrapperPayload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("not-run(parent-owned)")));
});

test("rejects wrapper with outer status: 'failed' even if summary claims STATUS: DONE", () => {
  const wrapperPayload = {
    status: "failed",
    tests_passed: false,
    summary: "STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: none",
  };
  const result = validateReturnContract(wrapperPayload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("failed")));
});

test("rejects wrapper with outer status: 'partial' if summary claims pure STATUS: DONE without concerns", () => {
  const wrapperPayload = {
    status: "partial",
    tests_passed: false,
    summary: "STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: none",
  };
  const result = validateReturnContract(wrapperPayload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("partial")));
});

test("accepts wrapper with outer status: 'partial' when summary specifies DONE_WITH_CONCERNS", () => {
  const wrapperPayload = {
    status: "partial",
    tests_passed: false,
    summary: "STATUS: DONE_WITH_CONCERNS · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: minor debt",
  };
  const result = validateReturnContract(wrapperPayload);
  assert.equal(result.valid, true);
  assert.equal(result.status, "DONE_WITH_CONCERNS");
});

test("CLI return-contract.mjs reads valid contract from piped stdin", () => {
  const scriptPath = join(__dirname, "..", "return-contract.mjs");
  const input = JSON.stringify({
    status: "success",
    tests_passed: false,
    summary: "STATUS: DONE · FILES: tools/a.mjs · TESTS: not-run(parent-owned) · INTERFACES: none · REQUIREMENTS: R11 · CONCERNS: none",
  });

  const res = spawnSync(process.execPath, [scriptPath, "--json"], {
    input,
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.status, "DONE");
});

test("CLI return-contract.mjs fails with non-zero exit on empty stdin", () => {
  const scriptPath = join(__dirname, "..", "return-contract.mjs");
  const res = spawnSync(process.execPath, [scriptPath, "--json"], {
    input: "   \n   ",
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.some((e) => e.includes("Пустой ввод")));
});
