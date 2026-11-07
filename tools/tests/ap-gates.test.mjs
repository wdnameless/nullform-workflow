import test from "node:test";
import assert from "node:assert/strict";

import { checkPlan } from "../plan-check.mjs";

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

