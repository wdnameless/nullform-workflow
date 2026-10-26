/**
 * tools/tests/review-evidence.test.mjs
 * Comprehensive behavior and security boundary tests for review execution integrity (R02).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  runReviewRecord,
  recordStageB,
  validateReviewEvidence,
  loadReviewEvidence,
  EVIDENCE_FILE,
} from "../review/evidence.mjs";
import { nativeRunner, prepareEvidence } from "./fixtures/review-execution.mjs";

function setupMockProject(root, changeId = "feat-test") {
  const changeDir = join(root, "openspec", "changes", changeId);
  const agentDir = join(root, "agent", "agents");
  mkdirSync(join(changeDir, "specs"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "tools", "tests"), { recursive: true });

  writeFileSync(join(agentDir, "reviewer.md"), "# Reviewer Role\nCheck diff.\n", "utf8");
  writeFileSync(join(agentDir, "oracle.md"), "# Oracle Role\nAcceptance only.\n", "utf8");
  writeFileSync(join(changeDir, "manifest.md"), "| R01 | User quote |\n", "utf8");
  writeFileSync(join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
  writeFileSync(join(changeDir, "tasks.md"), "# Tasks\n- t1\n", "utf8");
  writeFileSync(join(changeDir, "specs", "spec.md"), "# Spec\n", "utf8");
  writeFileSync(join(changeDir, "oracle.md"), "# Oracle\nVerdict: ACCEPT\n", "utf8");
  writeFileSync(join(root, "tools", "tests", "sample.test.mjs"), "// test suite\n", "utf8");
  prepareEvidence(root, changeId);
  return { changeDir };
}

const makeMockOmpRunner = nativeRunner;

test("review-evidence: static ACCEPT markdown alone fails gate", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-static-"));
  try {
    setupMockProject(root, "static-only");
    const res = validateReviewEvidence({ root, changeId: "static-only", tier: "T2" });
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /missing review execution evidence/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: review-run rejects zero token usage", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-zerousage-"));
  try {
    setupMockProject(root, "feat-zero");
    const zeroRunner = makeMockOmpRunner("sess-zero", { input: 0, output: 0 });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-zero", role: "reviewer", ompRunner: zeroRunner }),
      /zero.*token usage/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: review-run rejects failed process exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-failcode-"));
  try {
    setupMockProject(root, "feat-fail");
    const failRunner = () => ({ status: 1, stderr: "Process crashed" });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-fail", role: "reviewer", ompRunner: failRunner }),
      /runner exited with code 1/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: reviewer + stage-b + oracle end-to-end recording", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-e2e-"));
  try {
    setupMockProject(root, "feat-e2e");
    const revRunner = makeMockOmpRunner("sess-rev-1", { input: 200, output: 80 }, "correct");
    const oraRunner = makeMockOmpRunner("sess-ora-1", { input: 300, output: 90 }, "correct", { text: "ACCEPT: all requirements verified." });

    const revRes = runReviewRecord({ root, changeId: "feat-e2e", role: "reviewer", ompRunner: revRunner });
    assert.equal(revRes.ok, true);
    assert.equal(revRes.record.verdict, "ACCEPT");
    assert.equal(revRes.record.nativeVerdict, "correct");

    const stageBRes = recordStageB({
      root,
      changeId: "feat-e2e",
      disposition: "lean-already",
      testCmd: `"${process.execPath}" tests/product.test.cjs "openspec/changes/feat-e2e/manifest.md"`,
      summary: "Lean already.",
    });
    assert.equal(stageBRes.ok, true);
    assert.equal(stageBRes.stageB.disposition, "lean-already");

    const oraRes = runReviewRecord({ root, changeId: "feat-e2e", role: "oracle", ompRunner: oraRunner });
    assert.equal(oraRes.ok, true);
    assert.equal(oraRes.record.verdict, "ACCEPT");

    const val = validateReviewEvidence({ root, changeId: "feat-e2e", tier: "T2" });
    assert.equal(val.ok, true, `Validation failed: ${val.errors.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: rejects duplicate session IDs across oracles", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-dup-"));
  try {
    setupMockProject(root, "feat-dup");
    const runner = makeMockOmpRunner("duplicate-session-id", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-dup", role: "reviewer", ompRunner: runner });
    recordStageB({
      root,
      changeId: "feat-dup",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });
    // First oracle with same session ID as reviewer must fail
    assert.throws(() => runReviewRecord({ root, changeId: "feat-dup", role: "oracle", ompRunner: runner }), /duplicate session ID/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stage-b fails if test files were mutated", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stagemut-"));
  try {
    setupMockProject(root, "feat-mut");
    const revRunner = makeMockOmpRunner("sess-rev-m", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-mut", role: "reviewer", ompRunner: revRunner });

    // Test runner that mutates a test file during execution
    const mutatingTestRunner = () => {
      writeFileSync(join(root, "tools", "tests", "sample.test.mjs"), "// mutated tests\n", "utf8");
      return { status: 0, stdout: "ok" };
    };

    assert.throws(
      () =>
        recordStageB({
          root,
          changeId: "feat-mut",
          disposition: "lean-already",
          testCmd: "dummy",
          testRunner: mutatingTestRunner,
        }),
      /frozen test files were modified/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: flash oracle requires 2 distinct sessions when exceeding Oracle-lite", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-flash-"));
  try {
    setupMockProject(root, "feat-flash");
    const revRunner = makeMockOmpRunner("sess-rev-f", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-flash", role: "reviewer", ompRunner: revRunner });
    recordStageB({
      root,
      changeId: "feat-flash",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });

    // 1 flash oracle
    const flashRunner1 = makeMockOmpRunner("sess-ora-f1", { input: 100, output: 50 }, "correct", {
      provider: "google", model: "gemini-3.8-flash",
      text: "ACCEPT: verified.",
    });
    runReviewRecord({ root, changeId: "feat-flash", role: "oracle", ompRunner: flashRunner1 });

    // Simulate exceeding Oracle-lite (e.g. 5 changed files)
    const valSingle = validateReviewEvidence({ root, changeId: "feat-flash", tier: "T2" });
    assert.equal(valSingle.ok, false);
    assert.match(valSingle.errors[0], /requires at least 2 distinct independent sessions/i);
    // When a 2nd distinct flash oracle session is recorded:
    const flashRunner2 = makeMockOmpRunner("sess-ora-f2", { input: 110, output: 55 }, "correct", {
      provider: "google", model: "gemini-3.8-flash",
      text: "ACCEPT: double check verified.",
    });
    runReviewRecord({ root, changeId: "feat-flash", role: "oracle", ompRunner: flashRunner2 });
    const valDouble = validateReviewEvidence({ root, changeId: "feat-flash", tier: "T2" });
    assert.equal(valDouble.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stale manifest hash is detected and rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-staleman-"));
  try {
    setupMockProject(root, "feat-stale");
    const revRunner = makeMockOmpRunner("sess-rev-s", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-stale", role: "reviewer", ompRunner: revRunner });
    recordStageB({
      root,
      changeId: "feat-stale",
      disposition: "lean-already",
      testCmd: "dummy",
      testRunner: () => ({ status: 0, stdout: "ok" }),
    });
    const oraRunner = makeMockOmpRunner("sess-ora-s", { input: 100, output: 50 }, "correct", { text: "ACCEPT" });
    runReviewRecord({ root, changeId: "feat-stale", role: "oracle", ompRunner: oraRunner });

    // Mutate manifest.md
    writeFileSync(join(root, "openspec", "changes", "feat-stale", "manifest.md"), "| R01 | altered |\n", "utf8");

    const val = validateReviewEvidence({ root, changeId: "feat-stale", tier: "T2" });
    assert.equal(val.ok, false);
    assert.match(val.errors.join("; "), /manifest hash mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("review-evidence: user prompt, tool echo, and thinking containing ACCEPT never pass verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-fake-accept-"));
  try {
    setupMockProject(root, "feat-fake");
    const fakeRunner = nativeRunner("sess-fake", { input: 100, output: 50 }, "incorrect", {
      content: [{ type: "thinking", text: "ACCEPT echo" }, { type: "text", text: JSON.stringify({ findings: [{ title: "Broken invariant", body: "R01 fails on the fixture consumer.", priority: 1, confidence: 0.9, file_path: "tools/tests/sample.test.mjs", line_start: 1, line_end: 1 }], overall_correctness: "incorrect", overall_explanation: "Not accepted", overall_confidence_score: 0.9 }) }],
    });

    const res = runReviewRecord({ root, changeId: "feat-fake", role: "reviewer", ompRunner: fakeRunner });
    assert.equal(res.record.verdict, "REJECT");
    assert.notEqual(res.record.verdict, "ACCEPT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: assistant error/aborted/length stop is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stop-"));
  try {
    setupMockProject(root, "feat-stop");
    for (const stopReason of ["error", "aborted", "length"]) {
      const runner = nativeRunner(`sess-stop-${stopReason}`, { input: 50, output: 50 }, "correct", { stopReason });
      assert.throws(
        () => runReviewRecord({ root, changeId: "feat-stop", role: "reviewer", ompRunner: runner }),
        new RegExp(`abnormal stop reason '${stopReason}'`, "i")
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: effective model mismatch is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-mismatch-"));
  try {
    setupMockProject(root, "feat-mismatch");
    const runner = makeMockOmpRunner("sess-mismatch", { input: 100, output: 50 }, "correct", {
      model: "cheap-fallback-model",
    });
    assert.throws(
      () =>
        runReviewRecord({
          root,
          changeId: "feat-mismatch",
          role: "reviewer",
          model: "anthropic/claude-3-5-sonnet",
          ompRunner: runner,
        }),
      /effective model mismatch/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: empty or missing final report is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-empty-"));
  try {
    setupMockProject(root, "feat-empty");
    const emptyRunner = nativeRunner("sess-empty", { input: 50, output: 50 }, "correct", { content: [{ type: "thinking", text: "only thinking" }] });
    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-empty", role: "reviewer", ompRunner: emptyRunner }),
      /empty\/final report missing/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-evidence: stale earlier reviewer rejects appending new oracle", () => {
  const root = mkdtempSync(join(tmpdir(), "rev-ev-stale-rev-"));
  try {
    setupMockProject(root, "feat-stale-rev");
    const runner = makeMockOmpRunner("sess-stale-rev", { input: 100, output: 50 }, "correct");
    runReviewRecord({ root, changeId: "feat-stale-rev", role: "reviewer", ompRunner: runner });

    // Modify a source file in repo after reviewer ran
    writeFileSync(join(root, "tracked_source.txt"), "new source modification\n", "utf8");

    assert.throws(
      () => runReviewRecord({ root, changeId: "feat-stale-rev", role: "oracle", ompRunner: runner }),
      /earlier reviewer record is stale/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Synthetic transcripts exercise evidence/recovery, never prove provider execution.
// The public CLI sentinel cannot load a provider or make a network request.
function admissionFixture() {
  const root = mkdtempSync(join(tmpdir(), "review-admission-"));
  const changeId = "admission", { changeDir } = setupMockProject(root, changeId);
  const scratch = join(root, ".tmp"), marker = join(scratch, "children");
  mkdirSync(scratch);
  writeFileSync(join(root, "product.cjs"), "module.exports = 42;\n");
  const cli = join(scratch, "sentinel.cjs");
  writeFileSync(cli, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "child\\n"); process.exit(77);\n`);
  writeFileSync(join(root, ".gitignore"), ".tmp/\n");
  copyFileSync(process.execPath, join(scratch, process.platform === "win32" ? "bun.exe" : "bun"));
  const env = { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH || ""}`, OMP_CLI_PATH: cli,
    HOME: scratch, USERPROFILE: scratch, NULLFORM_USER_HOME: scratch,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture baseline");
  const baseRef = git("rev-parse", "HEAD");
  const command = fileURLToPath(new URL("../../bin/nullform.mjs", import.meta.url));
  const invoke = (model = "openai-codex/gpt-6.1-sol", args = []) => spawnSync(process.execPath,
    [command, "workflow", "review-run", "--root", root, "--harness", "omp", "--change", changeId,
      "--role", "reviewer", "--model", model, "--base-ref", baseRef, ...args],
    { cwd: root, env, encoding: "utf8", timeout: 15000 });
  const policy = (provider, model, endpoint) => {
    const path = ".tmp/admission.json";
    writeFileSync(join(root, path), JSON.stringify({ schemaVersion: 1, provider, model, transport: "omp-native",
      endpoint, ceilingUsd: 0.1, maxRequests: 1, maxContextBytes: 16384, maxInputTokens: 4096,
      maxOutputTokens: 512, tariffsUsdPerMillion: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    return ["--admission-policy", path];
  };
  return { root, changeDir, marker, invoke, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function assertNoDispatch(f, result, reason) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(f.marker), false, "Admission refusal must precede even a harmless native child");
  assert.equal(existsSync(join(f.changeDir, EVIDENCE_FILE)), false, "Refusal cannot publish a receipt");
  assert.match(`${result.stdout}\n${result.stderr}`, reason);
}

test("review admission: public CLI refuses missing spending authority before child dispatch", () => {
  const f = admissionFixture();
  try { assertNoDispatch(f, f.invoke(), /admission|policy|authority/i); }
  finally { f.cleanup(); }
});

test("review admission: public CLI refuses OpenRouter even with an explicit policy", () => {
  const f = admissionFixture();
  try {
    const args = f.policy("openrouter", "gpt-6.1-sol", "https://openrouter.ai/api/v1");
    assertNoDispatch(f, f.invoke("openrouter/gpt-6.1-sol", args), /OpenRouter|forbidden provider|disallowed provider/i);
  } finally { f.cleanup(); }
});

test("review admission: a direct provider label cannot authorize an opaque endpoint", () => {
  const f = admissionFixture();
  try {
    const args = f.policy("openai-codex", "gpt-6.1-sol", "https://opaque.example.invalid/v1");
    assertNoDispatch(f, f.invoke(undefined, args), /route|endpoint|gateway|unsupported.*boundary/i);
  } finally { f.cleanup(); }
});

test("review admission: unenforceable native Codex and SDK modes refuse before dispatch", async t => {
  const f = admissionFixture();
  try {
    for (const [provider, model, endpoint] of [
      ["openai-codex", "gpt-6.1-sol", "https://chatgpt.com/backend-api/codex/responses"],
      ["anthropic", "claude-3-5-sonnet", "https://api.anthropic.com/v1/messages"],
      ["google", "gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta"],
    ]) await t.test(provider, () => {
      const args = f.policy(provider, model, endpoint);
      assertNoDispatch(f, f.invoke(`${provider}/${model}`, args), /unsupported.*boundary|boundary.*unsupported|cannot enforce/i);
    });
  } finally { f.cleanup(); }
});

test("review admission: dry-run with an invalid policy fails closed without dispatch", () => {
  const f = admissionFixture();
  try {
    const args = f.policy("openai-codex", "gpt-6.1-sol", "https://chatgpt.com/backend-api/codex/responses");
    const result = f.invoke(undefined, [...args, "--dry-run"]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(f.marker), false);
    assert.equal(existsSync(join(f.changeDir, EVIDENCE_FILE)), false);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsupported.*boundary|boundary.*unsupported|cannot enforce|not the verified direct provider/i);
  } finally { f.cleanup(); }
});

test("review evidence: known zero tariff preserves nonzero native tokens and provenance gates", () => {
  const root = mkdtempSync(join(tmpdir(), "review-zero-tariff-"));
  try {
    const changeId = "zero-tariff", { changeDir } = setupMockProject(root, changeId);
    const runner = nativeRunner("zero-tariff-review", { input: 20, output: 10 }, "correct", { costUsd: 0 });
    const result = runReviewRecord({ root, changeId, role: "reviewer", ompRunner: runner });
    assert.equal(result.record.usage.costUsd, 0);
    assert.equal(result.record.usage.totalTokens, 30);
    recordStageB({ root, changeId, disposition: "lean-already",
      testCmd: `"${process.execPath}" tests/product.test.cjs "openspec/changes/${changeId}/manifest.md"` });
    runReviewRecord({ root, changeId, role: "oracle",
      ompRunner: nativeRunner("zero-tariff-oracle", { input: 30, output: 10 }, "correct", { costUsd: 0 }) });
    assert.deepEqual(validateReviewEvidence({ root, changeId, tier: "T2" }), { ok: true, errors: [] });
    const data = loadReviewEvidence(changeDir);
    data.oracles[0].nativeEvents.find(e => e.customType === "workflow-review-context").data.sourceDigest = "tampered";
    writeFileSync(join(changeDir, EVIDENCE_FILE), JSON.stringify(data));
    assert.equal(validateReviewEvidence({ root, changeId, tier: "T2" }).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function retainedFixture(extra = {}, verdict = "correct") {
  const root = mkdtempSync(join(tmpdir(), "review-recovery-")), changeId = "recovery";
  const { changeDir } = setupMockProject(root, changeId);
  const scratch = join(root, ".tmp"), marker = join(scratch, "children");
  mkdirSync(scratch);
  writeFileSync(join(root, "product.cjs"), "module.exports = 42;\n");
  const options = { root, changeId, role: "reviewer", model: "openai-codex/gpt-6.1-sol",
    productCommand: [process.execPath, "product.cjs"] };
  let sessionDir, transcriptPath, transcript;
  // Existing parser-fixture seam plus a real harmless child; not a production transport.
  const ompRunner = args => {
    sessionDir = args.sessionDir;
    transcriptPath = join(sessionDir, "native.jsonl");
    const native = nativeRunner("retained-session", { input: 20, output: 10 }, verdict,
      { provider: "openai-codex", model: "gpt-6.1-sol", ...extra })(args);
    transcript = native.stdout;
    const script = 'const fs=require("node:fs");const text=fs.readFileSync(0,"utf8");'
      + 'fs.appendFileSync(process.argv[2],"child\\n");fs.writeFileSync(process.argv[1],text);process.stdout.write(text);';
    const child = spawnSync(process.execPath, ["-e", script, transcriptPath, marker],
      { input: transcript, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    mkdirSync(join(changeDir, EVIDENCE_FILE), { recursive: true });
    return { status: native.status, stdout: child.stdout };
  };
  const calls = () => readFileSync(marker, "utf8").trim().split("\n").length;
  const resume = overrides => runReviewRecord({ ...options, ompRunner, resumeSessionDir: sessionDir, ...overrides });
  return { root, changeDir, options, ompRunner, calls, resume,
    get sessionDir() { return sessionDir; }, get transcriptPath() { return transcriptPath; },
    get transcript() { return transcript; },
    unblock: () => rmSync(join(changeDir, EVIDENCE_FILE), { recursive: true, force: true }),
    cleanup: () => { if (sessionDir) rmSync(sessionDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); } };
}

function failPublication(f) {
  assert.throws(() => runReviewRecord({ ...f.options, ompRunner: f.ompRunner }),
    /EISDIR|EPERM|EACCES|EEXIST|ENOTEMPTY|directory|publish/i);
  assert.equal(f.calls(), 1);
  assert.equal(existsSync(f.transcriptPath), true, "Completed native transcript must survive publication failure");
  assert.equal(readFileSync(f.transcriptPath, "utf8"), f.transcript);
  f.unblock();
}

test("review recovery: publication resume imports exact completed session once without a second child", () => {
  const f = retainedFixture();
  try {
    failPublication(f);
    const resumed = f.resume();
    assert.equal(resumed.ok, true);
    assert.equal(f.calls(), 1);
    assert.equal(resumed.record.sessionId, "retained-session");
    const context = JSON.parse(f.transcript.split("\n").find(line => JSON.parse(line).customType === "workflow-review-context")).data;
    assert.deepEqual(resumed.record.context, context);
    assert.equal(resumed.record.requestedModel, f.options.model);
    const events = f.transcript.split("\n").map(JSON.parse);
    assert.equal(resumed.record.startedAt, events[0].timestamp);
    assert.equal(resumed.record.completedAt, events.at(-1).timestamp);
    assert.equal(resumed.record.report, events.at(-1).message.content[0].text);
    const published = readFileSync(join(f.changeDir, EVIDENCE_FILE), "utf8");
    assert.throws(() => f.resume(), /duplicate|already.*publish|already.*import/i);
    assert.equal(f.calls(), 1);
    assert.equal(readFileSync(join(f.changeDir, EVIDENCE_FILE), "utf8"), published);
  } finally { f.cleanup(); }
});

test("review recovery: stale source tests manifest role model and command refuse without dispatch", async t => {
  for (const kind of ["source", "tests", "manifest", "role", "model", "command"]) await t.test(kind, () => {
    const f = retainedFixture();
    try {
      failPublication(f);
      let overrides;
      if (kind === "source") writeFileSync(join(f.root, "product.cjs"), "module.exports = 43;\n");
      if (kind === "tests") writeFileSync(join(f.root, "tools", "tests", "sample.test.mjs"), "// changed frozen tests\n");
      if (kind === "manifest") writeFileSync(join(f.changeDir, "manifest.md"), "| R01 | Changed requirement |\n");
      if (kind === "role") writeFileSync(join(f.root, "agent", "agents", "reviewer.md"), "# Changed reviewer\n");
      if (kind === "model") overrides = { model: "anthropic/claude-3-5-sonnet" };
      if (kind === "command") overrides = { productCommand: [process.execPath, "-e", "console.log(43)"] };
      assert.throws(() => f.resume(overrides), /stale|mismatch|changed|identity|context|contract/i);
      assert.equal(f.calls(), 1);
      assert.equal(existsSync(join(f.changeDir, EVIDENCE_FILE)), false);
      assert.equal(readFileSync(f.transcriptPath, "utf8"), f.transcript);
    } finally { f.cleanup(); }
  });
});

test("review recovery: tampered retained transcript cannot be republished", () => {
  const f = retainedFixture();
  try {
    failPublication(f);
    const entries = f.transcript.split("\n").map(JSON.parse);
    const message = entries.find(e => e.type === "message").message;
    const report = JSON.parse(message.content[0].text);
    report.overall_explanation = "Altered completed evidence";
    message.content[0].text = JSON.stringify(report);
    const tampered = entries.map(e => JSON.stringify(e)).join("\n");
    writeFileSync(f.transcriptPath, tampered);
    assert.throws(() => f.resume(), /tamper|hash|integrity|token|mismatch/i);
    assert.equal(f.calls(), 1);
    assert.equal(existsSync(join(f.changeDir, EVIDENCE_FILE)), false);
    assert.equal(readFileSync(f.transcriptPath, "utf8"), tampered);
  } finally { f.cleanup(); }
});

test("review recovery: resumed adverse evidence stays REJECT and is not a fresh ACCEPT", () => {
  const f = retainedFixture({}, "incorrect");
  try {
    failPublication(f);
    const resumed = f.resume();
    assert.equal(resumed.record.sessionId, "retained-session");
    assert.equal(resumed.record.verdict, "REJECT");
    assert.equal(resumed.record.nativeVerdict, "incorrect");
    assert.equal(loadReviewEvidence(f.changeDir).reviewer.verdict, "REJECT");
    assert.equal(validateReviewEvidence({ root: f.root, changeId: "recovery", tier: "T2" }).ok, false);
    assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});

test("review recovery: failed and incomplete native sessions cannot be resumed as receipts", async t => {
  for (const extra of [{ status: 1 }, { stopReason: "toolUse" }]) await t.test(JSON.stringify(extra), () => {
    const f = retainedFixture(extra);
    try {
      assert.throws(() => runReviewRecord({ ...f.options, ompRunner: f.ompRunner }), /exited|stop reason/i);
      f.unblock();
      assert.throws(() => f.resume(), /failed|incomplete|running|stop reason|completion|exited/i);
      assert.equal(f.calls(), 1);
      assert.equal(existsSync(join(f.changeDir, EVIDENCE_FILE)), false);
    } finally { f.cleanup(); }
  });
});
