#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { extractFinalAssistantResponse, verifyFrozenTests, writeScore } from "./common.mjs";
import { validateReturnContract } from "../../tools/return-contract.mjs";

const failures = [];
try {
  const root = process.cwd();
  const snapshot = JSON.parse(readFileSync(join(process.env.BENCH_RUN_DIR, "frozen-tests.json"), "utf8"));
  if (!verifyFrozenTests(root, snapshot)) failures.push("Stage-A test bytes changed against runner-owned predispatch digest");
  const tests = spawnSync("node", ["--test", "--test-reporter=tap", "tests/calc.test.mjs"], { cwd: root, encoding: "utf8", shell: false, timeout: 10000 });
  if (tests.status !== 0 || !/^# tests 2$/m.test(tests.stdout || "") || !/^# pass 2$/m.test(tests.stdout || "")) failures.push(`Frozen baseline test execution/counts failed: ${tests.stdout}${tests.stderr}`);
  const { multiply, add } = await import(pathToFileURL(join(root, "src", "calc.mjs")).href);
  if (add(2,3) !== 5 || multiply(3,4) !== 12 || multiply(-2,5) !== -10 || multiply(0,100) !== 0 || multiply(0.5,3) !== 1.5) failures.push("Actual code failed fixed runtime edge checks");
  if (!verifyFrozenTests(root, snapshot)) failures.push("Test bytes changed during execution");
  const { finalText, toolCalls } = extractFinalAssistantResponse();
  const contract = validateReturnContract(finalText);
  if (!contract.valid || !["DONE", "DONE_WITH_CONCERNS"].includes(contract.status)) failures.push(`Invalid completion contract: ${contract.errors.join("; ")}`);
  if (!toolCalls.some(call => call.name === "write")) failures.push("No actual implementation write in native session");
} catch (error) { failures.push(error.message); }
process.exitCode = writeScore("workflow", { requirementsSatisfied: failures.length === 0, failures });
