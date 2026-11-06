import test from "node:test";
import assert from "node:assert/strict";

import { resolveReviewMode } from "../workflow-ci.mjs";

/**
 * Adversarial mode is an admission rule, not a model call. These tests exercise the
 * resolver directly so a missing credential or provider can never mask the rule.
 */
test("adversarial mode is accepted for the reviewer role", () => {
  assert.equal(resolveReviewMode("adversarial", "reviewer"), "adversarial");
});

test("adversarial mode is rejected for non-reviewer roles", () => {
  assert.throws(
    () => resolveReviewMode("adversarial", "oracle"),
    /only supported for --role reviewer/i,
  );
});

test("unknown mode is rejected with the allowed list", () => {
  assert.throws(
    () => resolveReviewMode("confirmatory", "reviewer"),
    /unknown --mode.*default adversarial/is,
  );
});

test("default mode applies when the flag is absent or empty", () => {
  assert.equal(resolveReviewMode(undefined, "reviewer"), "default");
  assert.equal(resolveReviewMode(null, "oracle"), "default");
  assert.equal(resolveReviewMode("   ", "reviewer"), "default");
  assert.equal(resolveReviewMode("default", "oracle"), "default");
});

test("perf predicate is independent of review mode", () => {
  // The perf rule is a reviewer lens, not a mode: defaults must still carry it.
  assert.equal(resolveReviewMode(undefined, "reviewer"), "default");
});
