import test from "node:test";
import assert from "node:assert/strict";
import { classify, waitForState } from "../supervision.mjs";

test("classify: first matching rule wins when several rules match the tail", () => {
  const manifest = [
    { id: "rule-working", state: "working", pattern: "building|compiling" },
    { id: "rule-blocked", state: "blocked", pattern: "prompt|waiting" },
    { id: "rule-idle", state: "idle", pattern: "finished|done" },
  ];

  const tail = [
    "compiling module B",
    "waiting for user confirmation",
  ];

  // rule-working appears first in manifest and matches "compiling module B"
  assert.equal(classify(manifest, tail), "working");

  // Reversed order manifest: rule-blocked appears first and should win
  const reversed = [
    { id: "rule-blocked", state: "blocked", pattern: "prompt|waiting" },
    { id: "rule-working", state: "working", pattern: "building|compiling" },
  ];
  assert.equal(classify(reversed, tail), "blocked");
});

test("classify: returns idle when no rules match the tail or tail is empty", () => {
  const manifest = [
    { id: "rule-working", state: "working", pattern: "compiling" },
    { id: "rule-blocked", state: "blocked", pattern: "prompt" },
  ];

  assert.equal(classify(manifest, ["everything is quiet", "nothing to do"]), "idle");
  assert.equal(classify(manifest, []), "idle");
  assert.equal(classify(manifest), "idle");
  assert.equal(classify([], ["compiling"]), "idle");
});

test("classify: matches pattern across full text as well as per line", () => {
  const manifest = [
    { id: "multi-line-rule", state: "blocked", pattern: "step 1[\\s\\S]*step 2" },
  ];

  assert.equal(classify(manifest, ["step 1", "intermediate", "step 2"]), "blocked");
});

test("classify: throws on invalid manifest entry naming the rule id", () => {
  // Bad state
  const badStateManifest = [
    { id: "rule-valid", state: "working", pattern: "compiling" },
    { id: "rule-bad-state", state: "unknown_state", pattern: "prompt" },
  ];
  assert.throws(
    () => classify(badStateManifest, ["prompt"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /rule-bad-state/);
      return true;
    }
  );

  // Uncompilable RegExp pattern
  const badPatternManifest = [
    { id: "rule-bad-regex", state: "blocked", pattern: "[unclosed-group(" },
  ];
  assert.throws(
    () => classify(badPatternManifest, ["test"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /rule-bad-regex/);
      return true;
    }
  );

  // Non-string pattern
  const nonStringPatternManifest = [
    { id: "rule-non-string", state: "working", pattern: 12345 },
  ];
  assert.throws(
    () => classify(nonStringPatternManifest, ["test"]),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /rule-non-string/);
      return true;
    }
  );

  // Non-array manifest
  assert.throws(() => classify(null, []), /Manifest must be an array/);
});

test("waitForState: resolves with observed wanted state on transition", async () => {
  let counter = 0;
  // Transitions from working -> working -> idle
  const sample = () => {
    counter++;
    if (counter >= 3) return "idle";
    return "working";
  };

  const state = await waitForState(sample, "idle", { timeoutMs: 500, intervalMs: 20 });
  assert.equal(state, "idle");
  assert.ok(counter >= 3);
});

test("waitForState: supports async sample function", async () => {
  let counter = 0;
  const sample = async () => {
    counter++;
    await new Promise((r) => setTimeout(r, 5));
    if (counter >= 2) return "idle";
    return "working";
  };

  const state = await waitForState(sample, "idle", { timeoutMs: 500, intervalMs: 15 });
  assert.equal(state, "idle");
});

test("waitForState: supports want as an array of target states", async () => {
  let step = 0;
  const sample = () => {
    step++;
    if (step >= 2) return "blocked";
    return "working";
  };

  const state = await waitForState(sample, ["blocked", "idle"], { timeoutMs: 500, intervalMs: 20 });
  assert.equal(state, "blocked");
});

test("waitForState: resolves immediately if initial state matches want", async () => {
  let called = 0;
  const sample = () => {
    called++;
    return "blocked";
  };

  const state = await waitForState(sample, "blocked", { timeoutMs: 100, intervalMs: 25 });
  assert.equal(state, "blocked");
  assert.equal(called, 1);
});

test("waitForState: rejects with Error('timeout') after timeoutMs", async () => {
  const sample = () => "working";

  await assert.rejects(
    async () => {
      await waitForState(sample, "idle", { timeoutMs: 50, intervalMs: 15 });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "timeout");
      return true;
    }
  );
});

test("waitForState: rejects if sample throws an unexpected error", async () => {
  const brokenSample = () => {
    throw new Error("sampling failure");
  };

  await assert.rejects(
    async () => {
      await waitForState(brokenSample, "idle", { timeoutMs: 200, intervalMs: 20 });
    },
    /sampling failure/
  );
});

test("waitForState: validates sample parameter is a function", async () => {
  assert.throws(
    () => waitForState("not-a-function", "idle"),
    /sample must be a function/
  );
});
