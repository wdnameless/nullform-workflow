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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateReturnContract,
  createWorkerBrief,
  validateWorkerBrief,
  createRedispatchBrief,
  validateRedispatch,
} from "../return-contract.mjs";

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

test("CLI return-contract.mjs --help outputs usage and exits 0", () => {
  const scriptPath = join(__dirname, "..", "return-contract.mjs");
  const res = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Использование: node tools\/return-contract\.mjs/);
});

test("CLI return-contract.mjs with isTTY and no args outputs usage and exits 2 without hanging", () => {
  const scriptPath = join(__dirname, "..", "return-contract.mjs");
  const inline = `process.stdin.isTTY = true; const { main } = await import(${JSON.stringify(pathToFileURL(scriptPath).href)}); process.exitCode = main([]);`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", inline], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /return-contract\.mjs — валидация контракта возврата/);
});

/* ----------------------------------------------------------------------- R09 Worker Brief & Redispatch */

test("R09: worker brief with complete inputs carries task, zone, requirements, criteria, explicit INPUT GAP and no third advisor", () => {
  const briefRes = createWorkerBrief({
    task: "Implement safe calculation module",
    files: ["src/calc.mjs", "tests/calc.test.mjs"],
    requirements: ["R01", "R02"],
    criteria: ["Zero regressions on frozen tests", "Returns clean contract"],
  });
  assert.equal(briefRes.ok, true);
  assert.equal(briefRes.status, "OK");
  assert.equal(briefRes.missingInputs.length, 0);
  assert.match(briefRes.brief, /# Target\nZone: src\/calc\.mjs, tests\/calc\.test\.mjs/);
  assert.match(briefRes.brief, /Implement safe calculation module/);
  assert.match(briefRes.brief, /INPUT GAP/);
  assert.match(briefRes.brief, /No third advisor/i);

  const validation = validateWorkerBrief(briefRes.brief);
  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
});

test("R09: worker brief with missing input states explicit INPUT GAP instead of inventing it", () => {
  // Missing files and criteria
  const incomplete = createWorkerBrief({
    task: "Implement safe calculation module",
    requirements: ["R01"],
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.status, "INPUT GAP");
  assert.match(incomplete.error, /INPUT GAP: missing required inputs: files, criteria/);
  assert.deepEqual(incomplete.missingInputs, ["files", "criteria"]);
  assert.equal(incomplete.brief, null);
});

test("R09: validateWorkerBrief reports INPUT GAP when required inputs are missing", () => {
  const sparseBrief = [
    "# Target",
    "Zone: src/calc.mjs",
    "# Rules",
    "- If any input is missing state INPUT GAP",
  ].join("\n");
  const validation = validateWorkerBrief(sparseBrief);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => /INPUT GAP/i.test(e) && /task|requirements|criteria/i.test(e)));
});

test("R09: validateWorkerBrief rejects brief missing explicit INPUT GAP rule", () => {
  const briefNoGap = [
    "# Target",
    "Zone: src/calc.mjs",
    "# Task",
    "Do work",
    "# Requirements",
    "R01",
    "# Acceptance Criteria",
    "Pass all checks",
  ].join("\n");
  const validation = validateWorkerBrief(briefNoGap);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => /INPUT GAP/i.test(e)));
});

test("R09: validateWorkerBrief rejects third advisor references", () => {
  const briefWithAdvisor = [
    "# Target",
    "Zone: src/calc.mjs",
    "# Task",
    "Do work",
    "# Requirements",
    "R01",
    "# Acceptance Criteria",
    "Pass all checks",
    "# Rules",
    "- State INPUT GAP if missing context.",
    "- Consult third advisor model for second opinion.",
  ].join("\n");
  const validation = validateWorkerBrief(briefWithAdvisor);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => /third advisor/i.test(e)));
});

test("R09: createRedispatchBrief carries failed criterion, fresh: true, explicit INPUT GAP, and no third advisor", () => {
  const redispatch = createRedispatchBrief({
    task: "Fix multiply edge case handling",
    files: ["src/calc.mjs"],
    requirements: ["R01"],
    failedCriterion: "multiply(0.5, 3) must equal 1.5, received 1.0",
  });
  assert.equal(redispatch.ok, true);
  assert.equal(redispatch.fresh, true);
  assert.equal(redispatch.failedCriterion, "multiply(0.5, 3) must equal 1.5, received 1.0");
  assert.match(redispatch.brief, /FAILED CRITERION: multiply\(0\.5, 3\) must equal 1\.5, received 1\.0/);
  assert.match(redispatch.brief, /INPUT GAP/);
  assert.match(redispatch.brief, /no third advisor/i);

  const validation = validateRedispatch(redispatch.brief);
  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
});

test("R09: createRedispatchBrief with missing failed criterion states explicit INPUT GAP instead of inventing it", () => {
  const redispatch = createRedispatchBrief({
    task: "Fix multiply edge case handling",
    files: ["src/calc.mjs"],
    requirements: ["R01"],
  });
  assert.equal(redispatch.ok, false);
  assert.equal(redispatch.status, "INPUT GAP");
  assert.match(redispatch.error, /INPUT GAP: missing failed criterion for FIX fresh-redispatch/);
  assert.deepEqual(redispatch.missingInputs, ["failedCriterion"]);
  assert.equal(redispatch.brief, null);
});

test("R09: createRedispatchBrief rejects third advisor parameter", () => {
  const redispatch = createRedispatchBrief({
    task: "Fix multiply edge case handling",
    files: ["src/calc.mjs"],
    requirements: ["R01"],
    failedCriterion: "test failed",
    advisor: "third-advisor-agent",
  });
  assert.equal(redispatch.ok, false);
  assert.match(redispatch.error, /third advisor/i);
});

test("R09: validateRedispatch rejects redispatch missing failed criterion", () => {
  const badRedispatch = [
    "# Target",
    "Zone: src/calc.mjs",
    "# Task",
    "Fix defect",
    "# Rules",
    "- INPUT GAP",
    "- No third advisor",
  ].join("\n");
  const validation = validateRedispatch(badRedispatch);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => /failed criterion/i.test(e)));
});

test("R09: validateReturnContract accepts STATUS: INPUT GAP with not-run tests", () => {
  const contract = [
    "STATUS: INPUT GAP",
    "FILES: none",
    "TESTS: not-run(input-gap)",
    "INTERFACES: none",
    "REQUIREMENTS: R09",
    "CONCERNS: Missing required specification file for acceptance criteria",
  ].join("\n");
  const result = validateReturnContract(contract);
  assert.equal(result.valid, true);
  assert.equal(result.status, "INPUT GAP");
  assert.equal(result.errors.length, 0);
});

test("R09: validateReturnContract rejects contradictory STATUS: DONE when INPUT GAP is reported in CONCERNS", () => {
  const contract = [
    "STATUS: DONE",
    "FILES: src/calc.mjs",
    "TESTS: было 2 → стало 4",
    "INTERFACES: none",
    "REQUIREMENTS: R09",
    "CONCERNS: INPUT GAP: required schema was missing so we guessed the fields",
  ].join("\n");
  const result = validateReturnContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Противоречивый статус.*INPUT GAP/i.test(e)));
});
