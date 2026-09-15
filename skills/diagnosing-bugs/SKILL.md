---
name: diagnosing-bugs
description: 6-phase scientific bug diagnosis workflow. Requires red feedback loop before code inspection.
---

# Scientific Bug Diagnosis Protocol

Eliminate guesswork and superficial symptom patching.

## The Invariant Rule
**NEVER inspect or modify implementation code before Phase 1 is complete.**

## Phase 1: Build a Feedback Loop
- Construct a minimal command, script, or automated test that fails on the reported bug (Red-capable).
- The reproduction must run quickly (<5 seconds) and be deterministic.

## Phase 2: Minimise the Reproduction
- Cut away irrelevant dependencies, mocks, fixtures, and input parameters.
- Keep only the irreducible, load-bearing code and data.

## Phase 3: Formulate 3–5 Ranked Falsifiable Hypotheses
- State hypotheses explicitly before opening or changing source code:
  - *Hypothesis A*: If root cause is X, changing Y will produce Z.
  - *Hypothesis B*: If root cause is M, changing N will produce P.

## Phase 4: Targeted Instrumentation
- Insert debug logs tagged with a unique identifier: `[DEBUG-<4hex>]` (e.g. `[DEBUG-f1a2]`).
- Run the minimal loop to confirm or falsify each hypothesis.

## Phase 5: Seam Verification & Fix
- Implement the root cause fix.
- Verify that a natural architectural seam exists. If unit testing requires ugly monkey-patching, identify the missing seam (interface/dependency injection) and fix the seam first.

## Phase 6: Purge & Regression Lock
- Grep and delete all `[DEBUG-*]` statements.
- Commit the minimal reproduction as a permanent regression test.
