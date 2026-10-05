#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CAPS, DEFAULT_MODEL, FIXED_TARIFFS, createRequestBudget } from "./bench-budget.mjs";
import { readSession } from "./bench-results.mjs";

function exportedPath(root, subpath = ".") {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const keys = Object.keys(pkg.exports).filter(k => k === subpath || k.endsWith("*") && subpath.startsWith(k.slice(0, -1))).sort((a,b) => b.length - a.length);
  const key = keys[0];
  const value = pkg.exports[key];
  const entry = typeof value === "string" ? value : value?.import;
  if (typeof entry !== "string") throw new Error("Installed SDK lacks import export");
  return pathToFileURL(resolve(root, entry.replace("*", subpath.slice(key.length - 1)))).href;
}

function packageRoot() {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent")));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@oh-my-pi/pi-coding-agent") return dir;
  } catch {}
  const roots = [];
  for (const bin of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    if (existsSync(join(bin, process.platform === "win32" ? "omp.cmd" : "omp"))) {
      roots.push(join(bin, "node_modules"), join(dirname(realpathSync(join(bin, process.platform === "win32" ? "omp.cmd" : "omp"))), ".."));
    }
  }
  try { roots.push(execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" }).trim()); } catch {}
  for (const root of roots) {
    const dir = join(root, "@oh-my-pi", "pi-coding-agent");
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error("Install OMP with its exported SDK and Bun before evaluation");
}

function args() {
  const out = { model: DEFAULT_MODEL, arm: "baseline-noskill", ceiling: 1 };
  const names = { "--task": "task", "--arm": "arm", "--prompt-file": "prompt", "--run-dir": "runDir", "--model": "model", "--skill": "skill", "--root": "root", "--ceiling": "ceiling" };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === "--setup-only") out.setupOnly = true;
    else if (names[key] && process.argv[i + 1]) out[names[key]] = key === "--ceiling" ? Number(process.argv[++i]) : process.argv[++i];
    else throw new Error(`Unknown/missing argument: ${key}`);
  }
  if (!out.root) throw new Error("--root must identify evaluation inputs/ledger");
  return out;
}

function fixtureInput(repo, task) {
  const files = readdirSync(join(repo, "src")).filter(f => /\.(mjs|ts)$/.test(f)).sort().map(f => `FILE src/${f}\n${readFileSync(join(repo, "src", f), "utf8")}`);
  if (task.includes("workflow")) files.push(`FILE tests/calc.test.mjs\n${readFileSync(join(repo, "tests", "calc.test.mjs"), "utf8")}`);
  if (existsSync(join(repo, "manifest.md"))) files.push(`MANIFEST\n${readFileSync(join(repo, "manifest.md"), "utf8")}`);
  if (task.includes("positive") || task.includes("defect")) files.push(`PATCH\n${execFileSync("git", ["diff", "HEAD~1", "HEAD", "--", "src"], { cwd: repo, encoding: "utf8" })}`);
  if (task.includes("negative")) {
    const result = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, ["src/cli.mjs"], { cwd: repo, encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) throw new Error("Product fixture execution failed");
    files.push(`OBSERVED PRODUCT COMMAND node src/cli.mjs\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nexit: ${result.status}`);
  }
  return files.join("\n\n");
}

function redactFailure(value) {
  return String(value ?? "").replace(/(?:https?:\/\/)[^\s"'<>]+/gi, "[REDACTED:URL]")
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+|gh[pousr]_[\w]+|AIza[\w-]+|AKIA[A-Z0-9]+|xox[baprs]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi, "[REDACTED:CREDENTIAL]")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;}]+/gi, "[REDACTED:CREDENTIAL]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[REDACTED:OPAQUE]");
}

export async function run({ fetchImpl }: { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = {}) {
  const options = args();
  const root = resolve(options.root);
  const originalFetch = globalThis.fetch.bind(globalThis);
  // Installed SDK startup/catalog/title/maintenance requests cannot bypass the active paid-turn boundary.
  globalThis.fetch = async () => { throw new Error("Network forbidden outside reserved benchmark inference"); };
  const pkg = packageRoot();
  // Runtime-selected installed package exports: static imports cannot resolve an optional global SDK.
  const sdk = await import(exportedPath(pkg));
  const { ModelRegistry } = await import(exportedPath(pkg, "./config/model-registry"));
  const { AssistantMessageEventStream } = await import(pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-ai/utils/event-stream", pkg)).href);
  const settings = sdk.Settings.isolated({ "retry.enabled": false, "retry.modelFallback": false, "compaction.enabled": false, "compaction.midTurnEnabled": false, "advisor.enabled": false, "memory.backend": "off", "providers.cacheWarming": "off", "edit.recoverInlineEdits": false, "title.refreshOnReplan": false });
  const authStorage = await sdk.discoverAuthStorage(undefined, { settings, cwd: root });
  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings, fetch: globalThis.fetch });
  const slash = options.model.indexOf("/");
  const model = modelRegistry.find(options.model.slice(0, slash), options.model.slice(slash + 1));
  if (slash < 1 || !model || `${model.provider}/${model.id}` !== options.model || !modelRegistry.hasConfiguredAuth(model)) throw new Error("Exact configured model/auth unavailable (no fallback)");
  const tariff = FIXED_TARIFFS[options.model];
  if (!tariff || model.api !== "openai-completions" || Object.keys(tariff).some(k => model.cost?.[k] !== tariff[k])) throw new Error("Model lacks supported transport/fixed SDK tariff");
  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const wireModel = model.thinking?.effortRouting?.off ?? model.requestModelId ?? model.id;
  const commonOptions = { cwd: root, model, authStorage, modelRegistry, settings, thinkingLevel: "off", skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], disableExtensionDiscovery: true, enableMCP: false, enableIrc: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false, bindProcessState: false, requireYieldTool: false, spawns: "", sessionManager: sdk.SessionManager.inMemory(), systemPrompt: "Complete the supplied constructed fixture task using only the supplied inputs and available tools. Do not access credentials or network. Follow the requested output contract." };
  if (options.setupOnly) {
    const { session } = await sdk.createAgentSession({ ...commonOptions, toolNames: [], restrictToolNames: true });
    if (`${session.model?.provider}/${session.model?.id}` !== options.model) throw new Error("Session rebound model");
    await session.dispose();
    console.log(JSON.stringify({ setup: "ready", sdkVersion: JSON.parse(readFileSync(join(pkg, "package.json"))).version, selector: options.model, transport: model.api, authConfigured: true, caps: CAPS, tariffSource: "installed SDK fixed catalog; not independent provider billing" }));
    return;
  }
  if (!options.runDir || !options.prompt || !["baseline-noskill", "candidate-skill"].includes(options.arm)) throw new Error("Missing run paths/invalid arm");
  const runDir = resolve(options.runDir), repo = join(runDir, "repo");
  const workflow = options.task === "eval-workflow-execution-outcome";
  const skillPath = options.skill ? join(root, "skills", options.skill, "SKILL.md") : null;
  const skill = options.arm === "candidate-skill" ? readFileSync(skillPath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") : "";
  if (options.arm === "candidate-skill" && !skill.trim()) throw new Error("Missing candidate skill body");
  const fixture = fixtureInput(repo, options.task);
  const prompt = `${skill ? `TARGET SKILL INSTRUCTIONS\n${skill}\n\n` : ""}${readFileSync(options.prompt, "utf8")}\n\nCONSTRUCTED FIXTURE INPUTS\n${fixture}`;
  mkdirSync(join(runDir, "session"), { recursive: true });
  writeFileSync(join(runDir, "input.json"), JSON.stringify({ task: options.task, arm: options.arm, selector: options.model, fixtureHash: createHash("sha256").update(fixture).digest("hex"), skillHash: skill ? createHash("sha256").update(skill).digest("hex") : null, caps: CAPS }, null, 2));
  if (workflow) writeFileSync(join(runDir, "frozen-tests.json"), JSON.stringify({ file: "tests/calc.test.mjs", sha256: createHash("sha256").update(readFileSync(join(repo, "tests", "calc.test.mjs"))).digest("hex") }));
  const budget = createRequestBudget({ root, selector: options.model, endpoint, wireModel, runId: process.env.BENCH_RUN_ID || runDir, maxRequests: workflow ? CAPS.workflowRequests : 1, ceiling: options.ceiling, fetchImpl: fetchImpl ?? originalFetch });
  globalThis.fetch = budget.fetch;
  const { session } = await sdk.createAgentSession({ ...commonOptions, cwd: repo, toolNames: workflow ? ["read", "write"] : [], restrictToolNames: true });
  // Native tools may touch fixture inputs only, never the ledger/transcript/checker or credential paths.
  if (workflow) for (const tool of session.agent.state.tools) {
    const execute = tool.execute.bind(tool);
    tool.execute = (id, params, ...rest) => {
      const path = params.path;
      if (typeof path !== "string" || !["src/calc.mjs", "tests/calc.test.mjs"].some(file => resolve(repo, file) === resolve(repo, path))) throw new Error("Tool path outside bounded fixture");
      return execute(id, params, ...rest);
    };
  }
  const transcript = join(runDir, "session", "session.jsonl");
  const events = [{ type: "session_start", sessionId: session.sessionId, selector: options.model, timestamp: Date.now() }];
  const persist = () => writeFileSync(transcript, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  persist();
  const record = message => { events.push({ type: "message", message: { role: message.role, provider: message.provider, model: message.model, timestamp: message.timestamp, stopReason: message.stopReason, content: message.content, usage: message.usage } }); persist(); };
  let success = false, streamCalls = 0, contextBytes = 0;
  try {
    if (workflow) {
      const originalStream = session.agent.streamFn;
      if (typeof originalStream !== "function") throw new Error("SDK StreamFn unavailable");
      session.agent.streamFn = (streamModel, context, streamOptions) => {
        streamCalls++;
        // Native normalized tools retain executable/session fields; those are NOT provider input.
        const providerContext = { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools?.map(({ name, description, parameters, strict }) => ({ name, description, parameters, strict })) };
        contextBytes = Buffer.byteLength(JSON.stringify(providerContext));
        if (`${streamModel.provider}/${streamModel.id}` !== options.model || contextBytes > CAPS.contextBytes) throw new Error("Model/context cap violation before stream dispatch");
        budget.begin();
        const output = new AssistantMessageEventStream();
        void (async () => {
          try {
            const inner = await originalStream(streamModel, context, { ...streamOptions, maxTokens: CAPS.outputTokens, disableReasoning: true, forceReasoningOff: true, fetch: budget.fetch, preferWebsockets: false });
            for await (const event of inner) {
              if (event.type === "done" || event.type === "error") { const message = event.message ?? event.error; budget.settle(message); record(message); }
              output.push(event);
            }
            output.end();
          } catch (error) { budget.fail(); output.fail(error); }
        })();
        return output;
      };
      await session.prompt(prompt);
    } else {
      budget.begin();
      const result = await session.runEphemeralTurn({ promptText: prompt, tools: false, maxTokens: CAPS.outputTokens, maxContextBytes: CAPS.contextBytes, dedupeReply: false });
      budget.settle(result.assistantMessage); record(result.assistantMessage);
    }
    const final = [...events].reverse().find(e => e.type === "message")?.message;
    if (final?.stopReason !== "stop" || final.content.some(p => p.type === "toolCall")) {
      const native = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
      throw new Error(`No normal final assistant completion: ${redactFailure(native?.errorMessage || native?.stopReason || "no native assistant message")}`);
    }
    success = true;
  } catch (error) {
    const native = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
    writeFileSync(join(runDir, "failure.json"), JSON.stringify({ sessionId: session.sessionId, selector: options.model, error: redactFailure(error.message), streamCalls, contextBytes, physicalRequests: budget.requests, recordedAssistantTurns: events.filter(e => e.type === "message").length, nativeMessageCount: session.agent.state.messages.length, nativeTerminal: native ? { provider: native.provider, model: native.model, stopReason: native.stopReason, errorMessage: redactFailure(native.errorMessage), usage: native.usage, recorded: events.some(e => e.type === "message" && e.message.timestamp === native.timestamp) } : null }, null, 2) + "\n");
    throw error;
  } finally {
    if (!success) budget.fail();
    events.push({ type: "session_end", sessionId: session.sessionId, completed: success, timestamp: Date.now() }); persist();
    await session.dispose();
    globalThis.fetch = originalFetch;
  }
  const result = readSession(join(runDir, "session"), options.model);
  process.stdout.write(result.finalText + "\n");
}

if (import.meta.main) run().catch(error => { console.error(`Benchmark runner failed: ${redactFailure(error.message)}`); process.exitCode = 1; });
