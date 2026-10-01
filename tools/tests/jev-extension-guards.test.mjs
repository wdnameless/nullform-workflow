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
          status: "ok",
          reason: "matched",
          skill: "ghost-skill",
          confidence: 0.95,
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

test("Regression: strict confidence threshold validation requires confidence >= 0.80 and <= 1.0", () => {
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
    const ctx = { agent: { kind: "main" } };

    // 1. confidence 0.95 accepted
    lastDecision = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.95,
      model: "typesafe/jev-1.13",
    };
    const hintRes = await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx);
    assert.ok(hintRes && hintRes.message, "High-confidence skill must be suggested");
    assert.equal(hintRes.message.content, "[JEV Assistance] Recommended skill: s1");

    // 2. confidence 0.79 rejected (< 0.80)
    lastDecision = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 0.79,
      model: "typesafe/jev-1.13",
    };
    assert.equal(await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx), undefined);

    // 3. confidence NaN rejected
    lastDecision = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: NaN,
      model: "typesafe/jev-1.13",
    };
    assert.equal(await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx), undefined);

    // 4. confidence > 1.0 rejected
    lastDecision = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      confidence: 1.05,
      model: "typesafe/jev-1.13",
    };
    assert.equal(await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx), undefined);

    // 5. missing confidence rejected
    lastDecision = {
      status: "ok",
      reason: "matched",
      skill: "s1",
      model: "typesafe/jev-1.13",
    };
    assert.equal(await startHandler({ type: "before_agent_start", prompt: "task text" }, ctx), undefined);
  `);
});

test("Regression: error logs sanitize exception messages and do not dump arbitrary raw secrets", () => {
  runBunTest(`
    const warnings = [];
    let credentialReadCount = 0;
    const handlers = new Map();
    const mockPi = createMockPi(handlers, {
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

test("Regression: opt-out in cwd suppresses before_agent_start without classifier calls", () => {
  runBunTest(`
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const tmp = mkdtempSync(join(tmpdir(), "jev-optout-test-"));
    try {
      writeFileSync(join(tmp, ".jev-optout"), "", "utf8");

      const handlers = new Map();
      let decideCalls = 0;
      const mockPi = createMockPi(handlers, {
        getCommands: () => [{ source: "skill", name: "skill:s1", description: "desc" }],
      });

      const mockCore = createMockCore({
        async decide() {
          decideCalls++;
          return { status: "ok", reason: "matched", skill: "s1", confidence: 0.95, model: "typesafe/jev-1.13" };
        },
      });

      await createJevExtension({ core: mockCore, cwd: tmp })(mockPi);
      const startHandler = handlers.get("before_agent_start");
      const ctx = { agent: { kind: "main" }, cwd: tmp };

      const res = await startHandler({ type: "before_agent_start", prompt: "safe prompt" }, ctx);
      assert.equal(res, undefined, "Opt-out in cwd must suppress skill suggestion");
      assert.equal(decideCalls, 0, "Classifier must not be called when cwd is opted out");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  `);
});
