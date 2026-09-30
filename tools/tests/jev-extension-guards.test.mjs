import test from "node:test";
import { runBunTest } from "./jev-native-test-helpers.mjs";

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

    assert.equal(getEffectiveNativeSkills({}), null);
    assert.equal(getEffectiveNativeSkills({ getCommands: () => { throw new Error("crash"); } }), null);
    assert.equal(getEffectiveNativeSkills({ getCommands: () => "not-array" }), null);
  `);
});

test("Regression: excluded ghost skill and unavailable native roster retain baseline without filesystem guessing", () => {
  runBunTest(`
    const handlers = new Map();
    let loadCatalogCalled = false;
    const mockPiNoSkills = createMockPi(handlers, { getCommands: () => [] });

    const mockCore = createMockCore({
      async loadSkillCatalog() {
        loadCatalogCalled = true;
        return { skills: [{ name: "ghost-skill", description: "not installed" }], fingerprint: "fp" };
      },
      async decide() {
        return {
          status: "ok", skill: "ghost-skill", route: "cheap", archetype: "lookup",
          confidence: 0.95, skillConfidence: 0.95, routingConfidence: 0.95, eligibleScore: 1.0,
          model: "typesafe/jev-1.13",
        };
      },
    });

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
    const mockPi = createMockPi(handlers, {
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    const mockCore = createMockCore({
      async decide() { return lastDecision; },
    });

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
    let credentialReadCount = 0;
    const handlers = new Map();
    const mockPi = createMockPi(handlers, {
      registerProvider: undefined,
      logger: { warn(msg) { warnings.push(msg); } },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    const mockCore = createMockCore({
      async readCredential() {
        credentialReadCount++;
        throw new Error("Failed connecting to OpenRouter with key sk-or-v1-abcdef0123456789 and bearer token-9876543210 and https://user:secretpass@api.openrouter.ai");
      },
    });

    await createJevExtension({ core: mockCore })(mockPi);
    const startHandler = handlers.get("before_agent_start");
    const ctx = { agent: { kind: "main" } };

    const result = await startHandler({ type: "before_agent_start", prompt: "regular prompt" }, ctx);

    assert.equal(result, undefined, "Handler must safely return undefined on credential error");
    assert.equal(credentialReadCount, 1, "Must reach readCredential exactly once");

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
    const mockPi = createMockPi(handlers, {
      registerProvider() { providerRegistered = true; },
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    const mockCore = createMockCore({
      screenTask(text) {
        if (text.includes("SECRET_KEY_12345")) return { allowed: false, reason: "secret" };
        return { allowed: true, reason: "" };
      },
      async decide() {
        decideCalled = true;
        return {
          status: "ok", route: "cheap", archetype: "lookup",
          confidence: 0.95, routingConfidence: 0.95, eligibleScore: 1.0, model: "typesafe/jev-1.13",
        };
      },
    });

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
    const mockPi = createMockPi(handlers, {
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    const mockCore = createMockCore({
      screenTask(text) {
        if (text.includes("SECRET_KEY_12345")) return { allowed: false, reason: "secret" };
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
    });

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
