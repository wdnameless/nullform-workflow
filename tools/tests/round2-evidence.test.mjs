import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freezeAssets, verifyAssets } from "../asset-freeze.mjs";
import { checkpointWave, resumeWave } from "../checkpoints.mjs";
import { appendReceipt, verifyChain } from "../capsule.mjs";

function makeTempDir(prefix = "r2-evidence-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("freezeAssets and verifyAssets: ok on unchanged assets", () => {
  const dir = makeTempDir();
  try {
    const fileA = join(dir, "assetA.txt");
    const fileB = join(dir, "assetB.txt");
    writeFileSync(fileA, "content-a", "utf8");
    writeFileSync(fileB, "content-b", "utf8");

    const record = freezeAssets([fileA, fileB]);
    assert.equal(record.assets.length, 2);
    assert.equal(record.assets[0].path, fileA);
    assert.equal(record.assets[1].path, fileB);
    assert.match(record.assets[0].sha256, /^[a-f0-9]{64}$/);

    const res = verifyAssets(record);
    assert.equal(res.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyAssets: fails naming asset on tampered content", () => {
  const dir = makeTempDir();
  try {
    const fileA = join(dir, "critical-test.js");
    writeFileSync(fileA, "assert.ok(true);", "utf8");

    const record = freezeAssets([fileA]);
    writeFileSync(fileA, "assert.ok(false);", "utf8");

    assert.throws(
      () => verifyAssets(record),
      (err) => {
        assert.match(err.message, /critical-test\.js/);
        assert.match(err.message, /mismatch/i);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyAssets: fails naming asset when matching an exclude-mask", () => {
  const dir = makeTempDir();
  try {
    const fileA = join(dir, "agent-patch-target.mjs");
    writeFileSync(fileA, "export const x = 1;", "utf8");

    const record = freezeAssets([fileA], { masks: ["patch-target"] });
    assert.throws(
      () => verifyAssets(record),
      (err) => {
        assert.match(err.message, /agent-patch-target\.mjs/);
        assert.match(err.message, /mask/i);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpointWave and resumeWave: skips completed waves and resumes first incomplete", () => {
  const dir = makeTempDir();
  try {
    checkpointWave(dir, 1, { status: "complete", output: "step 1 ok" });
    checkpointWave(dir, 2, { status: "complete", output: "step 2 ok" });
    checkpointWave(dir, 3, { status: "failed", error: "step 3 exploded" });
    checkpointWave(dir, 4, { status: "pending" });

    const resume = resumeWave(dir);
    assert.ok(resume !== null, "resumeWave must return incomplete wave");
    assert.equal(resume.wave, 3);
    assert.equal(resume.state.status, "failed");
    assert.equal(resume.state.error, "step 3 exploded");

    // Once wave 3 and 4 complete, resume returns null
    checkpointWave(dir, 3, { status: "complete", output: "step 3 recovered" });
    checkpointWave(dir, 4, { status: "complete", output: "step 4 ok" });

    const done = resumeWave(dir);
    assert.equal(done, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpointWave: respects numeric wave order over lexicographic", () => {
  const dir = makeTempDir();
  try {
    // wave-10 vs wave-2
    checkpointWave(dir, 1, { status: "complete" });
    checkpointWave(dir, 2, { status: "failed", reason: "w2 failed" });
    checkpointWave(dir, 10, { status: "failed", reason: "w10 failed" });

    const resume = resumeWave(dir);
    assert.ok(resume !== null);
    assert.equal(resume.wave, 2);
    assert.equal(resume.state.reason, "w2 failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendReceipt and verifyChain: appends valid NDJSON chain and verifies", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "receipts.ndjson");

    const r0 = appendReceipt(logPath, { effect: "SE0", body: { action: "plan" } });
    assert.equal(r0.seq, 0);
    assert.equal(r0.prev, "");
    assert.equal(r0.effect, "SE0");
    assert.match(r0.hash, /^[a-f0-9]{64}$/);

    const r1 = appendReceipt(logPath, { effect: "SE1", body: { file: "test.js", lines: 10 } });
    assert.equal(r1.seq, 1);
    assert.equal(r1.prev, r0.hash);
    assert.equal(r1.effect, "SE1");

    const r2 = appendReceipt(logPath, { effect: "SE4", body: { outcome: "committed" } });
    assert.equal(r2.seq, 2);
    assert.equal(r2.prev, r1.hash);

    const result = verifyChain(logPath);
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendReceipt: rejects invalid effect class", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "receipts.ndjson");
    assert.throws(
      () => appendReceipt(logPath, { effect: "SE99", body: "invalid" }),
      /invalid effect/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyChain: fails naming broken seq when a receipt line is modified", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "receipts.ndjson");
    appendReceipt(logPath, { effect: "SE0", body: { step: 0 } });
    appendReceipt(logPath, { effect: "SE1", body: { step: 1 } });
    appendReceipt(logPath, { effect: "SE2", body: { step: 2 } });

    // Mutate line 1 body
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.body.step = 999;
    lines[1] = JSON.stringify(tampered);
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    assert.throws(
      () => verifyChain(logPath),
      (err) => {
        assert.match(err.message, /seq\s*1/i);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyChain: fails naming broken seq when a receipt line is deleted", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "receipts.ndjson");
    appendReceipt(logPath, { effect: "SE0", body: { step: 0 } });
    appendReceipt(logPath, { effect: "SE1", body: { step: 1 } });
    appendReceipt(logPath, { effect: "SE2", body: { step: 2 } });

    // Remove line 1 (seq 1 deleted)
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    lines.splice(1, 1);
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    assert.throws(
      () => verifyChain(logPath),
      (err) => {
        // Line after deleted one (seq 2) will fail either on seq or prev mismatch
        assert.match(err.message, /seq\s*2/i);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoints and capsule: handle empty/missing sources cleanly", () => {
  const dir = makeTempDir();
  try {
    assert.equal(resumeWave(join(dir, "nonexistent")), null);
    assert.deepEqual(verifyChain(join(dir, "nonexistent.ndjson")), { ok: true, count: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
