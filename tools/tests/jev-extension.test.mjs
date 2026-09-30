import test from "node:test";
import { runBunTest } from "./jev-native-test-helpers.mjs";

test("R01: before_agent_start suggests skill via message without altering systemPrompt", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = createMockPi(handlers);
    const mockCore = createMockCore({
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat-fp-1", candidateModel: "google/gemini-3.1-flash-lite",
        baselineModel: "google/gemini-3.8-flash", decisionModel: "typesafe/jev-1.13",
        fingerprint: "fp-1", skillPassed: true, routingPassed: true, reportSha256: "sha-1",
        archetypes: ["lookup"], decisionSnapshots: ["typesafe/jev-1.13"],
      }),
    });

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
    const mockPi = createMockPi(handlers, {
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    let decisionResult = {
      status: "ok", skill: "s1", route: "cheap", archetype: "lookup",
      confidence: 0.9, skillConfidence: 0.9, eligibleScore: 1.0, model: "typesafe/jev-1.13",
    };

    const mockCore = createMockCore({
      screenTask(text) {
        if (text.includes("sk-or-v1-")) return { allowed: false, reason: "secret" };
        return { allowed: true, reason: "" };
      },
      async decide() {
        decideCalls++;
        return decisionResult;
      },
    });

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
      status: "ok", skill: "s1", route: "cheap", archetype: "lookup",
      confidence: 0.9, skillConfidence: 0.9, eligibleScore: 1.0, model: "typesafe/jev-stale-unverified",
    };
    const resStale = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resStale, undefined, "Stale decision snapshot must be rejected");

    // 4. Low skill confidence (< 0.8) rejected
    decisionResult = {
      status: "ok", skill: "s1", route: "cheap", archetype: "lookup",
      confidence: 0.7, skillConfidence: 0.7, eligibleScore: 1.0, model: "typesafe/jev-1.13",
    };
    const resLowConf = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resLowConf, undefined, "Low skill confidence must be rejected");

    // 5. Safe non-leaf skill hint with baseline route and low eligibleScore is suggested
    decisionResult = {
      status: "ok", skill: "s1", route: "baseline", archetype: "none",
      confidence: 0.95, skillConfidence: 0.95, eligibleScore: 0.15, model: "typesafe/jev-1.13",
    };
    const resSafeSkill = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.ok(resSafeSkill && resSafeSkill.message, "High-confidence safe skill must be suggested regardless of cheap-route eligibility");
    assert.match(resSafeSkill.message.content, /Recommended skill: s1/);
  `);
});

test("R02, R07: tool_call caches leaf archetypes for unique names and exact role, rejecting protected roles and clearing ambiguous names", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = createMockPi(handlers);
    let decideParams = [];
    const mockCore = createMockCore({
      async decide(args) {
        decideParams.push(args);
        return {
          status: "ok", route: "cheap", archetype: "lookup", confidence: 0.92,
          eligibleScore: 0.98, routingConfidence: 0.93, model: "typesafe/jev-1.13",
        };
      },
    });

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
  `);
});

test("R02, R07, R08: before_subagent_spawn routes matching spawnKey and role with full selector and fallback, preserving baseline on mismatch", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = createMockPi(handlers);
    const mockCore = createMockCore({
      async decide() {
        return {
          status: "ok", route: "cheap", archetype: "lookup", confidence: 0.92,
          eligibleScore: 0.98, routingConfidence: 0.95, model: "typesafe/jev-1.13",
        };
      },
    });

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");

    const availableModel = { id: "nullform-openrouter/cand-model", cost: { input: 0.05, output: 0.2 } };
    const baselineModel = { id: "base-model", cost: { input: 0.15, output: 0.6 } };

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
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: undefined,
      patterns: ["anthropic/claude-3-5-sonnet"], spawnKey: "search-leaf",
    }, ctx);
    assert.equal(explicitSpawn, undefined, "Explicit selector must preserve baseline");

    // 2. Eval invocation kind must NOT be rerouted
    const evalSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "eval", modelRole: "task",
      patterns: ["base-model"], spawnKey: "search-leaf",
    }, ctx);
    assert.equal(evalSpawn, undefined, "Eval invocation kind must preserve baseline");

    // 3. Protected role must NOT be rerouted
    const protectedSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "oracle", invocationKind: "task", modelRole: "oracle",
      patterns: ["base-model"], spawnKey: "search-leaf",
    }, ctx);
    assert.equal(protectedSpawn, undefined, "Protected role must preserve baseline");

    // 4. Role mismatch must NOT be rerouted
    const mismatchSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "sonic", invocationKind: "task", modelRole: "sonic",
      patterns: ["base-model"], spawnKey: "mismatch-leaf",
    }, ctx);
    assert.equal(mismatchSpawn, undefined, "Role mismatch must preserve baseline");

    // 5. Positive routing with matching spawnKey and role returns full selector and patterns fallback
    const validSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "search-leaf",
    }, ctx);
    assert.ok(validSpawn, "Matching spawnKey and role must route");
    const routedModels = Array.isArray(validSpawn.model) ? validSpawn.model : [validSpawn.model];
    assert.equal(routedModels[0], "nullform-openrouter/cand-model");
    assert.ok(routedModels.includes("base-model"), "Must preserve original patterns fallback");
    assert.match(validSpawn.note, /lookup/);

    // 6. Consume once: second spawn with same key must NOT route
    const secondSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "search-leaf",
    }, ctx);
    assert.equal(secondSpawn, undefined, "Decisions must be consumed once");

    // 7. Verify that mismatch-leaf was NOT consumed by the earlier role mismatch
    const recoveredSpawn = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "mismatch-leaf",
    }, ctx);
    assert.ok(recoveredSpawn, "Mismatch must not destroy cached decision for valid subsequent match");
  `);
});

test("R04: candidate model availability, observed price metadata, and baseline comparison check", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = createMockPi(handlers);
    const mockCore = createMockCore({
      async decide() {
        return {
          status: "ok", route: "cheap", archetype: "lookup", confidence: 0.9,
          eligibleScore: 0.98, routingConfidence: 0.95, model: "typesafe/jev-1.13",
        };
      },
    });

    await createJevExtension({ core: mockCore })(mockPi);
    const toolCallHandler = handlers.get("tool_call");
    const spawnHandler = handlers.get("before_subagent_spawn");

    // 1. Missing candidate model in ctx.models preserves baseline
    const emptyCtx = {
      agent: { kind: "main" },
      models: { resolve: () => undefined, list: () => [] },
    };
    await toolCallHandler({
      type: "tool_call", toolName: "task",
      input: { name: "task-missing-model", agent: "task", task: "lookup" },
    }, emptyCtx);

    const resMissing = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "task-missing-model",
    }, emptyCtx);
    assert.equal(resMissing, undefined, "Missing model in registry must preserve baseline");

    // 2. Candidate model with non-positive cost preserves baseline
    const zeroCostModel = { id: "nullform-openrouter/cand-model", cost: { input: 0, output: 0 } };
    const zeroCostCtx = {
      agent: { kind: "main" },
      models: { resolve: () => zeroCostModel, list: () => [zeroCostModel] },
    };
    await toolCallHandler({
      type: "tool_call", toolName: "task",
      input: { name: "task-zero-cost", agent: "task", task: "lookup" },
    }, zeroCostCtx);

    const resZeroCost = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "task-zero-cost",
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
      type: "tool_call", toolName: "task",
      input: { name: "task-expensive", agent: "task", task: "lookup" },
    }, expensiveCtx);

    const resExpensive = await spawnHandler({
      type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "task",
      patterns: ["base-model"], spawnKey: "task-expensive",
    }, expensiveCtx);
    assert.equal(resExpensive, undefined, "Candidate cost >= baseline cost must preserve baseline");
  `);
});

test("R04: automatic candidate provider registration with observed catalog prices", () => {
  runBunTest(`
    const registered = [];
    const mockPi = {
      on: () => {},
      registerProvider(name, config) { registered.push({ name, config }); },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    };

    const mockCore = createMockCore({
      async readCredential() { return "sk-openrouter-dummy"; },
      readPolicy: () => ({
        version: 1, enabled: true, expiresAt: new Date(Date.now() + 86400000).toISOString(),
        candidateModel: "nullform-openrouter/google/gemini-3.1-flash-lite",
        baselineModel: "google/gemini-3.8-flash",
        decisionModel: "typesafe/jev-1.13",
        catalogFingerprint: "cat-fp-1",
        fingerprint: "fp", skillPassed: true, routingPassed: true, reportSha256: "sha", archetypes: ["lookup"],
        decisionSnapshots: ["typesafe/jev-1.13"],
        modelPrices: {
          "google/gemini-3.1-flash-lite": { prompt: 0.00000025, completion: 0.0000015 },
          "google/gemini-3.8-flash": { prompt: 0.00000075, completion: 0.00000375 },
        },
      }),
    });

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
    const mockPi = createMockPi(handlers);
    let decideCalls = 0;
    const mockCore = createMockCore({
      async loadSkillCatalog() {
        return { skills: [{ name: "s1", description: "desc" }], fingerprint: "drifted-cat-fp" };
      },
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
    });

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
