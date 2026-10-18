import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { readClaim } from "../task-claim.mjs";

const workflow = fileURLToPath(new URL("../workflow.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "task-claim-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const change = join(root, "openspec", "changes", "demo");
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, "manifest.md"), "| R01 | own the report |\n");
  writeFileSync(join(root, "contract.json"), JSON.stringify({
    schemaVersion: 1, change: "demo", requirements: ["R01"], files: ["report.mjs"],
    checks: [["node", "--check", "report.mjs"]],
  }));
  return root;
}
const claimArgs = (task = "report", owner = "agent-a") => ["claim", "--task", task, "--owner", owner, "--contract", "contract.json"];
const recordPath = (root, task = "report") => join(root, ".workflow", "claims", `${task}.json`);
function cli(root, args) {
  const result = spawnSync(process.execPath, [workflow, ...args, "--root", root], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, text: result.stdout + result.stderr };
}
function concurrent(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workflow, ...args, "--root", root], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("claim CLI process timed out")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`claim CLI terminated: ${signal}: ${stderr}`));
      else resolve({ status, stdout, stderr, text: stdout + stderr });
    });
  });
}
function granted(result) {
  assert.equal(result.status, 0, result.text);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(typeof body.claim.token, "string");
  assert.notEqual(body.claim.token, "");
  return body.claim;
}
function privateOutput(result, ...tokens) {
  for (const token of tokens) assert.equal(result.text.includes(token), false, "CLI disclosed release authority");
}

test("CLI refusal context and release never expose the acquisition token", (t) => {
  const root = fixture(t);
  const first = granted(cli(root, claimArgs()));
  const before = readFileSync(recordPath(root));
  const refused = cli(root, claimArgs("report", "agent-b"));
  assert.equal(refused.status, 3, refused.text);
  privateOutput(refused, first.token);
  assert.deepEqual(readFileSync(recordPath(root)), before);
  const context = cli(root, ["context", "--change", "demo", "--task", "report"]);
  assert.equal(context.status, 0, context.text);
  privateOutput(context, first.token);
  assert.equal(JSON.stringify(readClaim(root, "report")).includes(first.token), false);
  const released = cli(root, ["release", "--task", "report", "--token", first.token]);
  assert.equal(released.status, 0, released.text);
  privateOutput(released, first.token);
  const replacement = granted(cli(root, claimArgs("report", "agent-b")));
  assert.notEqual(replacement.token, first.token);
  const active = readFileSync(recordPath(root));
  const stale = cli(root, ["release", "--task", "report", "--token", first.token]);
  assert.notEqual(stale.status, 0, stale.text);
  privateOutput(stale, first.token, replacement.token);
  assert.deepEqual(readFileSync(recordPath(root)), active);
  assert.equal(cli(root, ["release", "--task", "report", "--token", replacement.token]).status, 0);
});

test("CLI rejects unknown flags extra positionals and incomplete task contracts", async (t) => {
  const cases = [
    ["unknown-claim-flag", [...claimArgs(), "--unexpected", "value"]],
    ["extra-claim-positional", [...claimArgs(), "unexpected"]],
    ["missing-contract", ["claim", "--task", "report", "--owner", "agent-a"]],
    ["unknown-context-flag", ["context", "--change", "demo", "--task", "report", "--unexpected"]],
    ["extra-context-positional", ["context", "--change", "demo", "--task", "report", "unexpected"]],
    ["missing-context-task", ["context", "--change", "demo"]],
    ["unknown-release-flag", ["release", "--task", "report", "--token", "unused", "--unexpected"]],
    ["extra-release-positional", ["release", "--task", "report", "--token", "unused", "unexpected"]],
  ];
  for (const [name, args] of cases) {
    await t.test(name, (t) => {
      const root = fixture(t);
      let before = null;
      if (args[0] !== "claim") {
        const claim = granted(cli(root, claimArgs()));
        const tokenIndex = args.indexOf("unused");
        if (tokenIndex !== -1) args[tokenIndex] = claim.token;
        before = readFileSync(recordPath(root));
      }
      const result = cli(root, args);
      assert.notEqual(result.status, 0, result.text);
      if (before) assert.deepEqual(readFileSync(recordPath(root)), before);
      else assert.equal(existsSync(recordPath(root)), false);
    });
  }
});

test("concurrent CLI acquisition publishes exactly one authority across task IDs", async (t) => {
  for (const distinctTasks of [false, true]) {
    await t.test(distinctTasks ? "overlapping-different-tasks" : "same-task", async (t) => {
      const root = fixture(t);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => concurrent(root, claimArgs(distinctTasks ? `task-${i}` : "report", `agent-${i}`))));
      const winners = results.filter((result) => result.status === 0);
      assert.equal(winners.length, 1, results.map((result) => result.text).join("\n"));
      const winner = granted(winners[0]);
      for (const loser of results.filter((result) => result.status !== 0)) privateOutput(loser, winner.token);
      const task = distinctTasks ? `task-${winner.owner.split("-").at(-1)}` : "report";
      const publicClaim = readClaim(root, task);
      assert.equal(publicClaim.owner, winner.owner);
      assert.equal(publicClaim.endsAt, null);
      assert.equal(JSON.stringify(publicClaim).includes(winner.token), false);
      assert.equal(cli(root, ["release", "--task", task, "--token", winner.token]).status, 0);
    });
  }
});

test("concurrent CLI releases cannot both consume one generation", async (t) => {
  const root = fixture(t);
  const first = granted(cli(root, claimArgs()));
  const results = await Promise.all(Array.from({ length: 4 }, () => concurrent(root, ["release", "--task", "report", "--token", first.token])));
  assert.equal(results.filter((result) => result.status === 0).length, 1, results.map((result) => result.text).join("\n"));
  for (const result of results) privateOutput(result, first.token);
  assert.ok(Number.isFinite(Date.parse(readClaim(root, "report").endsAt)));
  const replacement = granted(cli(root, claimArgs("report", "agent-b")));
  assert.notEqual(replacement.token, first.token);
  const before = readFileSync(recordPath(root));
  const stale = await Promise.all(Array.from({ length: 4 }, () => concurrent(root, ["release", "--task", "report", "--token", first.token])));
  assert.equal(stale.some((result) => result.status === 0), false);
  for (const result of stale) privateOutput(result, first.token, replacement.token);
  assert.deepEqual(readFileSync(recordPath(root)), before);
  assert.equal(cli(root, ["release", "--task", "report", "--token", replacement.token]).status, 0);
});

test("CLI refuses parent junctions without writing external claims or returning external requirements", async (t) => {
  for (const parent of [".workflow", "openspec"]) {
    await t.test(parent, (t) => {
      const root = fixture(t);
      const outside = fixture(t);
      if (parent === "openspec") {
        granted(cli(root, claimArgs()));
        renameSync(join(root, "openspec"), join(root, "original-openspec"));
      }
      try {
        symlinkSync(join(outside, parent === "openspec" ? "openspec" : "."), join(root, parent), "junction");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
        t.skip(`junction prerequisite unavailable: ${error.code}`);
        return;
      }
      const marker = "EXTERNAL-REQUIREMENT-MUST-NOT-APPEAR";
      writeFileSync(join(outside, "openspec", "changes", "demo", "manifest.md"), `| R01 | ${marker} |\n`);
      const result = cli(root, parent === ".workflow" ? claimArgs() : ["context", "--change", "demo", "--task", "report"]);
      assert.notEqual(result.status, 0, result.text);
      assert.equal(result.text.includes(marker), false);
      assert.equal(existsSync(join(outside, "claims")), false);
      assert.equal(readFileSync(join(outside, "openspec", "changes", "demo", "manifest.md"), "utf8"), `| R01 | ${marker} |\n`);
    });
  }
});
