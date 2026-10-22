import test from "node:test";
import assert from "node:assert/strict";
import { assignChecker, deriveModelFamily } from "../oracle-model.mjs";
import { normalizeUsage } from "../usage-normalize.mjs";
import { withBreaker, defaultIsRetryable } from "../fallback.mjs";

// Slice A (R01/R02/R07): model diversity gate, usage normalization, circuit breaker failback.

// --- R01: Checker assignment diversity ---

test("R01 assignChecker: accepts first candidate of a different model family", () => {
  const chosen1 = assignChecker({
    writerFamily: "claude",
    candidates: ["claude-3-5-sonnet", "openai/gpt-4o", "gemini-1.5-pro"],
  });
  assert.equal(chosen1, "openai/gpt-4o");

  const chosen2 = assignChecker({
    writerFamily: "gpt-4o",
    candidates: ["openai/gpt-4o-mini", "anthropic/claude-3-7-sonnet", "gemini-2.0-flash"],
  });
  assert.equal(chosen2, "anthropic/claude-3-7-sonnet");

  const chosen3 = assignChecker({
    writerFamily: "anthropic/claude-3-5-haiku",
    candidates: ["google/gemini-1.5-flash", "openai/gpt-4o"],
  });
  assert.equal(chosen3, "google/gemini-1.5-flash");
});

test("R01 assignChecker: refuses and throws naming the conflicting family when all candidates share family", () => {
  assert.throws(
    () => {
      assignChecker({
        writerFamily: "claude",
        candidates: ["claude-3-5-sonnet", "anthropic/claude-3-opus", "claude-haiku"],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /claude/i);
      return true;
    }
  );

  assert.throws(
    () => {
      assignChecker({
        writerFamily: "gpt-4o",
        candidates: ["openai/gpt-4o-mini", "gpt-3.5-turbo"],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gpt/i);
      return true;
    }
  );

  assert.throws(
    () => {
      assignChecker({
        writerFamily: "gemini",
        candidates: [],
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gemini/i);
      return true;
    }
  );
});

// --- R02: Usage normalization per provider ---

test("R02 normalizeUsage: throws on unknown provider", () => {
  assert.throws(() => normalizeUsage("bedrock", {}), /Unknown provider/);
  assert.throws(() => normalizeUsage("azure", {}), /Unknown provider/);
  assert.throws(() => normalizeUsage(null, {}), /Unknown provider/);
});

test("R02 normalizeUsage: Anthropic additive cache semantics and full counters", () => {
  const raw = {
    input_tokens: 1000,
    output_tokens: 250,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 150,
  };

  const { totals, unknown } = normalizeUsage("anthropic", raw);
  assert.equal(totals.input, 1000);
  assert.equal(totals.output, 250);
  assert.equal(totals.cacheRead, 300);
  assert.equal(totals.cacheWrite, 150);
  // Additive: 1000 + 250 + 300 + 150 = 1700
  assert.equal(totals.totalTokens, 1700);
  assert.equal(totals.total, 1700);
  assert.deepEqual(unknown, []);
});

test("R02 normalizeUsage: Anthropic unreported cache fields become UNKNOWN, never 0", () => {
  const raw = {
    input_tokens: 800,
    output_tokens: 120,
  };

  const { totals, unknown } = normalizeUsage("anthropic", raw);
  assert.equal(totals.input, 800);
  assert.equal(totals.output, 120);
  assert.equal(totals.cacheRead, "UNKNOWN");
  assert.equal(totals.cacheWrite, "UNKNOWN");
  // Total derived from reported fields without phantom 0s
  assert.equal(totals.totalTokens, 920);
  assert.ok(unknown.includes("cacheRead"));
  assert.ok(unknown.includes("cacheWrite"));
});

test("R02 normalizeUsage: Anthropic respects reported 0 cache fields vs UNKNOWN gap", () => {
  const raw = {
    input_tokens: 400,
    output_tokens: 80,
    cache_read_input_tokens: 0,
  };

  const { totals, unknown } = normalizeUsage("anthropic", raw);
  assert.equal(totals.input, 400);
  assert.equal(totals.output, 80);
  assert.equal(totals.cacheRead, 0);
  assert.equal(totals.cacheWrite, "UNKNOWN");
  assert.deepEqual(unknown, ["cacheWrite"]);
});

test("R02 normalizeUsage: OpenAI subset cache semantics prevents double counting", () => {
  const raw = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: {
      cached_tokens: 350,
    },
  };

  const { totals, unknown } = normalizeUsage("openai", raw);
  assert.equal(totals.input, 1000);
  assert.equal(totals.output, 200);
  assert.equal(totals.cacheRead, 350);
  // OpenAI API does not report cache write, so it must be UNKNOWN
  assert.equal(totals.cacheWrite, "UNKNOWN");
  // Subset semantics: total = prompt + completion = 1200, NOT 1200 + 350 = 1550 (no double-counting)
  assert.equal(totals.totalTokens, 1200);
  assert.equal(totals.total, 1200);
  assert.deepEqual(unknown, ["cacheWrite"]);
});

test("R02 normalizeUsage: OpenAI unreported cache fields become UNKNOWN", () => {
  const raw = {
    prompt_tokens: 600,
    completion_tokens: 90,
  };

  const { totals, unknown } = normalizeUsage("openai", raw);
  assert.equal(totals.input, 600);
  assert.equal(totals.output, 90);
  assert.equal(totals.cacheRead, "UNKNOWN");
  assert.equal(totals.cacheWrite, "UNKNOWN");
  assert.equal(totals.totalTokens, 690);
  assert.ok(unknown.includes("cacheRead"));
  assert.ok(unknown.includes("cacheWrite"));
});

test("R02 normalizeUsage: OpenAI flat cached_tokens and explicit total_tokens fixture", () => {
  const raw = {
    prompt_tokens: 500,
    completion_tokens: 100,
    total_tokens: 600,
    cached_tokens: 150,
  };

  const { totals, unknown } = normalizeUsage("openai", raw);
  assert.equal(totals.input, 500);
  assert.equal(totals.output, 100);
  assert.equal(totals.cacheRead, 150);
  assert.equal(totals.cacheWrite, "UNKNOWN");
  assert.equal(totals.totalTokens, 600);
  assert.deepEqual(unknown, ["cacheWrite"]);
});

// --- R07: Circuit breaker lifecycle & failback ---

test("R07 defaultIsRetryable matches 429 and 503 shapes, refuses 400/500/syntax", () => {
  assert.equal(defaultIsRetryable({ status: 429 }), true);
  assert.equal(defaultIsRetryable({ status: 503 }), true);
  assert.equal(defaultIsRetryable({ statusCode: 429 }), true);
  assert.equal(defaultIsRetryable({ code: 503 }), true);
  assert.equal(defaultIsRetryable({ code: "429" }), true);
  assert.equal(defaultIsRetryable(new Error("Rate limit exceeded 429")), true);
  assert.equal(defaultIsRetryable(new Error("Service unavailable 503")), true);

  assert.equal(defaultIsRetryable({ status: 400 }), false);
  assert.equal(defaultIsRetryable({ status: 500 }), false);
  assert.equal(defaultIsRetryable(new Error("Invalid JSON token")), false);
  assert.equal(defaultIsRetryable(null), false);
});

test("R07 withBreaker: opens after threshold consecutive retryable failures, routes to reserve, closes after probe", async () => {
  let primaryCalls = 0;
  let reserveCalls = 0;
  let shouldPrimaryFail = true;

  const primary = async (arg = "default") => {
    primaryCalls++;
    if (shouldPrimaryFail) {
      const err = new Error("Rate limit");
      err.status = 429;
      throw err;
    }
    return `primary-${arg}`;
  };

  const reserve = async (arg = "default") => {
    reserveCalls++;
    return `reserve-${arg}`;
  };

  const breaker = withBreaker(primary, { reserve, threshold: 3 });

  // Initial state: closed
  assert.equal(breaker.isOpen, false);
  assert.equal(breaker.failures, 0);

  // Call 1: retryable failure 1
  await assert.rejects(async () => breaker("c1"), (err) => err.status === 429);
  assert.equal(breaker.failures, 1);
  assert.equal(breaker.isOpen, false);

  // Call 2: retryable failure 2
  await assert.rejects(async () => breaker("c2"), (err) => err.status === 429);
  assert.equal(breaker.failures, 2);
  assert.equal(breaker.isOpen, false);

  // Call 3: retryable failure 3 -> hits threshold 3, opens breaker
  await assert.rejects(async () => breaker("c3"), (err) => err.status === 429);
  assert.equal(breaker.failures, 3);
  assert.equal(breaker.isOpen, true);

  // Call 4: Breaker is open, routes to reserve
  const resReserve1 = await breaker("c4");
  assert.equal(resReserve1, "reserve-c4");
  assert.equal(reserveCalls, 1);
  // Primary was NOT called for call 4
  assert.equal(primaryCalls, 3);

  // Call 5: Breaker remains open, routes to reserve
  const resReserve2 = await breaker("c5");
  assert.equal(resReserve2, "reserve-c5");
  assert.equal(reserveCalls, 2);
  assert.equal(primaryCalls, 3);

  // Probe fails -> breaker remains open
  await assert.rejects(async () => breaker.probe("test-fail"));
  assert.equal(breaker.isOpen, true);

  // Primary recovers
  shouldPrimaryFail = false;

  // Successful probe -> breaker closes
  const probeRes = await breaker.probe("probe-ok");
  assert.equal(probeRes, "primary-probe-ok");
  assert.equal(breaker.isOpen, false);
  assert.equal(breaker.failures, 0);

  // Subsequent calls route to primary again
  const resPrimary = await breaker("resumed");
  assert.equal(resPrimary, "primary-resumed");
  assert.equal(reserveCalls, 2); // Reserve calls didn't increase
});

test("R07 withBreaker: non-retryable errors pass through without tripping breaker", async () => {
  let primaryCalls = 0;

  const primary = async () => {
    primaryCalls++;
    const err = new Error("Bad Request");
    err.status = 400;
    throw err;
  };

  const reserve = async () => "reserve-val";

  const breaker = withBreaker(primary, { reserve, threshold: 2 });

  // Call 1: non-retryable error
  await assert.rejects(async () => breaker(), (err) => err.status === 400);
  assert.equal(breaker.failures, 0);
  assert.equal(breaker.isOpen, false);

  // Call 2: non-retryable error
  await assert.rejects(async () => breaker(), (err) => err.status === 400);
  assert.equal(breaker.failures, 0);
  assert.equal(breaker.isOpen, false);
});
