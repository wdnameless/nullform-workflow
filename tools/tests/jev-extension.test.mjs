import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

function runBunTest(testCode) {
  const fullCode = `
import assert from "node:assert/strict";
import jevExtensionFactory, { createJevExtension, getEffectiveNativeSkills } from "./agent/extensions/nullform-jev.ts";

${testCode}
`;
  const res = spawnSync("bun", ["-e", fullCode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  assert.equal(res.status, 0, `Bun execution failed:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`);
}

test("R01: before_agent_start suggests skill via message without altering systemPrompt", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = {
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerProvider: () => {},
      unregisterProvider: () => {},
      getCommands: () => [
        { source: "skill", name: "skill:test-skill", description: "A very long detailed raw skill description that must not be emitted", path: "/path/test-skill" },
      ],
    };

    const mockCore = {
      async readCredential() { return "test-api-key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return {
          skills: effectiveSkills || [{ name: "test-skill", description: "A very long detailed raw skill description that must not be emitted" }],
          fingerprint: "cat-fp-1",
        };
      },
      screenTask(text) {
        return { allowed: true, reason: "" };
      },
      async decide() {
        return {
          status: "ok",
          reason: "matched",
          skill: "test-skill",
          route: "cheap",
          archetype: "lookup",
          confidence: 0.95,
          skillConfidence: 0.95,
          routingConfidence: 0.95,
          eligibleScore: 1.0,
          model: "typesafe/jev-1.13",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
        };
      },
      policyFingerprint: () => "fp-1",
      evaluateReport: () => ({ skillPassed: true, routingPassed: true, archetypes: ["lookup"] }),
      readPolicy: () => ({
        version: 1,
        enabled: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat-fp-1",
        candidateModel: "google/gemini-3.1-flash-lite",
        baselineModel: "google/gemini-3.8-flash",
        decisionModel: "typesafe/jev-1.13",
        fingerprint: "fp-1",
        skillPassed: true,
        routingPassed: true,
        reportSha256: "sha-1",
        archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    const ext = createJevExtension({ core: mockCore });
    await ext(mockPi);

    const startHandler = handlers.get("before_agent_start");
    assert.ok(startHandler, "before_agent_start must be registered");

    const ctx = {
      agent: { kind: "main" },
      models: { resolve: () => undefined, list: () => [] },
    };

    const result = await startHandler({
      type: "before_agent_start",
      prompt: "Find the declaration of test symbol",
      systemPrompt: ["base system prompt"],
    }, ctx);

    assert.ok(result, "Expected result from before_agent_start");
    assert.equal(result.systemPrompt, undefined, "Must NOT return systemPrompt");
    assert.ok(result.message, "Must return message payload");
    assert.equal(result.message.content, "[JEV Assistance] Recommended skill: test-skill (lookup)");
    assert.doesNotMatch(result.message.content, /A very long detailed raw skill description/);
  `);
});

test("R01, R07: before_agent_start ignores subagent, secret-bearing prompt, and invalid snapshots/confidence", () => {
  runBunTest(`
    const handlers = new Map();
    let decideCalls = 0;
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      registerProvider: () => {},
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    let decisionResult = {
      status: "ok",
      skill: "s1",
      route: "cheap",
      archetype: "lookup",
      confidence: 0.9,
      skillConfidence: 0.9,
      eligibleScore: 1.0,
      model: "typesafe/jev-1.13",
    };

    const mockCore = {
      async readCredential() { return "test-api-key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask(text) {
        if (text.includes("sk-or-v1-")) return { allowed: false, reason: "secret" };
        return { allowed: true, reason: "" };
      },
      async decide() {
        decideCalls++;
        return decisionResult;
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "fp", candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        fingerprint: "pfp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const handler = handlers.get("before_agent_start");

    // 1. Subagent kind must be ignored
    const subCtx = { agent: { kind: "sub" } };
    const resSub = await handler({ type: "before_agent_start", prompt: "regular prompt" }, subCtx);
    assert.equal(resSub, undefined, "Subagent must not run before_agent_start");
    assert.equal(decideCalls, 0);

    // 2. Secret canary prompt must be screened out
    const mainCtx = { agent: { kind: "main" } };
    const resSecret = await handler({ type: "before_agent_start", prompt: "my key is sk-or-v1-abcdef1234567890" }, mainCtx);
    assert.equal(resSecret, undefined, "Secret prompt must not trigger assistance");
    assert.equal(decideCalls, 0);

    // 3. Stale decision snapshot rejected
    decisionResult = {
      status: "ok",
      skill: "s1",
      route: "cheap",
      archetype: "lookup",
      confidence: 0.9,
      skillConfidence: 0.9,
      eligibleScore: 1.0,
      model: "typesafe/jev-stale-unverified",
    };
    const resStale = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resStale, undefined, "Stale decision snapshot must be rejected");

    // 4. Low skill confidence (< 0.8) rejected
    decisionResult = {
      status: "ok",
      skill: "s1",
      route: "cheap",
      archetype: "lookup",
      confidence: 0.7,
      skillConfidence: 0.7,
      eligibleScore: 1.0,
      model: "typesafe/jev-1.13",
    };
    const resLowConf = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resLowConf, undefined, "Low skill confidence must be rejected");

    // 5. Safe non-leaf skill hint with baseline route and low eligibleScore is suggested
    decisionResult = {
      status: "ok",
      skill: "s1",
      route: "baseline",
      archetype: "none",
      confidence: 0.95,
      skillConfidence: 0.95,
      eligibleScore: 0.15,
      model: "typesafe/jev-1.13",
    };
    const resSafeSkill = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.ok(resSafeSkill && resSafeSkill.message, "High-confidence safe skill must be suggested regardless of cheap-route eligibility");
    assert.match(resSafeSkill.message.content, /Recommended skill: s1/);
  `);
});

test("R02, R07: tool_call caches leaf archetypes for unique names and exact role, rejecting protected roles and clearing ambiguous names", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    let decideParams = [];
    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide(args) {
        decideParams.push(args);
        return {
          status: "ok",
          route: "cheap",
          archetype: "lookup",
          confidence: 0.92,
          eligibleScore: 0.98,
          routingConfidence: 0.93,
          model: "typesafe/jev-1.13",
        };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand-model", baselineModel: "base-model", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const ctx = { agent: { kind: "main" } };

    // 1. Protected role (oracle, reviewer, fixer) rejected
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "task-oracle", agent: "oracle", task: "review this" },
    }, ctx);
    assert.equal(decideParams.length, 0, "Protected role oracle must not be decided for cheap routing");

    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "task-reviewer", agent: "reviewer", task: "audit code" },
    }, ctx);
    assert.equal(decideParams.length, 0, "Protected role reviewer must not be decided");

    // 2. Unnamed task rejected
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { agent: "task", task: "unnamed action" },
    }, ctx);
    assert.equal(decideParams.length, 0, "Unnamed task must not be decided");

    // 3. Ambiguous task names rejected
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: {
        tasks: [
          { name: "dup-task", agent: "task", task: "first" },
          { name: "dup-task", agent: "task", task: "second" },
        ],
      },
    }, ctx);
    assert.equal(decideParams.length, 0, "Ambiguous duplicate task names must not be decided");

    // 4. Valid single task with explicit name and eligible role
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "unique-leaf", agent: "task", task: "find definition" },
    }, ctx);
    assert.equal(decideParams.length, 1, "Eligible task must be evaluated");
    assert.equal(decideParams[0].task, "find definition");
    assert.deepEqual(decideParams[0].skills, [], "Routing-only tool_call decisions must pass empty skills array");

    // 5. Subsequent ambiguous batch clears previously cached entry for that name
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: {
        tasks: [
          { name: "unique-leaf", agent: "task", task: "ambiguous 1" },
          { name: "unique-leaf", agent: "task", task: "ambiguous 2" },
        ],
      },
    }, ctx);
    // Since unique-leaf was duplicate in the new batch, its entry is invalidated
  `);
});

test("R02, R07, R08: before_subagent_spawn routes matching spawnKey and role with full selector and fallback, preserving baseline on mismatch", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide() {
        return {
          status: "ok",
          route: "cheap",
          archetype: "lookup",
          confidence: 0.92,
          eligibleScore: 0.98,
          routingConfidence: 0.95,
          model: "typesafe/jev-1.13",
        };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand-model", baselineModel: "base-model", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");

    const availableModel = {
      id: "nullform-openrouter/cand-model",
      cost: { input: 0.05, output: 0.2 },
    };
    const baselineModel = {
      id: "base-model",
      cost: { input: 0.15, output: 0.6 },
    };

    const ctx = {
      agent: { kind: "main" },
      models: {
        resolve: (id) => (
          id === "nullform-openrouter/cand-model" || id === "cand-model"
            ? availableModel
            : (id === "base-model" ? baselineModel : undefined)
        ),
        list: () => [availableModel, baselineModel],
      },
    };

    // Cache decisions for "search-leaf" and "mismatch-leaf"
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: {
        tasks: [
          { name: "search-leaf", agent: "task", task: "lookup reference" },
          { name: "mismatch-leaf", agent: "task", task: "lookup another reference" },
        ],
      },
    }, ctx);

    // 1. Explicit caller selector (modelRole is undefined) must NOT be rerouted
    const explicitSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: undefined,
      patterns: ["anthropic/claude-3-5-sonnet"],
      spawnKey: "search-leaf",
    }, ctx);
    assert.equal(explicitSpawn, undefined, "Explicit selector must preserve baseline");

    // 2. Eval invocation kind must NOT be rerouted
    const evalSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "eval",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "search-leaf",
    }, ctx);
    assert.equal(evalSpawn, undefined, "Eval invocation kind must preserve baseline");

    // 3. Protected role must NOT be rerouted
    const protectedSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "oracle",
      invocationKind: "task",
      modelRole: "oracle",
      patterns: ["base-model"],
      spawnKey: "search-leaf",
    }, ctx);
    assert.equal(protectedSpawn, undefined, "Protected role must preserve baseline");

    // 4. Role mismatch must NOT be rerouted
    const mismatchSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "sonic",
      invocationKind: "task",
      modelRole: "sonic",
      patterns: ["base-model"],
      spawnKey: "mismatch-leaf",
    }, ctx);
    assert.equal(mismatchSpawn, undefined, "Role mismatch must preserve baseline");

    // 5. Positive routing with matching spawnKey and role returns full selector and patterns fallback
    const validSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "search-leaf",
    }, ctx);
    assert.ok(validSpawn, "Matching spawnKey and role must route");
    const routedModels = Array.isArray(validSpawn.model) ? validSpawn.model : [validSpawn.model];
    assert.equal(routedModels[0], "nullform-openrouter/cand-model");
    assert.ok(routedModels.includes("base-model"), "Must preserve original patterns fallback");
    assert.match(validSpawn.note, /lookup/);

    // 6. Consume once: second spawn with same key must NOT route
    const secondSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "search-leaf",
    }, ctx);
    assert.equal(secondSpawn, undefined, "Decisions must be consumed once");

    // 7. Verify that mismatch-leaf was NOT consumed by the earlier role mismatch
    const recoveredSpawn = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "mismatch-leaf",
    }, ctx);
    assert.ok(recoveredSpawn, "Mismatch must not destroy cached decision for valid subsequent match");
  `);
});

test("R04: candidate model availability, observed price metadata, and baseline comparison check", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide() {
        return {
          status: "ok",
          route: "cheap",
          archetype: "lookup",
          confidence: 0.9,
          eligibleScore: 0.98,
          routingConfidence: 0.95,
          model: "typesafe/jev-1.13",
        };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand-model", baselineModel: "base-model", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");

    // 1. Missing candidate model in ctx.models preserves baseline
    const emptyCtx = {
      agent: { kind: "main" },
      models: { resolve: () => undefined, list: () => [] },
    };
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "task-missing-model", agent: "task", task: "lookup" },
    }, emptyCtx);

    const resMissing = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "task-missing-model",
    }, emptyCtx);
    assert.equal(resMissing, undefined, "Missing model in registry must preserve baseline");

    // 2. Candidate model with non-positive cost preserves baseline
    const zeroCostModel = { id: "nullform-openrouter/cand-model", cost: { input: 0, output: 0 } };
    const zeroCostCtx = {
      agent: { kind: "main" },
      models: { resolve: () => zeroCostModel, list: () => [zeroCostModel] },
    };
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "task-zero-cost", agent: "task", task: "lookup" },
    }, zeroCostCtx);

    const resZeroCost = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "task-zero-cost",
    }, zeroCostCtx);
    assert.equal(resZeroCost, undefined, "Zero/unobserved cost must preserve baseline");

    // 3. Candidate model cost >= baseline cost preserves baseline
    const expensiveCandModel = { id: "nullform-openrouter/cand-model", cost: { input: 1.0, output: 2.0 } };
    const cheapBaseModel = { id: "base-model", cost: { input: 0.5, output: 1.0 } };
    const expensiveCtx = {
      agent: { kind: "main" },
      models: {
        resolve: (id) => (id === "nullform-openrouter/cand-model" || id === "cand-model" ? expensiveCandModel : cheapBaseModel),
        list: () => [expensiveCandModel, cheapBaseModel],
      },
    };
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "task-expensive", agent: "task", task: "lookup" },
    }, expensiveCtx);

    const resExpensive = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "task-expensive",
    }, expensiveCtx);
    assert.equal(resExpensive, undefined, "Candidate cost >= baseline cost must preserve baseline");
  `);
});

test("R04: automatic candidate provider registration with observed catalog prices", () => {
  runBunTest(`
    const registered = [];
    const mockPi = {
      on: () => {},
      registerProvider(name, config) {
        registered.push({ name, config });
      },
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    const mockCore = {
      async readCredential() { return "sk-openrouter-dummy"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "nullform-openrouter/google/gemini-3.1-flash-lite",
        baselineModel: "google/gemini-3.8-flash",
        decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
        modelPrices: {
          "google/gemini-3.1-flash-lite": { prompt: 0.00000025, completion: 0.0000015 },
          "google/gemini-3.8-flash": { prompt: 0.00000075, completion: 0.00000375 },
        },
      }),
    };

    // Default runtime without candidateProvider explicit option registers provider automatically
    const ext = createJevExtension({ core: mockCore });
    await ext(mockPi);

    assert.equal(registered.length, 1, "Provider must be registered on default runtime");
    const reg = registered[0];
    assert.equal(reg.name, "nullform-openrouter");
    assert.equal(reg.config.api, "openai-completions");
    assert.ok(Array.isArray(reg.config.models), "Provider must declare models");

    const cheapModel = reg.config.models.find(m => m.id === "google/gemini-3.1-flash-lite");
    assert.ok(cheapModel, "Cheap model must be declared");
    assert.equal(cheapModel.supportsTools, undefined, "Must NOT put undocumented supportsTools into ProviderModelConfig");
    assert.equal(cheapModel.cost.input, 0.25, "Cheap model input cost must match observed $0.25/1M");
    assert.equal(cheapModel.cost.output, 1.5, "Cheap model output cost must match observed $1.50/1M");

    const baseModel = reg.config.models.find(m => m.id === "google/gemini-3.8-flash");
    assert.ok(baseModel, "Baseline model must be declared");
    assert.equal(baseModel.cost.input, 0.75, "Baseline model input cost must match observed $0.75/1M");
    assert.equal(baseModel.cost.output, 3.75, "Baseline model output cost must match observed $3.75/1M");
  `);
});

test("R02, R04: catalog fingerprint mismatch in task and spawn paths retains baseline", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [
        { source: "skill", name: "skill:s1", description: "desc" },
      ],
    };

    let decideCalls = 0;
    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog() {
        return { skills: [{ name: "s1", description: "desc" }], fingerprint: "drifted-cat-fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide() {
        decideCalls++;
        return { status: "ok", route: "cheap", archetype: "lookup", confidence: 0.95, eligibleScore: 1.0, routingConfidence: 0.95 };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand-model", baselineModel: "base-model", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "expected-cat-fp",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const ctx = { agent: { kind: "main" } };

    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "drifted-task", agent: "task", task: "lookup reference" },
    }, ctx);

    assert.equal(decideCalls, 0, "Tool call must not decide when catalog fingerprint is drifted");
  `);
});

test("Regression: getEffectiveNativeSkills extracts authoritative active skills from native getCommands preserving namespaces and metadata", () => {
  runBunTest(`
    const mockPi = {
      getCommands: () => [
        { source: "skill", name: "skill:agent-browser", description: "Browser automation skill", path: "/skills/browser" },
        { source: "skill", name: "skill:nullform/deepwork", description: "Namespaced deepwork skill", path: "/plugins/deepwork" },
        { source: "extension", name: "/status", description: "Extension status command" },
        { source: "prompt", name: "review-code", description: "Custom prompt" },
        { source: "prompt", name: "skill:spoofed-prompt", description: "Prefix spoof in prompt" },
        { source: "extension", name: "skill:spoofed-ext", description: "Prefix spoof in extension" },
        { name: "skill:unprefixed-source", description: "Skill command by prefix only without source:skill" },
        null,
        { name: 123 },
      ],
    };

    const skills = getEffectiveNativeSkills(mockPi);
    assert.ok(Array.isArray(skills), "Must return array of skills");
    assert.equal(skills.length, 2, "Must strictly require source==='skill', rejecting prefix-spoofed prompt/extension commands");

    assert.deepEqual(skills[0], {
      name: "agent-browser",
      description: "Browser automation skill",
      path: "/skills/browser",
    });

    assert.deepEqual(skills[1], {
      name: "nullform/deepwork",
      description: "Namespaced deepwork skill",
      path: "/plugins/deepwork",
    });

    // When pi has no getCommands or throws, must return null
    assert.equal(getEffectiveNativeSkills({}), null);
    assert.equal(getEffectiveNativeSkills({ getCommands: () => { throw new Error("crash"); } }), null);
    assert.equal(getEffectiveNativeSkills({ getCommands: () => "not-array" }), null);
  `);
});

test("Regression: excluded ghost skill and unavailable native roster retain baseline without filesystem guessing", () => {
  runBunTest(`
    const handlers = new Map();
    let loadCatalogCalled = false;
    const mockPiNoSkills = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [], // Empty/disabled native skills
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog() {
        loadCatalogCalled = true;
        return { skills: [{ name: "ghost-skill", description: "not installed" }], fingerprint: "fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide() {
        return {
          status: "ok",
          skill: "ghost-skill",
          route: "cheap",
          archetype: "lookup",
          confidence: 0.95,
          skillConfidence: 0.95,
          routingConfidence: 0.95,
          eligibleScore: 1.0,
          model: "typesafe/jev-1.13",
        };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp", fingerprint: "fp", skillPassed: true, routingPassed: true,
        reportSha256: "sha", archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    const ext = createJevExtension({ core: mockCore });
    await ext(mockPiNoSkills);

    const startHandler = handlers.get("before_agent_start");
    const ctx = { agent: { kind: "main" } };

    const startRes = await startHandler({
      type: "before_agent_start",
      prompt: "Find something",
    }, ctx);

    assert.equal(startRes, undefined, "Empty native roster must not recommend any skills");
    assert.equal(loadCatalogCalled, false, "Must NOT guess or scan filesystem when native roster is empty");
  `);
});

test("Regression: strict score threshold validation rejects low or missing eligibleScore and routingConfidence", () => {
  runBunTest(`
    const handlers = new Map();
    let lastDecision = null;
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async decide() { return lastDecision; },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp", fingerprint: "fp", skillPassed: true, routingPassed: true,
        reportSha256: "sha", archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const startHandler = handlers.get("before_agent_start");
    const toolCallHandler = handlers.get("tool_call");
    const ctx = { agent: { kind: "main" } };

    // 1. before_agent_start: high-confidence safe non-leaf skill hint with baseline route and low eligibleScore is suggested
    lastDecision = {
      status: "ok", skill: "s1", route: "baseline", archetype: "none",
      confidence: 0.95, skillConfidence: 0.95, eligibleScore: 0.10, model: "typesafe/jev-1.13",
    };
    const hintRes = await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx);
    assert.ok(hintRes && hintRes.message, "High-confidence skill must be suggested regardless of cheap-route eligibility");
    assert.match(hintRes.message.content, /Recommended skill: s1/);

    // 2. before_agent_start: low skillConfidence (< 0.80) rejected
    lastDecision = {
      status: "ok", skill: "s1", route: "baseline", archetype: "none",
      confidence: 0.95, skillConfidence: 0.79, eligibleScore: 1.0, model: "typesafe/jev-1.13",
    };
    assert.equal(await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx), undefined);

    // 3. tool_call: eligibleScore < 0.95 rejected
    lastDecision = {
      status: "ok", route: "cheap", archetype: "lookup",
      confidence: 0.95, routingConfidence: 0.95, eligibleScore: 0.94, model: "typesafe/jev-1.13",
    };
    await toolCallHandler({ type: "tool_call", toolName: "task", input: { name: "t1", agent: "task", task: "test" } }, ctx);

    // 4. tool_call: routingConfidence < 0.90 rejected
    lastDecision = {
      status: "ok", route: "cheap", archetype: "lookup",
      confidence: 0.95, routingConfidence: 0.89, eligibleScore: 0.98, model: "typesafe/jev-1.13",
    };
    await toolCallHandler({ type: "tool_call", toolName: "task", input: { name: "t2", agent: "task", task: "test" } }, ctx);

    // 5. tool_call: missing eligibleScore rejected (no status-ok->1.0 fallback)
    lastDecision = {
      status: "ok", route: "cheap", archetype: "lookup",
      confidence: 0.95, routingConfidence: 0.95, model: "typesafe/jev-1.13",
    };
    await toolCallHandler({ type: "tool_call", toolName: "task", input: { name: "t3", agent: "task", task: "test" } }, ctx);
  `);
});

test("Regression: error logs sanitize exception messages and do not dump arbitrary raw secrets", () => {
  runBunTest(`
    const warnings = [];
    const handlers = new Map();
    let credentialReadCount = 0;
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      logger: {
        warn(msg) { warnings.push(msg); },
      },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    };

    const mockCore = {
      async readCredential() {
        credentialReadCount++;
        throw new Error("Failed connecting to OpenRouter with key sk-or-v1-abcdef0123456789 and bearer token-9876543210 and https://user:secretpass@api.openrouter.ai");
      },
      screenTask: () => ({ allowed: true, reason: "" }),
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp", fingerprint: "fp", skillPassed: true, routingPassed: true,
        reportSha256: "sha", archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const startHandler = handlers.get("before_agent_start");
    const ctx = { agent: { kind: "main" } };

    const result = await startHandler({ type: "before_agent_start", prompt: "regular prompt" }, ctx);

    assert.equal(result, undefined, "Handler must safely return undefined on credential error");
    assert.equal(credentialReadCount, 1, "Must reach readCredential exactly once");

    // Behavioral assertion: captured warning logs must never contain raw synthetic secrets or sensitive payloads
    for (const w of warnings) {
      assert.doesNotMatch(w, /sk-or-v1-abcdef0123456789/, "Must not dump raw API key in warning log");
      assert.doesNotMatch(w, /token-9876543210/, "Must not dump bearer token in warning log");
      assert.doesNotMatch(w, /secretpass/, "Must not dump URL credentials in warning log");
    }
  `);
});
test("Regression: sensitive shared context in tool_call retains baseline without calling classifier", () => {
  runBunTest(`
    const handlers = new Map();
    let decideCalled = false;
    let providerRegistered = false;
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      registerProvider() { providerRegistered = true; },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask(text) {
        if (text.includes("SECRET_KEY_12345")) {
          return { allowed: false, reason: "secret" };
        }
        return { allowed: true, reason: "" };
      },
      async decide() {
        decideCalled = true;
        return {
          status: "ok", route: "cheap", archetype: "lookup",
          confidence: 0.95, routingConfidence: 0.95, eligibleScore: 1.0, model: "typesafe/jev-1.13",
        };
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp", fingerprint: "fp", skillPassed: true, routingPassed: true,
        reportSha256: "sha", archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");
    const ctx = {
      agent: { kind: "main" },
      models: {
        resolve: () => ({ id: "nullform-openrouter/cand", cost: { input: 0.1, output: 0.2 } }),
        list: () => [],
      },
    };

    // Shared context contains secret while individual task is a harmless safe lookup
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: {
        context: "Sensitive environment config: SECRET_KEY_12345=xyz",
        tasks: [
          { name: "safe-lookup", agent: "task", task: "Harmless lookup definition" },
        ],
      },
    }, ctx);

    assert.equal(decideCalled, false, "Classifier must not be called when shared context is sensitive");

    // Spawn handler for safe-lookup must retain baseline
    const spawnRes = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base-model"],
      spawnKey: "safe-lookup",
    }, ctx);

    assert.equal(spawnRes, undefined, "Sensitive shared context must cause subagent spawn to retain baseline");
  `);
});

test("Regression: delayed safe decision cannot repopulate cache after subsequent unsafe batch invalidates generation", () => {
  runBunTest(`
    const handlers = new Map();
    let resolveDelayedDecide;
    const mockPi = {
      on(event, handler) { handlers.set(event, handler); },
      registerProvider: () => {},
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    };

    const mockCore = {
      async readCredential() { return "key"; },
      async loadSkillCatalog({ effectiveSkills } = {}) {
        return { skills: effectiveSkills || [{ name: "s1", description: "desc" }], fingerprint: "fp" };
      },
      screenTask(text) {
        if (text.includes("SECRET_KEY_12345")) {
          return { allowed: false, reason: "secret" };
        }
        return { allowed: true, reason: "" };
      },
      decide() {
        return new Promise((resolve) => {
          resolveDelayedDecide = () => resolve({
            status: "ok", route: "cheap", archetype: "lookup",
            confidence: 0.95, routingConfidence: 0.95, eligibleScore: 1.0, model: "typesafe/jev-1.13",
          });
        });
      },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "cand", baselineModel: "base", decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "fp", fingerprint: "fp", skillPassed: true, routingPassed: true,
        reportSha256: "sha", archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
      appendEvent: () => {},
    };

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");
    const ctx = {
      agent: { kind: "main" },
      models: {
        resolve: (id) => (id === "nullform-openrouter/cand" || id === "cand"
          ? { id: "nullform-openrouter/cand", cost: { input: 0.1, output: 0.2 } }
          : { id: "base", cost: { input: 0.5, output: 1.0 } }),
        list: () => [],
      },
    };

    // 1. Start safe first task call with sameName; decide() remains pending
    const firstCallPromise = toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: { name: "sameName", agent: "task", task: "Safe lookup" },
    }, ctx);

    // Wait a tick for firstCallPromise to reach decide()
    await new Promise(r => setTimeout(r, 10));
    assert.ok(typeof resolveDelayedDecide === "function", "First decide call must be pending");

    // 2. Second batch with secret shared context invalidates generation and clears state
    await toolCallHandler({
      type: "tool_call",
      toolName: "task",
      input: {
        context: "Leaked SECRET_KEY_12345 in shared context",
        tasks: [{ name: "sameName", agent: "task", task: "Harmless body" }],
      },
    }, ctx);

    // 3. Resolve delayed first decide call
    resolveDelayedDecide();
    await firstCallPromise;

    // 4. Actual spawn for sameName must retain baseline without model override
    const spawnRes = await spawnHandler({
      type: "before_subagent_spawn",
      agent: "task",
      invocationKind: "task",
      modelRole: "task",
      patterns: ["base"],
      spawnKey: "sameName",
    }, ctx);

    assert.equal(spawnRes, undefined, "Delayed stale generation must not route subagent spawn");
  `);
});
