import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  isClaimed,
  claimTask,
  readClaim,
  evaluateApproval,
  computeBackoff,
  createFixture,
  evalPickupClaim,
  evalDoubleClaim409,
  evalApprovalDeny,
  evalBackoffRetry,
  runLifecycleEvals,
} from "../lifecycle-evals.mjs";

const CLI_PATH = resolve(fileURLToPath(new URL("../lifecycle-evals.mjs", import.meta.url)));

test("lifecycle case 1: pickup -> claim ok", () => {
  const f = createFixture({ prefix: "eval-test-pickup-" });
  try {
    const task = "task-pickup";
    assert.equal(isClaimed(f.root, task), false);

    const res = evalPickupClaim(f);
    assert.equal(res.pass, true);
    assert.equal(isClaimed(f.root, "lifecycle-pickup"), true);

    const record = readClaim(f.root, "lifecycle-pickup");
    assert.equal(record.owner, "worker-1");
    assert.equal(record.endsAt, null);
  } finally {
    f.cleanup();
  }
});

test("lifecycle case 2: double-claim -> 409 already-claimed", () => {
  const f = createFixture({ prefix: "eval-test-409-" });
  try {
    const res = evalDoubleClaim409(f);
    assert.equal(res.pass, true);

    // Verify raw claimTask throws 409 directly
    assert.throws(
      () => claimTask(f.root, "lifecycle-contended", "intruder", f.contractPath),
      (err) => {
        const code = err.code ?? err.status;
        const msg = String(err.message || "");
        return (code === 409 || code === "409" || code === "ECLAIMED") &&
          (msg.includes("already-claimed") || msg.includes("already claimed"));
      }
    );
  } finally {
    f.cleanup();
  }
});

test("lifecycle case 3: approval -> deny path", () => {
  const f = createFixture({ prefix: "eval-test-deny-" });
  try {
    const res = evalApprovalDeny(f);
    assert.equal(res.pass, true);

    // Missing confirmation (e.g. without --yes) is denied
    const unconfirmed = evaluateApproval({ action: "settle", approved: true, confirmation: false });
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.status, "denied");
    assert.equal(unconfirmed.reason, "confirmation-required");

    // Rejected review is denied
    const rejected = evaluateApproval({ action: "settle", approved: false, confirmation: true, reason: "review-findings" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, "denied");
    assert.equal(rejected.reason, "review-findings");

    // Explicit approval and confirmation passes
    const allowed = evaluateApproval({ action: "settle", approved: true, confirmation: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.status, "approved");
  } finally {
    f.cleanup();
  }
});

test("lifecycle case 4: backoff-retry deterministic schedule", () => {
  const f = createFixture({ prefix: "eval-test-retry-" });
  try {
    // Deterministic backoff schedule without wall-clock drift
    const b1 = computeBackoff({ attempt: 1, baseMs: 50, factor: 2 });
    const b2 = computeBackoff({ attempt: 2, baseMs: 50, factor: 2 });
    const b3 = computeBackoff({ attempt: 3, baseMs: 50, factor: 2 });
    assert.equal(b1.delayMs, 50);
    assert.equal(b2.delayMs, 100);
    assert.equal(b3.delayMs, 200);

    const res = evalBackoffRetry(f);
    assert.equal(res.pass, true);
    assert.equal(res.record.owner, "agent-beta");
    assert.equal(res.record.generation, 2);
  } finally {
    f.cleanup();
  }
});

test("runLifecycleEvals suite passes all 4 cases", () => {
  const suite = runLifecycleEvals();
  assert.equal(suite.ok, true);
  assert.equal(suite.passed, 4);
  assert.equal(suite.failed, 0);
  assert.equal(suite.total, 4);
});

test("CLI: node tools/lifecycle-evals.mjs check exits 0", () => {
  const out = execFileSync(process.execPath, [CLI_PATH, "check"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(out, /PASS pickup-claim-ok/);
  assert.match(out, /PASS double-claim-409/);
  assert.match(out, /PASS approval-deny/);
  assert.match(out, /PASS backoff-retry/);
  assert.match(out, /All 4 lifecycle evals passed/);
});

test("CLI: node tools/lifecycle-evals.mjs check --json prints json", () => {
  const out = execFileSync(process.execPath, [CLI_PATH, "check", "--json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.passed, 4);
  assert.equal(data.total, 4);
});
