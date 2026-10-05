import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MODEL, CAPS, REQUEST_RESERVE_USD, createRequestBudget, computeTariffCost, validateNativeMessage, loadSpendLedger, saveSpendLedger, assertBudgetReady } from "../bench-budget.mjs";
import { readSession, scoreReview, verifyFrozenTests } from "../bench-results.mjs";
import { parseArgs, runSkillBenefitEval } from "../run-skill-benefit-eval.mjs";

// Fabricated native messages below are deterministic boundary seams, never paid-run evidence.
const usage = (input = 1000, output = 100, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: input * .75 / 1e6, output: output * 3.75 / 1e6, cacheRead: cacheRead * .075 / 1e6, cacheWrite: 0, total: (input * .75 + output * 3.75 + cacheRead * .075) / 1e6 } });
const message = (text = "final", reason = "stop") => ({ role: "assistant", provider: "nullform-gateway", model: "gemini-3.8-flash-high", timestamp: Date.now(), stopReason: reason, content: [{ type: "text", text }], usage: usage() });
const temp = () => mkdtempSync(join(tmpdir(), "skill-benefit-"));
const payload = overrides => ({ method: "POST", body: JSON.stringify({ model: "gemini-wire", max_tokens: CAPS.outputTokens, messages: [{ role: "user", content: "test" }], ...overrides }) });
const makeGuard = (root, fetchImpl, options = {}) => createRequestBudget({ root, selector: DEFAULT_MODEL, endpoint: "https://fixture.invalid/v1/chat/completions", wireModel: "gemini-wire", runId: "unit-seam", fetchImpl, ...options });
const endpoint = "https://fixture.invalid/v1/chat/completions";

function transcript(dir, messages, completed = true) {
  mkdirSync(dir, { recursive: true });
  const rows = [{ type: "session_start", sessionId: "unit-native", selector: DEFAULT_MODEL, timestamp: 1 }, ...messages.map(message => ({ type: "message", message })), { type: "session_end", sessionId: "unit-native", completed, timestamp: Date.now() }];
  writeFileSync(join(dir, "session.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}

test("fixed catalog tariff preserves legitimate zero cache and cached-only input", () => {
  assert.equal(computeTariffCost(usage(10000,2000,5000), DEFAULT_MODEL).tariff_usd, .015375);
  assert.equal(validateNativeMessage({ ...message(), usage: usage(0,100,1000) }, DEFAULT_MODEL).tariff_usd, .00045);
  assert.equal(computeTariffCost(usage(), DEFAULT_MODEL).tariff_usd, .001125);
});

test("cost boundary rejects absent/string/unsafe/negative counters, unknown models and ancillary billing", () => {
  for (const value of [undefined, "5", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => computeTariffCost({ ...usage(), input: value }, DEFAULT_MODEL), /Invalid native/);
  assert.throws(() => computeTariffCost(usage(), "ollama/unknown"), /Unknown/);
  assert.throws(() => computeTariffCost({ ...usage(), cacheWrite: 1 }, DEFAULT_MODEL), /Unsupported/);
  assert.throws(() => computeTariffCost({ ...usage(), server: { webSearch: 1 } }, DEFAULT_MODEL), /Unsupported/);
});

test("native identity is exact on every turn and SDK cost is finite/consistent", () => {
  for (const patch of [{ model: "gemini-3.7-flash-high" }, { provider: undefined }, { timestamp: "1" }, { stopReason: undefined }, { usage: { ...usage(), totalTokens: "1100" } }, { usage: { ...usage(), cost: { total: Infinity } } }, { usage: { ...usage(), cost: { total: 0 } } }, { usage: { ...usage(), cost: { ...usage().cost, input: "0.00075" } } }]) assert.throws(() => validateNativeMessage({ ...message(), ...patch }, DEFAULT_MODEL));
});

test("durable reserve exists before physical dispatch and actual native usage settles it", async () => {
  const root = temp();
  try {
    let calls = 0;
    const guard = makeGuard(root, async () => {
      calls++;
      const row = loadSpendLedger(root).requests[0];
      assert.equal(row.status, "reserved"); assert.equal(row.reserve_usd, REQUEST_RESERVE_USD);
      assert.throws(() => assertBudgetReady(loadSpendLedger(root)), /blocked/);
      return new Response("stream");
    });
    guard.begin(); await guard.fetch(endpoint, payload());
    assert.equal(calls,1); guard.settle(message());
    const ledger = loadSpendLedger(root);
    assert.equal(ledger.requests[0].status, "settled"); assert.equal(ledger.cumulative_tariff_usd, .001125);
    assertBudgetReady(ledger);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hidden physical retry and side calls cannot spend outside reservation", async () => {
  const root = temp();
  try {
    let calls = 0; const guard = makeGuard(root, async () => { calls++; return new Response(); });
    await assert.rejects(guard.fetch(endpoint, payload()), /Unreserved/);
    guard.begin(); await guard.fetch(endpoint, payload());
    await assert.rejects(guard.fetch(endpoint, payload()), /retry/);
    guard.fail();
    assert.equal(calls,1);
    assert.equal(loadSpendLedger(root).status,"blocked_unknown_spend");
    assert.throws(() => makeGuard(root, async () => {}).begin(), /blocked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("crash reservation survives restart and cannot be washed by another run", async () => {
  const root = temp();
  try {
    const first = makeGuard(root, async () => new Response()); first.begin(); await first.fetch(endpoint, payload());
    assert.throws(() => makeGuard(root, async () => new Response()).begin(), /blocked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wire payload context/output/model/path boundaries stop before any HTTP", async () => {
  const root = temp();
  try {
    let calls = 0;
    for (const [url, body] of [[endpoint,payload({ max_tokens: undefined })], [endpoint,payload({ max_tokens: "4096" })], [endpoint,payload({ max_tokens: 4097 })], [endpoint,payload({ n:2 })], [endpoint,payload({ model:"other" })], [endpoint,payload({ tools:[{ type:"web_search" }] })], ["https://other.invalid/v1/chat/completions",payload()], [endpoint,payload({ messages: [{ content:"x".repeat(CAPS.contextBytes) }] })]]) {
      const guard = makeGuard(root, async () => { calls++; return new Response(); }); guard.begin();
      await assert.rejects(guard.fetch(url,body)); guard.fail();
    }
    assert.equal(calls,0); assert.equal(loadSpendLedger(root).requests.length,0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("numeric ceiling and native request count are hard boundaries", async () => {
  const root = temp();
  try {
    let calls = 0;
    const tiny = makeGuard(root, async () => { calls++; return new Response(); }, { ceiling: .001 }); tiny.begin();
    await assert.rejects(tiny.fetch(endpoint,payload()), /ceiling/); assert.equal(calls,0);
    const guard = makeGuard(root, async () => { calls++; return new Response(); }); guard.begin(); await guard.fetch(endpoint,payload()); guard.settle(message());
    assert.throws(() => guard.begin(), /count cap/);
    for (const ceiling of ["1",NaN,Infinity,0,1.01]) assert.throws(() => makeGuard(root, async () => {}, { ceiling }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid native result leaves unknown spend reserved rather than reporting zero", async () => {
  const root = temp();
  try {
    const guard = makeGuard(root, async () => new Response()); guard.begin(); await guard.fetch(endpoint,payload());
    assert.throws(() => guard.settle({ ...message(), usage: usage(0,0,0) }), /zero/); guard.fail();
    const ledger = loadSpendLedger(root); assert.equal(ledger.status,"blocked_unknown_spend"); assert.equal(ledger.requests[0].status,"reserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy/malformed accounting and budget laundering fail closed", () => {
  const root = temp();
  try {
    saveSpendLedger(root,{ version:1, cumulative_tariff_usd:0, runs:[] }); assert.throws(() => loadSpendLedger(root), /legacy/);
    saveSpendLedger(root,{ version:2, ceiling_usd:1, cumulative_tariff_usd:.2, status:"ok", requests:[] }); assert.throws(() => loadSpendLedger(root), /Inconsistent/);
    for (const ceiling of [NaN,Infinity,2,"1"]) assert.throws(() => runSkillBenefitEval({ root, ceiling, dryRun:true }), /numeric ceiling/);
    assert.throws(() => parseArgs(["--invented-cap", "1"]), /Unknown/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal assistant scoring never uses intermediate text or malformed/missing completion", () => {
  const root = temp();
  try {
    transcript(root,[message("INTERMEDIATE findings", "toolUse"),message("FINAL")]);
    assert.equal(readSession(root).finalText,"FINAL");
    transcript(root,[message("EARLIER"),message("", "length")]); assert.throws(() => readSession(root), /normally/);
    transcript(root,[message("FINAL")],false); assert.throws(() => readSession(root), /completion/);
    writeFileSync(join(root,"session.jsonl"),"broken-json\n"); assert.throws(() => readSession(root));
    transcript(root,[message("FINAL")]); writeFileSync(join(root,"other.jsonl"),""); assert.throws(() => readSession(root), /exactly one/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native toolCall discriminator and every-turn model attribution are retained", () => {
  const root = temp();
  try {
    const tool = { ...message("working", "toolUse"), content: [{ type:"toolCall", id:"x", name:"write", arguments:{ path:"src/calc.mjs", content:"real code" } }] };
    transcript(root,[tool,message("DONE")]); assert.equal(readSession(root).toolCalls[0].name,"write");
    transcript(root,[{ ...tool, provider:"other" },message("DONE")]); assert.throws(() => readSession(root), /mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("behavior scoring measures actual finding scopes, misses and extra false positives", () => {
  const report = { mode:"implementation-review", verdict:"incorrect", findings:[{ file_path:"src/router.ts", title:"Handle new command", body:"ExportReport is unhandled and falls through with undefined result" }, { file_path:"src/utils.ts", title:"Use native cloning", body:"shallowOrDeepCopy loses Dates through JSON; use structuredClone" }] };
  const good = scoreReview(JSON.stringify(report),"defect"); assert.equal(good.missedDefects,0); assert.equal(good.falsePositives,0); assert.equal(good.requirementsSatisfied,true);
  const missing = scoreReview(JSON.stringify({ ...report, findings:report.findings.slice(1) }),"defect"); assert.equal(missing.missedDefects,1); assert.equal(missing.requirementsSatisfied,false);
  const extra = scoreReview(JSON.stringify({ ...report, findings:[...report.findings,{ file_path:"src/commands.ts",title:"Invalid declaration",body:"Syntax error" }] }),"defect"); assert.equal(extra.falsePositives,1); assert.equal(extra.requirementsSatisfied,false);
  assert.throws(() => scoreReview("findings router ExportReport structuredClone", "defect"));
});

test("near-negative measures correct nonactivation rather than declaring forced skill loading absent", () => {
  const report = { mode:"blind-acceptance", verdict:"ACCEPT", requirements:{ R01:"proven", R02:"proven" }, findings:[] };
  assert.equal(scoreReview(JSON.stringify(report),"negative").requirementsSatisfied,true);
  assert.equal(scoreReview(JSON.stringify({ ...report, mode:"implementation-review" }),"negative").falsePositives,1);
  assert.throws(() => scoreReview(JSON.stringify({ ...report, requirements:{} }),"negative"), /requirement/);
});

test("test-byte digest stays frozen despite editable digest file or commit-shaped metadata", () => {
  const root = temp();
  try {
    mkdirSync(join(root,"tests")); const path = join(root,"tests","calc.test.mjs"); const original = "assert.equal(multiply(3,4),12)\n"; writeFileSync(path,original);
    const snapshot = { file:"tests/calc.test.mjs",sha256:createHash("sha256").update(original).digest("hex") };
    assert.equal(verifyFrozenTests(root,snapshot),true);
    writeFileSync(path,"// weakened tests\n"); writeFileSync(join(root,"tests",".baseline-digest.json"),JSON.stringify({ sha256:createHash("sha256").update(readFileSync(path)).digest("hex"),commit:"laundered" }));
    assert.equal(verifyFrozenTests(root,snapshot),false);
    assert.throws(() => verifyFrozenTests(root,{ file:"../outside", sha256:snapshot.sha256 }));
  } finally { rmSync(root, { recursive:true,force:true }); }
});

test("installed tools-only tree imports evaluation without repository bench files", () => {
  const root = temp();
  try {
    const tools = join(root, "tools");
    mkdirSync(tools);
    for (const file of ["benchmark.mjs", "bench-budget.mjs", "bench-results.mjs", "run-skill-benefit-eval.mjs"]) {
      cpSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(tools, file));
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(tools, "run-skill-benefit-eval.mjs")).href)})`], { cwd: root, encoding: "utf8", shell: false, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
