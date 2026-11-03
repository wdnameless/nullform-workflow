#!/usr/bin/env node
/**
 * tools/lifecycle-evals.mjs
 * Deterministic lifecycle evaluations for core workflow state transitions (R03).
 *
 * Covers:
 * 1. pickup -> claim ok
 * 2. double-claim -> 409 already-claimed
 * 3. approval -> deny path (unconfirmed/unapproved transitions refused)
 * 4. backoff-retry (deterministic backoff schedule, retry after release)
 *
 * CLI: node tools/lifecycle-evals.mjs check [--json]
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as claimsModule from "./workflow/claims.mjs";

/** Check whether a task has an active claim. */
export function isClaimed(root, task) {
  if (typeof claimsModule.isClaimed === "function") {
    return claimsModule.isClaimed(root, task);
  }
  const claim = claimsModule.readClaim(root, task);
  return Boolean(claim && claim.endsAt === null);
}

/**
 * Claim a task with 409 conflict normalization.
 * Conforms to T4 contract: double-claim throws error with code 409 (text: already-claimed).
 */
export function claimTask(root, task, owner, contractPath) {
  try {
    return claimsModule.claimTask(root, task, owner, contractPath);
  } catch (err) {
    if (err.code === 409 || err.status === 409) {
      throw err;
    }
    const msg = String(err.message || "").toLowerCase();
    if (err.code === "ECLAIMED" || msg.includes("already claimed") || msg.includes("already-claimed")) {
      const error = new Error(`already-claimed: task "${task}" is already claimed`);
      error.code = 409;
      error.status = 409;
      throw error;
    }
    throw err;
  }
}

/** Release an active claim with its secret token. */
export function releaseTask(root, task, token) {
  return claimsModule.releaseTask(root, task, token);
}

/** Read public projection of a task claim. */
export function readClaim(root, task) {
  return claimsModule.readClaim(root, task);
}

/**
 * Creates a deterministic, isolated fixture directory without git or network prerequisites.
 */
export function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), options.prefix || "lifecycle-eval-"));
  const change = options.change || "demo";
  const manifestDir = join(root, "openspec", "changes", change);
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "pickup.mjs"), "export const pickup = true;\n");
  writeFileSync(join(root, "src", "contended.mjs"), "export const contended = true;\n");
  writeFileSync(join(root, "src", "retry.mjs"), "export const retry = true;\n");
  writeFileSync(
    join(manifestDir, "manifest.md"),
    "| ID | Requirement |\n| R01 | core lifecycle eval pickup |\n| R02 | core lifecycle eval contended |\n| R03 | core lifecycle eval retry |\n"
  );

  const baseContract = {
    schemaVersion: 1,
    change,
    checks: [["node", "--version"]],
  };

  const pickupContract = { ...baseContract, requirements: ["R01"], files: ["src/pickup.mjs"] };
  const contendedContract = { ...baseContract, requirements: ["R02"], files: ["src/contended.mjs"] };
  const retryContract = { ...baseContract, requirements: ["R03"], files: ["src/retry.mjs"] };

  const contractPath = "contract.json";
  const pickupContractPath = "contract-pickup.json";
  const contendedContractPath = "contract-contended.json";
  const retryContractPath = "contract-retry.json";

  writeFileSync(join(root, contractPath), JSON.stringify(pickupContract, null, 2));
  writeFileSync(join(root, pickupContractPath), JSON.stringify(pickupContract, null, 2));
  writeFileSync(join(root, contendedContractPath), JSON.stringify(contendedContract, null, 2));
  writeFileSync(join(root, retryContractPath), JSON.stringify(retryContract, null, 2));

  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (_) {}
  };

  return {
    root,
    change,
    contractPath,
    pickupContractPath,
    contendedContractPath,
    retryContractPath,
    cleanup,
  };
}

/**
 * Pure deterministic backoff calculation for claim contention retry.
 * Pure function: no timers, no wall-clock dependencies.
 */
export function computeBackoff({
  attempt = 1,
  baseMs = 100,
  maxMs = 5000,
  factor = 2,
  maxAttempts = 5,
} = {}) {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const delayMs = Math.min(maxMs, baseMs * Math.pow(factor, safeAttempt - 1));
  return {
    attempt: safeAttempt,
    delayMs,
    canRetry: safeAttempt < maxAttempts,
  };
}

/**
 * Evaluates an approval gate in the task lifecycle.
 * Enforces explicit approval: returns ok: false with status "denied"
 * when approval or required confirmation is absent.
 */
export function evaluateApproval({
  action = "settle",
  approved = false,
  confirmation = false,
  reason = "",
} = {}) {
  if (!approved || !confirmation) {
    return {
      ok: false,
      status: "denied",
      action,
      reason: reason || (!confirmation ? "confirmation-required" : "unapproved"),
    };
  }
  return {
    ok: true,
    status: "approved",
    action,
    reason: reason || "confirmed-by-operator",
  };
}

/** Case 1: pickup -> claim ok */
export function evalPickupClaim(fixture) {
  const root = fixture.root;
  const task = "lifecycle-pickup";
  const owner = "worker-1";

  const initiallyClaimed = isClaimed(root, task);
  if (initiallyClaimed) {
    return {
      pass: false,
      detail: `precondition failed: task ${task} is already claimed`,
    };
  }
  const contractPath = fixture.pickupContractPath || fixture.contractPath;
  const record = claimTask(root, task, owner, contractPath);
  const nowClaimed = isClaimed(root, task);
  const claim = readClaim(root, task);

  const pass = Boolean(
    record &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    nowClaimed === true &&
    claim &&
    claim.owner === owner &&
    claim.endsAt === null
  );

  return {
    pass,
    detail: pass
      ? `task "${task}" claimed ok by ${owner} (generation: ${record.generation})`
      : `pickup/claim failed: claimed=${nowClaimed}, owner=${claim?.owner}`,
    record,
  };
}

/** Case 2: double-claim -> 409 already-claimed */
export function evalDoubleClaim409(fixture) {
  const root = fixture.root;
  const task = "lifecycle-contended";
  const ownerA = "worker-a";
  const ownerB = "worker-b";
  const contractPath = fixture.contendedContractPath || fixture.contractPath;
  const first = claimTask(root, task, ownerA, contractPath);
  if (!isClaimed(root, task)) {
    return {
      pass: false,
      detail: `setup failed: initial claim for ${task} did not take hold`,
    };
  }

  let threw409 = false;
  let errorCode = null;
  let errorMessage = "";

  try {
    claimTask(root, task, ownerB, contractPath);
  } catch (err) {
    errorCode = err.code ?? err.status;
    errorMessage = String(err.message || "");
    const is409 = errorCode === 409 || errorCode === "409" || errorCode === "ECLAIMED" ||
      errorMessage.includes("already-claimed") || errorMessage.includes("already claimed");
    if (is409) {
      threw409 = true;
    }
  }

  const stillClaimed = isClaimed(root, task);
  const currentClaim = readClaim(root, task);
  const holderUnchanged = currentClaim?.owner === ownerA && currentClaim?.endsAt === null;

  const pass = Boolean(threw409 && stillClaimed && holderUnchanged);

  return {
    pass,
    detail: pass
      ? `double-claim refused with 409 (already-claimed), original holder ${ownerA} preserved`
      : `double-claim 409 failed: threw409=${threw409} (code=${errorCode}, msg="${errorMessage}"), holderUnchanged=${holderUnchanged}`,
    firstClaim: first,
  };
}

/** Case 3: approval -> deny path */
export function evalApprovalDeny(_fixture) {
  const unconfirmed = evaluateApproval({
    action: "settle",
    approved: true,
    confirmation: false,
  });

  const deniedUnapproved = evaluateApproval({
    action: "settle",
    approved: false,
    confirmation: true,
    reason: "reviewer-rejected",
  });

  const approvedAction = evaluateApproval({
    action: "settle",
    approved: true,
    confirmation: true,
    reason: "explicit-operator-yes",
  });

  const denyOk = (
    unconfirmed.ok === false &&
    unconfirmed.status === "denied" &&
    unconfirmed.reason === "confirmation-required" &&
    deniedUnapproved.ok === false &&
    deniedUnapproved.status === "denied" &&
    deniedUnapproved.reason === "reviewer-rejected"
  );

  const approveOk = (
    approvedAction.ok === true &&
    approvedAction.status === "approved"
  );

  const pass = denyOk && approveOk;

  return {
    pass,
    detail: pass
      ? "unconfirmed/unapproved transitions denied (confirmation-required/reviewer-rejected); approved transition allowed"
      : `approval-deny evaluation failed: denyOk=${denyOk}, approveOk=${approveOk}`,
  };
}

/** Case 4: backoff-retry */
export function evalBackoffRetry(fixture) {
  const root = fixture.root;
  const task = "lifecycle-retry";
  const ownerA = "agent-alpha";
  const ownerB = "agent-beta";
  const contractPath = fixture.retryContractPath || fixture.contractPath;
  const initial = claimTask(root, task, ownerA, contractPath);
  let attempt1Got409 = false;
  try {
    claimTask(root, task, ownerB, contractPath);
  } catch (err) {
    const is409 = err.code === 409 || err.status === 409 || err.code === "ECLAIMED" ||
      String(err.message).toLowerCase().includes("already");
    if (is409) attempt1Got409 = true;
  }

  const backoff1 = computeBackoff({ attempt: 1, baseMs: 100, maxMs: 1600 });
  const backoff2 = computeBackoff({ attempt: 2, baseMs: 100, maxMs: 1600 });

  const backoffDeterministic = (
    backoff1.delayMs === 100 &&
    backoff1.canRetry === true &&
    backoff2.delayMs === 200 &&
    backoff2.canRetry === true
  );

  releaseTask(root, task, initial.token);
  const released = !isClaimed(root, task);
  const retryClaim = claimTask(root, task, ownerB, contractPath);
  const nowHeldByB = isClaimed(root, task) && readClaim(root, task)?.owner === ownerB;
  const pass = Boolean(attempt1Got409 && backoffDeterministic && released && nowHeldByB);

  return {
    pass,
    detail: pass
      ? `contention 409 -> deterministic backoff (${backoff1.delayMs}ms) -> task released -> retry claim ok (${ownerB}, gen: ${retryClaim.generation})`
      : `backoff-retry failed: 409=${attempt1Got409}, backoff=${backoffDeterministic}, released=${released}, nowHeldByB=${nowHeldByB}`,
    record: retryClaim,
  };
}

export const LIFECYCLE_CASES = [
  { id: "pickup-claim-ok", fn: evalPickupClaim },
  { id: "double-claim-409", fn: evalDoubleClaim409 },
  { id: "approval-deny", fn: evalApprovalDeny },
  { id: "backoff-retry", fn: evalBackoffRetry },
];

/**
 * Execute all lifecycle eval cases.
 * Returns { ok, passed, failed, total, results }
 */
export function runLifecycleEvals(options = {}) {
  const fixture = createFixture(options);
  const results = [];
  let passed = 0;
  let failed = 0;

  try {
    for (const c of LIFECYCLE_CASES) {
      try {
        const r = c.fn(fixture);
        const pass = Boolean(r && r.pass);
        if (pass) passed++; else failed++;
        results.push({
          id: c.id,
          pass,
          detail: r?.detail || (pass ? "passed" : "failed"),
        });
      } catch (err) {
        failed++;
        results.push({
          id: c.id,
          pass: false,
          detail: `exception: ${err.message}`,
        });
      }
    }
  } finally {
    fixture.cleanup();
  }

  const ok = failed === 0 && passed === LIFECYCLE_CASES.length;
  return {
    ok,
    passed,
    failed,
    total: LIFECYCLE_CASES.length,
    results,
  };
}
const isDirect = Boolean(process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})());

if (isDirect) {
  const args = process.argv.slice(2);
  const isCheck = args.includes("check") || args.includes("--check");
  const isJson = args.includes("--json");

  if (!isCheck) {
    console.error("Usage: node tools/lifecycle-evals.mjs check [--json]");
    process.exit(1);
  }

  const report = runLifecycleEvals();

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report.results) {
      if (r.pass) {
        console.log(`PASS ${r.id}: ${r.detail}`);
      } else {
        console.error(`FAIL ${r.id}: ${r.detail}`);
      }
    }
    if (report.ok) {
      console.log(`All ${report.total} lifecycle evals passed.`);
    } else {
      console.error(`Lifecycle evals FAILED: ${report.failed}/${report.total} failed.`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}
