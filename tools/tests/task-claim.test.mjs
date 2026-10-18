import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { claimTask, releaseTask, readClaim, contextPacket } from "../task-claim.mjs";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "task-claim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t, overrides = {}) {
  const root = sandbox(t);
  const base = join(root, "openspec", "changes", "demo");
  mkdirSync(base, { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "report.mjs"), "export const report = 1;\n");
  writeFileSync(join(base, "manifest.md"), "| ID | Quote |\n| R01 | export report |\n| R02 | preserve format |\n");
  const contract = {
    schemaVersion: 1, change: "demo", requirements: ["R01"],
    files: ["src/report.mjs"], checks: [["node", "--test", "tools/tests/report.test.mjs"]],
    ...overrides,
  };
  const contractPath = "contract.json";
  writeFileSync(join(root, contractPath), JSON.stringify(contract));
  return { root, base, contract, contractPath };
}

const statePath = (root, task = "export-report") => join(root, ".workflow", "claims", `${task}.json`);
const acquire = (f, task = "export-report", owner = "agent-a") => claimTask(f.root, task, owner, f.contractPath);
const packet = (f) => contextPacket(f.root, { change: "demo", task: "export-report" });
const digest = (value) => createHash("sha256").update(value).digest("hex");

function assertPrivate(value, ...tokens) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const token of tokens) assert.equal(text.includes(token), false, "public response disclosed release authority");
}

function link(t, target, destination, directory = true) {
  try {
    symlinkSync(target, destination, directory ? "junction" : "file");
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
    t.skip(`symlink prerequisite unavailable: ${error.code}`);
    return false;
  }
}

test("claim grants one writer without disclosing holder authority", (t) => {
  const f = fixture(t);
  const first = acquire(f);
  assert.equal(first.owner, "agent-a");
  assert.equal(first.endsAt, null);
  assert.equal(typeof first.token, "string");
  assert.notEqual(first.token, "");
  const before = readFileSync(statePath(f.root));
  assert.throws(() => acquire(f, "export-report", "agent-b"), (error) => {
    assertPrivate(error.message, first.token);
    return error.code === "ECLAIMED";
  });
  assert.deepEqual(readFileSync(statePath(f.root)), before);
  assert.equal(readClaim(f.root, "export-report").owner, "agent-a");
  assertPrivate(readClaim(f.root, "export-report"), first.token);
  assertPrivate(packet(f), first.token);
});

test("release fences replacement authority and preserves ended generations", (t) => {
  const f = fixture(t);
  const first = acquire(f);
  assert.throws(() => releaseTask(f.root, "export-report", "wrong-token"), (error) => error.code === "ETOKEN");
  assert.equal(readClaim(f.root, "export-report").endsAt, null);
  const ended = releaseTask(f.root, "export-report", first.token);
  assert.ok(Number.isFinite(Date.parse(ended.endsAt)));
  assertPrivate(ended, first.token);
  assert.throws(() => releaseTask(f.root, "export-report", first.token), (error) => error.code === "EENDED");
  const second = acquire(f, "export-report", "agent-b");
  assert.notEqual(second.token, first.token);
  assert.equal(second.generation, first.generation + 1);
  const before = readFileSync(statePath(f.root));
  assert.throws(() => releaseTask(f.root, "export-report", first.token), (error) => error.code === "ETOKEN");
  assert.deepEqual(readFileSync(statePath(f.root)), before);
  const current = readClaim(f.root, "export-report");
  assert.equal(current.owner, "agent-b");
  assert.equal(current.endsAt, null);
  assert.deepEqual(current.history.map(({ owner, generation, contractDigest, disposition }) => ({ owner, generation, contractDigest, disposition })), [
    { owner: first.owner, generation: first.generation, contractDigest: first.contractDigest, disposition: "released" },
  ]);
  assertPrivate(current, first.token, second.token);
  assertPrivate(releaseTask(f.root, "export-report", second.token), first.token, second.token);
});

test("release of unknown task and malformed acquisition identities fail closed", (t) => {
  const f = fixture(t);
  assert.throws(() => releaseTask(f.root, "ghost", "t"), (error) => error.code === "ENOCLAIM");
  assert.throws(() => acquire(f, "../escape"));
  assert.throws(() => acquire(f, "export-report", ""));
  assert.throws(() => acquire(f, "export-report", "agent\nb"));
  assert.equal(existsSync(statePath(f.root)), false);
  assert.equal(readClaim(f.root, "ghost"), null);
});

test("different task IDs cannot own the same file but isolated workspaces can", (t) => {
  const f = fixture(t);
  const first = acquire(f);
  const before = readFileSync(statePath(f.root));
  assert.throws(() => acquire(f, "other-task", "agent-b"));
  assert.equal(existsSync(statePath(f.root, "other-task")), false);
  assert.deepEqual(readFileSync(statePath(f.root)), before);
  const other = fixture(t);
  assert.equal(acquire(other, "other-task", "agent-b").owner, "agent-b");
  writeFileSync(join(f.root, "distinct.json"), JSON.stringify({ ...f.contract, files: ["src/new-report.mjs"] }));
  assert.equal(claimTask(f.root, "distinct-task", "agent-c", "distinct.json").owner, "agent-c");
  releaseTask(f.root, "export-report", first.token);
  assert.equal(acquire(f, "other-task", "agent-b").owner, "agent-b");
});

test("context returns only pinned task requirements files checks and workspace identity", (t) => {
  const f = fixture(t);
  const claim = acquire(f);
  const result = packet(f);
  assert.deepEqual(result.contract, f.contract);
  assert.deepEqual(result.scope.files, f.contract.files);
  assert.deepEqual(result.verification, f.contract.checks);
  assert.equal(result.workspaceRoot, realpathSync(f.root));
  assert.equal(result.baseCommit, null);
  assert.equal(claim.contractDigest, digest(readFileSync(join(f.root, f.contractPath))));
  assert.equal(result.claim.generation, claim.generation);
  const text = JSON.stringify(result);
  assert.match(text, /export report/);
  assert.equal(text.includes("preserve format"), false);
  assertPrivate(result, claim.token);
});

test("context rejects absent ended mismatched and relocated task authority", (t) => {
  const f = fixture(t);
  assert.throws(() => contextPacket(f.root, { change: "demo" }));
  assert.throws(() => packet(f));
  const claim = acquire(f);
  assert.throws(() => contextPacket(f.root, { change: "other", task: "export-report" }));
  const moved = join(sandbox(t), "moved");
  renameSync(f.root, moved);
  assert.throws(() => readClaim(moved, "export-report"));
  assert.throws(() => contextPacket(moved, { change: "demo", task: "export-report" }));
  assert.throws(() => releaseTask(moved, "export-report", claim.token));
  renameSync(moved, f.root);
  releaseTask(f.root, "export-report", claim.token);
  assert.throws(() => packet(f));
});

test("context refuses contract or manifest rebinding without changing active authority", async (t) => {
  for (const target of ["contract", "manifest"]) {
    await t.test(target, (t) => {
      const f = fixture(t);
      const claim = acquire(f);
      const before = readFileSync(statePath(f.root));
      if (target === "contract") writeFileSync(join(f.root, f.contractPath), JSON.stringify({ ...f.contract, files: ["src/other.mjs"] }));
      else writeFileSync(join(f.base, "manifest.md"), "| R01 | changed obligation |\n");
      assert.throws(() => packet(f));
      assert.deepEqual(readFileSync(statePath(f.root)), before);
      assertPrivate(readClaim(f.root, "export-report"), claim.token);
      assert.ok(releaseTask(f.root, "export-report", claim.token).endsAt);
    });
  }
});

test("claim validates exact bounded contract before granting authority", async (t) => {
  const cases = [
    ["missing-contract", null], ["unknown-field", { extra: true }], ["wrong-schema", { schemaVersion: 2 }],
    ["bad-change", { change: "../demo" }], ["no-requirements", { requirements: [] }],
    ["unknown-requirement", { requirements: ["R99"] }], ["too-many-requirements", { requirements: Array(65).fill("R01") }],
    ["no-files", { files: [] }], ["too-many-files", { files: Array.from({ length: 65 }, (_, i) => `src/f${i}.mjs`) }],
    ["duplicate-files", { files: ["src/report.mjs", "src/report.mjs"] }], ["directory", { files: ["src"] }],
    ["glob", { files: ["src/*.mjs"] }], ["escaping-file", { files: ["../outside.mjs"] }],
    ["state-file", { files: [".workflow/state.json"] }], ["git-file", { files: [".git/config"] }],
    ["credential-file", { files: [".env"] }], ["long-file", { files: [`src/${"a".repeat(257)}.mjs`] }],
    ["no-checks", { checks: [] }], ["shell-string", { checks: ["node --test"] }], ["empty-argv", { checks: [[]] }],
    ["too-many-checks", { checks: Array(17).fill(["node", "--test"]) }], ["too-many-args", { checks: [Array(33).fill("node")] }],
    ["control-argument", { checks: [["node", "\n"]] }], ["oversize-utf8-argument", { checks: [["node", "é".repeat(513)]] }],
    ["nonstring-argument", { checks: [["node", 42]] }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, (t) => {
      const f = fixture(t, overrides ?? {});
      assert.throws(() => claimTask(f.root, "invalid", "agent-a", overrides === null ? undefined : f.contractPath));
      assert.equal(existsSync(statePath(f.root, "invalid")), false);
    });
  }
});

test("oversize contract manifest and claim bytes fail closed", async (t) => {
  for (const target of ["contract", "manifest", "claim"]) {
    await t.test(target, (t) => {
      const f = fixture(t);
      if (target === "contract") {
        writeFileSync(join(f.root, f.contractPath), JSON.stringify(f.contract) + " ".repeat(16 * 1024));
        assert.throws(() => acquire(f));
        assert.equal(existsSync(statePath(f.root)), false);
      } else if (target === "manifest") {
        writeFileSync(join(f.base, "manifest.md"), "| R01 | scope |\n" + "é".repeat(33 * 1024));
        assert.throws(() => acquire(f));
        assert.equal(existsSync(statePath(f.root)), false);
      } else {
        const claim = acquire(f);
        writeFileSync(statePath(f.root), readFileSync(statePath(f.root), "utf8") + " ".repeat(128 * 1024));
        const before = readFileSync(statePath(f.root));
        assert.throws(() => readClaim(f.root, "export-report"));
        assert.throws(() => packet(f));
        assert.throws(() => releaseTask(f.root, "export-report", claim.token));
        assert.throws(() => acquire(f, "other-task", "agent-b"));
        assert.deepEqual(readFileSync(statePath(f.root)), before);
      }
    });
  }
});

test("legacy malformed and unfinished claim state is held for operator reconciliation", async (t) => {
  for (const [name, body] of [
    ["legacy", JSON.stringify({ version: 1, task: "export-report", owner: "old", token: "old-token", startedAt: "2020-01-01T00:00:00.000Z", endsAt: null })],
    ["malformed", "{broken"], ["unfinished", ""],
  ]) {
    await t.test(name, (t) => {
      const f = fixture(t);
      mkdirSync(join(f.root, ".workflow", "claims"), { recursive: true });
      writeFileSync(statePath(f.root), body);
      assert.throws(() => readClaim(f.root, "export-report"));
      assert.throws(() => releaseTask(f.root, "export-report", "old-token"));
      assert.throws(() => acquire(f, "other-task", "agent-b"));
      assert.equal(readFileSync(statePath(f.root), "utf8"), body);
      assert.equal(existsSync(statePath(f.root, "other-task")), false);
    });
  }
});

test("history ceiling refuses another acquisition without discarding prior owners", (t) => {
  const f = fixture(t);
  for (let i = 0; i <= 64; i++) {
    const claim = acquire(f, "export-report", `agent-${i}`);
    releaseTask(f.root, "export-report", claim.token);
  }
  const before = readFileSync(statePath(f.root));
  assert.throws(() => acquire(f, "export-report", "overflow-owner"));
  assert.deepEqual(readFileSync(statePath(f.root)), before);
  assert.deepEqual(readClaim(f.root, "export-report").history.map((entry) => entry.owner),
    Array.from({ length: 64 }, (_, i) => `agent-${i}`));
});

test("state and context junctions cannot redirect authority outside the workspace", async (t) => {
  for (const target of ["root", "state-parent", "claims-directory", "claim-leaf", "contract-parent", "contract-leaf", "context-parent", "manifest-leaf", "owned-parent"]) {
    await t.test(target, (t) => {
      const f = fixture(t);
      const outside = sandbox(t);
      let selectedRoot = f.root, contractPath = f.contractPath, token = "unissued-token";
      if (target === "root") {
        selectedRoot = join(sandbox(t), "linked-root");
        if (!link(t, f.root, selectedRoot)) return;
      } else if (target === "state-parent") {
        if (!link(t, outside, join(f.root, ".workflow"))) return;
      } else if (target === "claims-directory") {
        mkdirSync(join(f.root, ".workflow"));
        if (!link(t, outside, join(f.root, ".workflow", "claims"))) return;
      } else if (target === "claim-leaf") {
        const claim = acquire(f);
        token = claim.token;
        renameSync(statePath(f.root), join(outside, "claim.json"));
        if (!link(t, join(outside, "claim.json"), statePath(f.root), false)) return;
      } else if (target === "contract-parent") {
        writeFileSync(join(outside, "contract.json"), JSON.stringify(f.contract));
        if (!link(t, outside, join(f.root, "contracts"))) return;
        contractPath = "contracts/contract.json";
      } else if (target === "contract-leaf") {
        renameSync(join(f.root, f.contractPath), join(outside, "contract.json"));
        if (!link(t, join(outside, "contract.json"), join(f.root, f.contractPath), false)) return;
      } else if (target === "context-parent") {
        renameSync(join(f.root, "openspec"), join(outside, "openspec"));
        if (!link(t, join(outside, "openspec"), join(f.root, "openspec"))) return;
      } else if (target === "manifest-leaf") {
        renameSync(join(f.base, "manifest.md"), join(outside, "manifest.md"));
        if (!link(t, join(outside, "manifest.md"), join(f.base, "manifest.md"), false)) return;
      } else {
        renameSync(join(f.root, "src"), join(outside, "src"));
        if (!link(t, join(outside, "src"), join(f.root, "src"))) return;
      }
      writeFileSync(join(outside, "sentinel"), "outside bytes must stay intact");
      const externalClaim = join(outside, "claim.json");
      const before = existsSync(externalClaim) ? readFileSync(externalClaim) : null;
      assert.throws(() => claimTask(selectedRoot, "export-report", "agent-b", contractPath));
      if (["root", "state-parent", "claims-directory", "claim-leaf"].includes(target)) {
        assert.throws(() => readClaim(selectedRoot, "export-report"));
        assert.throws(() => releaseTask(selectedRoot, "export-report", token));
        assert.throws(() => contextPacket(selectedRoot, { change: "demo", task: "export-report" }));
      }
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside bytes must stay intact");
      assert.equal(existsSync(join(outside, "claims")), false);
      assert.equal(existsSync(join(outside, "export-report.json")), false);
      if (before) assert.deepEqual(readFileSync(externalClaim), before);
    });
  }
});

test("claim records actual Git base without executing contract checks", (t) => {
  const f = fixture(t, { checks: [["node", "-e", "require('node:fs').writeFileSync('should-not-run','bad')"]] });
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("add", "src/report.mjs");
  git("-c", "user.name=Claim Fixture", "-c", "user.email=claim@example.invalid", "-c", `core.hooksPath=${resolve(f.root, "no-hooks")}`, "commit", "--quiet", "-m", "fixture");
  const expected = git("rev-parse", "HEAD");
  const claim = acquire(f);
  assert.equal(claim.baseCommit, expected);
  assert.equal(packet(f).baseCommit, expected);
  assert.equal(existsSync(join(f.root, "should-not-run")), false);
});
