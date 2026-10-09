import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateNativeMessage, DEFAULT_MODEL, assertBudgetReady } from "./bench-budget.mjs";

export function readSession(sessionDir, selector = DEFAULT_MODEL, { requireCompletion = true } = {}) {
  const files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
  if (files.length !== 1) throw new Error("Expected exactly one isolated native transcript");
  const events = readFileSync(join(sessionDir, files[0]), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const start = events[0], end = events.at(-1);
  if (start?.type !== "session_start" || typeof start.sessionId !== "string" || !start.sessionId || start.selector !== selector || end?.type !== "session_end" || end.sessionId !== start.sessionId || typeof end.completed !== "boolean" || requireCompletion && !end.completed || !Number.isSafeInteger(start.timestamp) || !Number.isSafeInteger(end.timestamp) || end.timestamp < start.timestamp) throw new Error("Missing/invalid native session completion attribution");
  const messages = events.slice(1, -1).map(event => {
    if (event.type !== "message") throw new Error("Unexpected transcript event");
    validateNativeMessage(event.message, selector);
    return event.message;
  });
  if (!messages.length) throw new Error("Missing native assistant messages");
  const last = messages.at(-1);
  const normalFinal = last.stopReason === "stop" && !last.content.some(p => p.type === "toolCall");
  if ((requireCompletion || end.completed) && !normalFinal) throw new Error("Last assistant did not stop normally");
  const finalText = end.completed && normalFinal ? last.content.filter(p => p.type === "text").map(p => {
    if (typeof p.text !== "string") throw new Error("Malformed assistant text");
    return p.text;
  }).join("\n").trim() : null;
  if ((requireCompletion || end.completed) && !finalText) throw new Error("Missing final assistant report");
  const toolCalls = messages.flatMap(m => m.content.filter(p => p.type === "toolCall").map(p => ({ name: p.name, input: p.arguments })));
  const usage = messages.reduce((sum, m) => { for (const key of ["input", "output", "cacheRead", "cacheWrite"]) sum[key] += m.usage[key]; return sum; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return { finalText, completed: end.completed, termination: { completed: end.completed, stopReason: last.stopReason }, toolCalls, usage, sessionId: start.sessionId, assistantTurns: messages.length, turns: messages.map(m => ({ stopReason: m.stopReason, usage: m.usage })), tariff_usd: messages.reduce((sum, m) => sum + m.usage.cost.total, 0) };
}

/** Accounted bounded failure is an observed outcome; unknown or inconsistent accounting still halts. */
export function readRunOutcome(result, selector, ledger) {
  assertBudgetReady(ledger);
  const requests = ledger.requests.filter(row => row.runId === result.runId);
  if (!requests.length) throw new Error(`Run never dispatched: ${result.runId}; retained process/check errors`);
  const native = readSession(join(result.runDir, "session"), selector, { requireCompletion: false });
  if (native.assistantTurns !== requests.length) throw new Error("Transcript/request ledger mismatch");
  for (let i = 0; i < requests.length; i++) {
    const row = requests[i], turn = native.turns[i];
    if (row.selector !== selector || row.stopReason !== turn.stopReason || !isDeepStrictEqual(row.usage, turn.usage) || turn.usage.input + turn.usage.output + turn.usage.cacheRead === 0 || [row.tariff_usd, row.sdk_tariff_usd].some(cost => typeof cost !== "number" || !Number.isFinite(cost) || Math.abs(cost - turn.usage.cost.total) > 1e-12)) throw new Error("Transcript/request ledger mismatch");
  }
  const input = JSON.parse(readFileSync(join(result.runDir, "input.json"), "utf8"));
  if (input.task !== result.task || input.arm !== result.arm || input.selector !== selector || !/^[a-f0-9]{64}$/.test(input.fixtureHash) || (result.arm === "baseline-noskill" ? input.skillHash !== null : !/^[a-f0-9]{64}$/.test(input.skillHash))) throw new Error("Native input attribution mismatch");
  const scorePath = join(result.runDir, "score.json");
  const score = existsSync(scorePath) ? JSON.parse(readFileSync(scorePath, "utf8")) : { requirementsSatisfied: false, failures: ["Missing observed requirement score artifact"] };
  if (!score || typeof score.requirementsSatisfied !== "boolean") throw new Error("Malformed observed requirement score");
  const executionFailures = [];
  if (result.agentExit !== 0 || result.status !== "ok") executionFailures.push(`Native process status ${result.status}, exit ${result.agentExit}`);
  if (!native.completed) executionFailures.push("No normally completed final assistant report");
  const requirementsSatisfied = score.requirementsSatisfied && executionFailures.length === 0;
  const failurePath = join(result.runDir, "failure.json");
  return { evaluationStatus: requirementsSatisfied ? "passed" : "failed", sessionId: native.sessionId, assistantTurns: native.assistantTurns, usage: native.usage, turns: native.turns, finalText: native.finalText, termination: native.termination, tariff_usd: requests.reduce((sum, row) => sum + row.tariff_usd, 0), score: { ...score, requirementsSatisfied, executionFailures }, input, failure: existsSync(failurePath) ? JSON.parse(readFileSync(failurePath, "utf8")) : null };
}

export function extractFinalAssistantResponse() {
  if (!process.env.BENCH_RUN_DIR) throw new Error("BENCH_RUN_DIR missing");
  const input = JSON.parse(readFileSync(join(process.env.BENCH_RUN_DIR, "input.json"), "utf8"));
  return readSession(join(process.env.BENCH_RUN_DIR, "session"), input.selector);
}

export function scoreReview(finalText, scenario) {
  const report = JSON.parse(finalText);
  if (!["implementation-review", "blind-acceptance"].includes(report.mode) || !Array.isArray(report.findings) || !["correct", "incorrect", "ACCEPT", "REJECT"].includes(report.verdict) || report.findings.some(f => typeof f.file_path !== "string" || typeof f.body !== "string" || typeof f.title !== "string")) throw new Error("Malformed terminal findings report");
  if (scenario === "negative") {
    if (!report.requirements || !["R01", "R02"].every(id => report.requirements[id] === "proven")) throw new Error("Missing requirement verdicts");
    const falsePositives = report.findings.length + (report.mode !== "blind-acceptance" ? 1 : 0);
    return { activation: report.mode === "blind-acceptance", missedDefects: 0, falsePositives, requirementsSatisfied: report.verdict === "ACCEPT" && falsePositives === 0, findings: report.findings };
  }
  const positive = scenario === "positive";
  const consumer = positive ? "src/dispatcher.ts" : "src/router.ts";
  const variant = positive ? /\bpause\b/i : /\bExportReport\b/i;
  const caught = report.findings.filter(f => f.file_path === consumer && variant.test(f.body + " " + f.title) && /unhandled|missing|drop|undefined|fall.?through|not handled|unsupported/i.test(f.body));
  const helper = report.findings.filter(f => f.file_path === "src/utils.ts" && (positive ? /customPad|padStart|empty|infinite|overshoot/i : /shallowOrDeepCopy|structuredClone|JSON|loss|Date|undefined/i).test(f.body + " " + f.title));
  const known = new Set([...caught, ...helper]);
  const falsePositives = report.findings.filter(f => !known.has(f)).length;
  return { activation: report.mode === "implementation-review", missedDefects: caught.length ? 0 : 1, falsePositives, simplificationIdentified: helper.length > 0, requirementsSatisfied: report.mode === "implementation-review" && report.verdict === "incorrect" && caught.length > 0 && helper.length > 0 && falsePositives === 0, findings: report.findings };
}

export function verifyFrozenTests(repo, snapshot) {
  if (snapshot?.file !== "tests/calc.test.mjs" || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new Error("Malformed frozen test snapshot");
  return createHash("sha256").update(readFileSync(join(repo, snapshot.file))).digest("hex") === snapshot.sha256;
}

export function writeScore(name, score) {
  // Retain unfavorable scores as data, not only a failed check's tail.
  const passed = score.requirementsSatisfied;
  writeFileSync(join(process.env.BENCH_RUN_DIR, "score.json"), JSON.stringify({ scenario: name, ...score }, null, 2) + "\n");
  console.log(JSON.stringify({ scenario: name, ...score }));
  return passed ? 0 : 1;
}
