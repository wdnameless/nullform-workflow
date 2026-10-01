import test from "node:test";
import { runBunTest } from "./jev-native-test-helpers.mjs";

test("R01: before_agent_start suggests skill via message without altering systemPrompt", () => {
  runBunTest(`
    const handlers = new Map();
    const mockPi = createMockPi(handlers);
    const mockCore = createMockCore({
      readPolicy: () => ({
        version: 2,
        enabled: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        catalogFingerprint: "cat-fp-1",
        baselineModel: "google/gemini-3.8-flash",
        decisionModel: "typesafe/jev-1.13",
        fingerprint: "fp-1",
        reportSha256: "sha-1",
        decisionSnapshots: ["typesafe/jev-1.13"],
        skillPassed: true,
      }),
    });

    const ext = createJevExtension({ core: mockCore });
    await ext(mockPi);

    const startHandler = handlers.get("before_agent_start");
    assert.ok(startHandler, "before_agent_start must be registered");

    const ctx = {
      agent: { kind: "main" },
    };

    const result = await startHandler({
      type: "before_agent_start",
      prompt: "Find the declaration of test symbol",
      systemPrompt: ["base system prompt"],
    }, ctx);

    assert.ok(result, "Expected result from before_agent_start");
    assert.equal(result.systemPrompt, undefined, "Must NOT return systemPrompt");
    assert.ok(result.message, "Must return message payload");
    assert.equal(result.message.content, "[JEV Assistance] Recommended skill: test-skill");
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
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.9,
      model: "typesafe/jev-1.13",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
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
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.9,
      model: "typesafe/jev-stale-unverified",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
    };
    const resStale = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resStale, undefined, "Stale decision snapshot must be rejected");

    // 4. Low skill confidence (< 0.8) rejected
    decisionResult = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.7,
      model: "typesafe/jev-1.13",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
    };
    const resLowConf = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resLowConf, undefined, "Low skill confidence must be rejected");

    // 5. Valid high-confidence suggestion returned
    decisionResult = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.95,
      model: "typesafe/jev-1.13",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
    };
    const resSafeSkill = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.ok(resSafeSkill && resSafeSkill.message, "High-confidence skill must be suggested");
    assert.equal(resSafeSkill.message.content, "[JEV Assistance] Recommended skill: s1");
  `);
});

test("R01, R07, R08: before_agent_start honors opt-out, missing credentials, fallback status, and none choice", () => {
  runBunTest(`
    const handlers = new Map();
    let decideCalls = 0;
    const mockPi = createMockPi(handlers, {
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    let currentCredential = "valid-key";
    let policyActive = true;
    let decisionResult = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.95,
      model: "typesafe/jev-1.13",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
    };

    const mockCore = createMockCore({
      async readCredential() { return currentCredential; },
      readPolicy() {
        if (!policyActive) return null;
        return {
          version: 2,
          enabled: true,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          catalogFingerprint: "cat-fp-1",
          baselineModel: "google/gemini-3.8-flash",
          decisionModel: "typesafe/jev-1.13",
          fingerprint: "fp-1",
          reportSha256: "sha-1",
          decisionSnapshots: ["typesafe/jev-1.13"],
          skillPassed: true,
        };
      },
      async decide() {
        decideCalls++;
        return decisionResult;
      },
    });

    await createJevExtension({ core: mockCore })(mockPi);
    const handler = handlers.get("before_agent_start");
    const mainCtx = { agent: { kind: "main" } };

    // 1. Opt-out (policy is null) retains baseline
    policyActive = false;
    const resOptOut = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resOptOut, undefined, "Opt-out must retain baseline");
    assert.equal(decideCalls, 0);
    policyActive = true;

    // 2. Missing credential retains baseline
    currentCredential = null;
    const resNoKey = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resNoKey, undefined, "Missing credential must retain baseline");
    assert.equal(decideCalls, 0);
    currentCredential = "valid-key";

    // 3. Decision choosing 'none' (skill is null) returns no hint
    decisionResult = {
      status: "ok",
      reason: "no_skill",
      skill: null,
      confidence: 0.92,
      model: "typesafe/jev-1.13",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
    };
    const resNone = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resNone, undefined, "Classifier choosing none must return no hint");
    assert.equal(decideCalls, 1);

    // 4. Decision with fallback status returns no hint
    decisionResult = {
      status: "fallback",
      reason: "timeout",
      skill: null,
      confidence: 0,
      model: null,
    };
    const resFallback = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resFallback, undefined, "Fallback status must return no hint");
    assert.equal(decideCalls, 2);
  `);
});

test("R01, R04: catalog fingerprint mismatch retains baseline", () => {
  runBunTest(`
    const handlers = new Map();
    let decideCalls = 0;
    const mockPi = createMockPi(handlers, {
      getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
    });

    const mockCore = createMockCore({
      readPolicy() {
        return {
          version: 2,
          enabled: true,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          catalogFingerprint: "cat-fp-different",
          baselineModel: "google/gemini-3.8-flash",
          decisionModel: "typesafe/jev-1.13",
          fingerprint: "fp-1",
          reportSha256: "sha-1",
          decisionSnapshots: ["typesafe/jev-1.13"],
          skillPassed: true,
        };
      },
      async decide() {
        decideCalls++;
        return { status: "ok", skill: "s1", confidence: 0.95, model: "typesafe/jev-1.13" };
      },
    });

    await createJevExtension({ core: mockCore })(mockPi);
    const handler = handlers.get("before_agent_start");
    const mainCtx = { agent: { kind: "main" } };

    const resMismatch = await handler({ type: "before_agent_start", prompt: "valid prompt" }, mainCtx);
    assert.equal(resMismatch, undefined, "Catalog fingerprint mismatch must retain baseline");
    assert.equal(decideCalls, 0, "Decide must not be called when catalog fingerprint mismatches");
  `);
});
