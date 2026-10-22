import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { checkPlan } from "../plan-check.mjs";
import { coverageCheck, coverageGate } from "../coverage-check.mjs";
import { blindAccept } from "../blind-accept.mjs";

test("checkPlan: coverage both-ways ok", () => {
  const manifestRows = [
    { id: "R01", status: "in-spec" },
    { id: "R02", status: "in-ticket" },
    { id: "R03", status: "placeholder" },
    { id: "R04", status: "done" },
    { id: "R05", status: "dropped" },
  ];

  const tickets = [
    {
      id: "T01",
      requirements: ["R01", "R02"],
      wave: 1,
      zone: ["tools/plan-check.mjs"],
      blockedBy: [],
    },
    {
      id: "T02",
      requirements: ["R03"],
      wave: 2,
      zone: ["tools/coverage-check.mjs"],
      blockedBy: ["T01"],
    },
  ];

  const result = checkPlan(manifestRows, tickets);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("checkPlan: empty inputs default cleanly", () => {
  const res = checkPlan();
  assert.equal(res.ok, true);
  assert.deepEqual(res.problems, []);
});

test("checkPlan: missing requirement fails (both directions)", () => {
  // Case A: live requirement not covered in tickets
  const manifestRows = [
    { id: "R01", status: "in-spec" },
    { id: "R02", status: "in-ticket" },
  ];
  const ticketsA = [
    {
      id: "T01",
      requirements: ["R01"],
      wave: 1,
      zone: ["tools/a.mjs"],
      blockedBy: [],
    },
  ];
  const resA = checkPlan(manifestRows, ticketsA);
  assert.equal(resA.ok, false);
  assert.ok(resA.problems.some((p) => p.includes("R02")));

  // Case B: ticket references non-existent requirement
  const ticketsB = [
    {
      id: "T01",
      requirements: ["R01", "R99"],
      wave: 1,
      zone: ["tools/a.mjs"],
      blockedBy: [],
    },
  ];
  const resB = checkPlan([{ id: "R01", status: "in-spec" }], ticketsB);
  assert.equal(resB.ok, false);
  assert.ok(resB.problems.some((p) => p.includes("T01") && p.includes("R99")));
});

test("checkPlan: zone collision fails naming both tickets", () => {
  // Prefix overlap in same wave
  const manifestRows = [
    { id: "R01", status: "in-spec" },
    { id: "R02", status: "in-spec" },
  ];
  const ticketsPrefix = [
    {
      id: "T01",
      requirements: ["R01"],
      wave: 1,
      zone: ["tools/"],
      blockedBy: [],
    },
    {
      id: "T02",
      requirements: ["R02"],
      wave: 1,
      zone: ["tools/plan-check.mjs"],
      blockedBy: [],
    },
  ];

  const resPrefix = checkPlan(manifestRows, ticketsPrefix);
  assert.equal(resPrefix.ok, false);
  assert.ok(
    resPrefix.problems.some(
      (p) => p.includes("T01") && p.includes("T02")
    )
  );

  // Exact match in same wave
  const ticketsExact = [
    {
      id: "T10",
      requirements: ["R01"],
      wave: 1,
      zone: ["src/index.mjs"],
      blockedBy: [],
    },
    {
      id: "T20",
      requirements: ["R02"],
      wave: 1,
      zone: ["src/index.mjs"],
      blockedBy: [],
    },
  ];
  const resExact = checkPlan(manifestRows, ticketsExact);
  assert.equal(resExact.ok, false);
  assert.ok(
    resExact.problems.some((p) => p.includes("T10") && p.includes("T20"))
  );

  // Same zone in different waves is allowed
  const ticketsDiffWaves = [
    {
      id: "T30",
      requirements: ["R01"],
      wave: 1,
      zone: ["src/index.mjs"],
      blockedBy: [],
    },
    {
      id: "T31",
      requirements: ["R02"],
      wave: 2,
      zone: ["src/index.mjs"],
      blockedBy: ["T30"],
    },
  ];
  const resDiff = checkPlan(manifestRows, ticketsDiffWaves);
  assert.equal(resDiff.ok, true);
  assert.deepEqual(resDiff.problems, []);
});

test("checkPlan: bad wave fails", () => {
  const manifestRows = [
    { id: "R01", status: "in-spec" },
    { id: "R02", status: "in-spec" },
  ];

  // No deps but wave != 1
  const ticketsNoDeps = [
    {
      id: "T01",
      requirements: ["R01", "R02"],
      wave: 2,
      zone: ["tools/a.mjs"],
      blockedBy: [],
    },
  ];
  const resNoDeps = checkPlan(manifestRows, ticketsNoDeps);
  assert.equal(resNoDeps.ok, false);
  assert.ok(resNoDeps.problems.some((p) => p.includes("T01")));

  // Dep wave mismatch: T02 dep on T01 (wave 1) must be wave 2, but is 3
  const ticketsBadDepWave = [
    {
      id: "T01",
      requirements: ["R01"],
      wave: 1,
      zone: ["tools/a.mjs"],
      blockedBy: [],
    },
    {
      id: "T02",
      requirements: ["R02"],
      wave: 3,
      zone: ["tools/b.mjs"],
      blockedBy: ["T01"],
    },
  ];
  const resBadWave = checkPlan(manifestRows, ticketsBadDepWave);
  assert.equal(resBadWave.ok, false);
  assert.ok(resBadWave.problems.some((p) => p.includes("T02")));

  // Missing blockedBy dependency
  const ticketsMissingDep = [
    {
      id: "T01",
      requirements: ["R01", "R02"],
      wave: 1,
      zone: ["tools/a.mjs"],
      blockedBy: ["T99"],
    },
  ];
  const resMissingDep = checkPlan(manifestRows, ticketsMissingDep);
  assert.equal(resMissingDep.ok, false);
  assert.ok(
    resMissingDep.problems.some((p) => p.includes("T01") && p.includes("T99"))
  );

  // Missing zone or wave
  const ticketsMissingFields = [
    {
      id: "T01",
      requirements: ["R01"],
      wave: 1,
      zone: [],
      blockedBy: [],
    },
    {
      id: "T02",
      requirements: ["R02"],
      zone: ["tools/b.mjs"],
      blockedBy: [],
    },
  ];
  const resMissingFields = checkPlan(manifestRows, ticketsMissingFields);
  assert.equal(resMissingFields.ok, false);
  assert.ok(resMissingFields.problems.some((p) => p.includes("T01")));
  assert.ok(resMissingFields.problems.some((p) => p.includes("T02")));
});

test("coverageCheck and coverageGate: found/fixed/deferred + gate", () => {
  const briefText = `
    The system MUST validate input.
    The system MUST log all actions.
    The system MUST encrypt data at rest.
  `;

  const partialSpec = `
    # Spec
    The system MUST validate input.
    The system MUST log all actions.
  `;

  // Gap found
  const gapResult = coverageCheck(briefText, partialSpec);
  assert.equal(gapResult.found, 1);
  assert.equal(gapResult.fixed, 0);
  assert.equal(gapResult.deferred, 0);
  assert.equal(gapResult.items.length, 1);
  assert.ok(gapResult.items[0].includes("encrypt data at rest"));

  // Gate fails when found > fixed + deferred
  assert.equal(coverageGate(gapResult), false);

  // Gate passes when fixed covers gaps
  assert.equal(coverageGate({ ...gapResult, fixed: 1 }), true);

  // Gate passes when deferred covers gaps
  assert.equal(coverageGate({ ...gapResult, deferred: 1 }), true);

  // Gate passes when combination covers gaps
  assert.equal(coverageGate({ ...gapResult, found: 2, fixed: 1, deferred: 1 }), true);
  assert.equal(coverageGate({ ...gapResult, found: 3, fixed: 1, deferred: 1 }), false);

  // Full coverage passes directly
  const fullSpec = `
    # Spec
    The system MUST validate input.
    The system MUST log all actions.
    The system MUST encrypt data at rest.
  `;
  const fullResult = coverageCheck(briefText, fullSpec);
  assert.equal(fullResult.found, 0);
  assert.equal(fullResult.items.length, 0);
  assert.equal(coverageGate(fullResult), true);
});

test("blindAccept: fixture git repo proves forbidden paths absent and runner result recorded", async () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), "ap-blind-fixture-"));

  try {
    // 1. Initialize fixture git repo
    const runGit = (args) => {
      const res = spawnSync("git", args, { cwd: fixtureRepo, stdio: "pipe", encoding: "utf8" });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
      }
    };

    runGit(["init"]);
    runGit(["config", "user.name", "Tester"]);
    runGit(["config", "user.email", "tester@example.com"]);

    // 2. Populate fixture repo with forbidden and allowed paths
    mkdirSync(join(fixtureRepo, "openspec", "changes", "test"), { recursive: true });
    writeFileSync(join(fixtureRepo, "openspec", "changes", "test", "spec.md"), "forbidden spec");
    writeFileSync(join(fixtureRepo, "openspec", "manifest.md"), "forbidden manifest");

    mkdirSync(join(fixtureRepo, "tickets"), { recursive: true });
    writeFileSync(join(fixtureRepo, "tickets", "T01.md"), "forbidden ticket");

    mkdirSync(join(fixtureRepo, "sub", "tickets"), { recursive: true });
    writeFileSync(join(fixtureRepo, "sub", "tickets", "T02.md"), "forbidden sub ticket");
    writeFileSync(join(fixtureRepo, "sub", "spec.md"), "forbidden sub spec");
    writeFileSync(join(fixtureRepo, "sub", "manifest.md"), "forbidden sub manifest");

    mkdirSync(join(fixtureRepo, "src"), { recursive: true });
    writeFileSync(join(fixtureRepo, "src", "index.mjs"), "console.log('hello');");
    writeFileSync(join(fixtureRepo, "README.md"), "# Project Readme");

    runGit(["add", "-A"]);
    runGit(["commit", "-m", "initial fixture commit"]);

    const briefText = "Must implement login and logout.";
    let capturedCloneDir = null;

    // 3. Run blindAccept
    const result = await blindAccept(fixtureRepo, briefText, async (cloneDir, brief) => {
      capturedCloneDir = cloneDir;

      // Assert briefText was passed
      assert.equal(brief, briefText);

      // Assert forbidden paths were purged
      assert.equal(existsSync(join(cloneDir, "openspec")), false, "openspec/ must be deleted");
      assert.equal(existsSync(join(cloneDir, "tickets")), false, "tickets/ must be deleted");
      assert.equal(existsSync(join(cloneDir, "sub", "spec.md")), false, "sub/spec.md must be deleted");
      assert.equal(existsSync(join(cloneDir, "sub", "manifest.md")), false, "sub/manifest.md must be deleted");
      assert.equal(existsSync(join(cloneDir, "sub", "tickets")), false, "sub/tickets/ must be deleted");

      // Assert allowed files survive
      assert.equal(existsSync(join(cloneDir, "src", "index.mjs")), true, "src/index.mjs must exist");
      assert.equal(existsSync(join(cloneDir, "README.md")), true, "README.md must exist");

      return {
        checked: 2,
        matched: 2,
        mismatches: [],
      };
    });

    // 4. Verify runner result was returned
    assert.deepEqual(result, {
      checked: 2,
      matched: 2,
      mismatches: [],
    });

    // 5. Verify cloneDir was cleaned up in finally
    assert.ok(capturedCloneDir !== null);
    assert.equal(existsSync(capturedCloneDir), false, "cloneDir must be removed in finally");
  } finally {
    try {
      rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_) {}
  }
});

test("blindAccept: validates inputs", async () => {
  await assert.rejects(() => blindAccept("", "brief", () => {}), /repoDir must be a non-empty string/);
  await assert.rejects(() => blindAccept("/some/dir", "brief", null), /runner must be a function/);
});
