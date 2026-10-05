import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../bench-session-runner.ts";
import { DEFAULT_MODEL, loadSpendLedger } from "../bench-budget.mjs";
import { readSession } from "../bench-results.mjs";

// Real installed SDK and native read/write loop; only its HTTP response is fabricated.
// All real network remains denied, including routes that ignore the injected transport.
test("native workflow reaches guarded transport, executes a write and records final completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-native-offline-"));
  const runDir = join(root, "run"), repo = join(runDir, "repo");
  const priorArgv = process.argv, priorFetch = globalThis.fetch;
  let calls = 0, escapedCalls = 0;
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a,b) => a+b; export function multiply() { throw new Error('unimplemented'); }\n");
    writeFileSync(join(repo, "tests", "calc.test.mjs"), "// Frozen fixture input for the transport seam\n");
    const prompt = join(root, "prompt.txt");
    writeFileSync(prompt, "Implement multiply in src/calc.mjs with the native write tool, then return the completion contract.\n");
    process.argv = [process.argv[0], "bench-session-runner.ts", "--root", root, "--task", "eval-workflow-execution-outcome", "--arm", "baseline-noskill", "--prompt-file", prompt, "--run-dir", runDir, "--model", DEFAULT_MODEL];
    globalThis.fetch = async () => { escapedCalls++; throw new Error("Offline test forbids real network"); };
    const fetchImpl = async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      calls++;
      const ledger = loadSpendLedger(root);
      assert.equal(ledger.requests.at(-1).status, "reserved");
      assert.equal(ledger.requests.length, calls);
      assert.equal(typeof init.body, "string");
      const body = JSON.parse(init.body as string);
      assert.equal(body.max_tokens ?? body.max_completion_tokens, 4096);
      const write = { i: "Implementing multiplication", path: "src/calc.mjs", content: "export const add = (a,b) => a+b; export const multiply = (a,b) => a*b;\n" };
      const finalText = "STATUS: DONE\nFILES: src/calc.mjs\nTESTS: not-run(parent-owned)\nINTERFACES: multiply(a,b)\nREQUIREMENTS: R01 product, R02 frozen tests\nCONCERNS: offline transport seam";
      const choice = calls === 1
        ? { index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "offline-write", type: "function", function: { name: "write", arguments: JSON.stringify(write) } }, { index: 1, id: "offline-frozen-write", type: "function", function: { name: "write", arguments: JSON.stringify({ i: "Trying frozen test mutation", path: "tests/calc.test.mjs", content: "// weakened tests\n" }) } }] }, finish_reason: null }
        : { index: 0, delta: { role: "assistant", content: finalText }, finish_reason: null };
      const chunk = { id: `offline-${calls}`, object: "chat.completion.chunk", created: 1, model: body.model };
      const packets = [{ ...chunk, choices: [choice] }, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }, { ...chunk, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 0 } } }];
      return new Response(packets.map(p => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    };
    await run({ fetchImpl });
    assert.equal(calls, 2);
    assert.equal(escapedCalls, 0);
    const native = readSession(join(runDir, "session"), DEFAULT_MODEL);
    assert.equal(native.assistantTurns, 2);
    assert.equal(native.toolCalls[0].name, "write");
    assert.match(native.finalText, /^STATUS: DONE/);
    const { add, multiply } = await import(pathToFileURL(join(repo, "src", "calc.mjs")).href);
    assert.equal(multiply(-2,5), -10); assert.equal(add(3,4), 7);
    const toolResults = JSON.parse(readFileSync(join(runDir, "tool-results.json"), "utf8"));
    assert.equal(toolResults.find(result => result.toolCallId === "offline-write")?.isError, false);
    assert.equal(toolResults.find(result => result.toolCallId === "offline-frozen-write")?.isError, true);
    assert.equal(readFileSync(join(repo, "tests", "calc.test.mjs"), "utf8"), "// Frozen fixture input for the transport seam\n");
    const ledger = loadSpendLedger(root);
    assert.equal(ledger.status, "ok");
    assert.equal(ledger.requests.every(r => r.status === "settled"), true);
    assert.ok(Math.abs(ledger.cumulative_tariff_usd - native.tariff_usd) <= 1e-12, "Native and ledger tariff totals differ beyond floating-point tolerance");
  } finally {
    process.argv = priorArgv; globalThis.fetch = priorFetch;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
