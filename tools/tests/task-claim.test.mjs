import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimTask, releaseTask, readClaim, contextPacket } from "../task-claim.mjs";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "task-claim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("claim grants exactly one writer; second writer refused without retry", (t) => {
  const root = sandbox(t);
  const first = claimTask(root, "export-report", "agent-a");
  assert.equal(first.owner, "agent-a");
  assert.equal(first.endsAt, null);
  assert.throws(() => claimTask(root, "export-report", "agent-b"), (e) => e.code === "ECLAIMED" && /never retry/i.test(e.message));
  assert.equal(readClaim(root, "export-report").owner, "agent-a");
});

test("release requires holder token; wrong token refuses, correct token ends", (t) => {
  const root = sandbox(t);
  const c = claimTask(root, "export-report", "agent-a");
  assert.throws(() => releaseTask(root, "export-report", "wrong-token"), (e) => e.code === "ETOKEN");
  assert.equal(readClaim(root, "export-report").endsAt, null);
  const done = releaseTask(root, "export-report", c.token);
  assert.ok(done.endsAt);
  assert.throws(() => releaseTask(root, "export-report", c.token), (e) => e.code === "EENDED");
});

test("release of unknown task fails closed; malformed ids rejected", (t) => {
  const root = sandbox(t);
  assert.throws(() => releaseTask(root, "ghost", "t"), (e) => e.code === "ENOCLAIM");
  assert.throws(() => claimTask(root, "../escape", "a"), /--task must be/);
  assert.throws(() => claimTask(root, "ok", ""), /--owner must be/);
});

test("symlinked claims dir refused; ended claim record retained", (t) => {
  const root = sandbox(t);
  const c = claimTask(root, "keep", "agent-a");
  releaseTask(root, "keep", c.token);
  assert.ok(readClaim(root, "keep").endsAt);
  const evil = mkdtempSync(join(tmpdir(), "task-claim-evil-"));
  t.after(() => rmSync(evil, { recursive: true, force: true }));
  const root2 = sandbox(t);
  mkdirSync(join(root2, ".workflow"), { recursive: true });
  try {
    symlinkSync(evil, join(root2, ".workflow", "claims"), "junction");
  } catch {
    t.skip("symlink prerequisite unavailable");
    return;
  }
  assert.throws(() => claimTask(root2, "x", "a"), /symlink\/junction/);
});

test("context packet carries goal ancestry from real manifest/spec/tasks", (t) => {
  const root = sandbox(t);
  const base = join(root, "openspec", "changes", "demo");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "manifest.md"), "| ID | Quote |\n| R01 | «fix export» |\n| R02 | «keep format» |\n");
  writeFileSync(join(base, "proposal.md"), "Goal: reliable exports for operators.\n");
  writeFileSync(join(base, "tasks.md"), "- [ ] T01 export flow\n- [ ] T02 verify output\n");
  const c = claimTask(root, "t01", "agent-a");
  const packet = contextPacket(root, { change: "demo", task: "t01" });
  assert.equal(packet.claim.token, c.token);
  assert.match(packet.goalAncestry.proposal, /reliable exports/);
  assert.equal(packet.goalAncestry.requirements.length, 2);
  assert.match(packet.scope.tasks, /T01 export flow/);
  assert.ok(packet.nonGoals.length >= 3 && packet.verification.length >= 2);
});

test("context packet fails without manifest or unclaimed task", (t) => {
  const root = sandbox(t);
  assert.throws(() => contextPacket(root, { change: "missing" }), /Missing .*manifest\.md/);
  const base = join(root, "openspec", "changes", "demo");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "manifest.md"), "| R01 | x |\n");
  assert.throws(() => contextPacket(root, { change: "demo", task: "ghost" }), /claim it first/);
  assert.throws(() => contextPacket(root, { change: "../escape" }), /alphanumeric slug/);
});
