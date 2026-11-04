import test from "node:test";
import assert from "node:assert/strict";
import { resolveOracleModel } from "../oracle-model.mjs";
const assignChecker = (opts) => resolveOracleModel(opts);

// Slice A (R01): model diversity gate.

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
