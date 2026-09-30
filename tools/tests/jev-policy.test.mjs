import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { readPolicy } from "../jev-assist.mjs";
import { policyFingerprint } from "../jev-evidence.mjs";
import { createTempDir, makeValidReportFixture } from "./jev-test-helpers.mjs";

test("readPolicy: returns validated policy with decisionSnapshots when report sha256, fingerprint and hurdles match", () => {
  const tmp = createTempDir("policy-valid-");
  try {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const catalogFingerprint = "cat";
    const candidateModel = "cand";
    const baselineModel = "base";
    const decisionModel = "typesafe/jev-1.13";
    const fp = policyFingerprint({
      catalogFingerprint,
      candidateModel,
      baselineModel,
      decisionModel,
    });

    const reportObj = makeValidReportFixture();
    reportObj.modelPrices = { "cand": { inputRate: 0.042 } };
    reportObj.decisionSnapshots = ["typesafe/jev-1.13-20260917"];

    const reportJson = JSON.stringify(reportObj, null, 2);
    const reportSha256 = createHash("sha256").update(reportJson, "utf8").digest("hex");
    writeFileSync(join(agentDir, "jev-evaluation.json"), reportJson, "utf8");

    const policyObj = {
      version: 1,
      enabled: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      catalogFingerprint,
      candidateModel,
      baselineModel,
      decisionModel,
      fingerprint: fp,
      skillPassed: true,
      routingPassed: true,
      reportSha256,
      archetypes: ["lookup"],
    };
    writeFileSync(join(agentDir, "jev-policy.json"), JSON.stringify(policyObj, null, 2), "utf8");

    const policy = readPolicy({ home, cwd, fingerprint: policyObj.fingerprint });
    assert.ok(policy !== null);
    assert.equal(policy.enabled, true);
    assert.equal(policy.skillPassed, true);
    assert.equal(policy.routingPassed, true);
    assert.deepEqual(policy.archetypes, ["lookup"]);
    assert.deepEqual(policy.decisionSnapshots, ["typesafe/jev-1.13-20260917"]);
    assert.deepEqual(policy.modelPrices, { "cand": { inputRate: 0.042 } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readPolicy: returns null on sha256 mismatch, expired policy, or opt-out", () => {
  const tmp = createTempDir("policy-invalid-");
  try {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // 1. Report tampered (sha mismatch)
    writeFileSync(join(agentDir, "jev-evaluation.json"), JSON.stringify({ version: 1 }), "utf8");
    writeFileSync(
      join(agentDir, "jev-policy.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat",
        candidateModel: "cand",
        baselineModel: "base",
        decisionModel: "typesafe/jev-1.13",
        fingerprint: "fake",
        reportSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
      "utf8"
    );

    assert.equal(readPolicy({ home, cwd }), null, "Must reject on reportSha256 mismatch");

    // 2. Expired policy
    writeFileSync(
      join(agentDir, "jev-policy.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
      "utf8"
    );
    assert.equal(readPolicy({ home, cwd }), null, "Must reject expired policy");

    // 3. Project opt-out file
    writeFileSync(join(cwd, ".jev-optout"), "", "utf8");
    assert.equal(readPolicy({ home, cwd }), null, "Must honor opt-out");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
