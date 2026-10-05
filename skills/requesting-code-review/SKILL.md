---
name: requesting-code-review
description: Dispatch code review subagent to catch issues before they cascade. Use after completing tasks, before merging, or when stuck. Integrates with git to review specific commit ranges.
---

# Requesting Code Review

Dispatch the `reviewer` subagent to catch implementation defects, integration drops, and unnecessary complexity before they cascade.

Core principle: Review early, review often with diff and consumer context.

## Role Separation: Reviewer vs Oracle

- **`reviewer` (Implementation Review)**: Dispatched during development (Wave 3 / task completion) to inspect code patches, diffs, and consuming-side dispatch points. Evaluates concrete bugs, security issues, cross-boundary routing, and produces a tagged delete-list (`delete:`, `stdlib:`, `native:`, `yagni:`, `shrink:`) for Stage B simplification.
- **`oracle` (Blind Acceptance)**: Reserved strictly for final acceptance (Wave 4). Operates blind to plans, proposals, and tickets; evaluates only the original requirements manifest (`manifest.md`) and the running product/runtime. Never dispatch `oracle` for patch code-review.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development (T2/T3 workflows)
- Before Stage B simplification (reviewer delete-list is Stage B's input)
- Before final blind oracle acceptance and merge

**Optional but valuable:**
- When stuck (fresh perspective on edge cases)
- Before refactoring (baseline check)
- After fixing complex bug (verifying consumer routing and regression tests)

## How to Request

1. Identify patch range and consumer context:
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or merge-base with target branch
HEAD_SHA=$(git rev-parse HEAD)
git diff "$BASE_SHA" "$HEAD_SHA"
```

2. Dispatch `reviewer` subagent (use Task tool with `reviewer` role):
Provide:
- `{BASE_SHA}..{HEAD_SHA}` — commit range and patch diff
- `{MODIFIED_FILES}` — paths of changed files
- `{CONSUMER_CONTEXT}` — consuming-side dispatch points (routers, switches, handlers receiving new types/variants)
- `{DESCRIPTION}` — what changed and why

In heavy/program workflows, recorded native review execution is captured via:
```bash
node tools/workflow.mjs review-run --role reviewer --change <change-id> --model <provider/model> --base-ref <review-base>
```
The reviewed base is explicit; do not guess `HEAD~1` for recorded provenance. The recorded-run tools carry relevant source/patch/manifest; return one terminal assistant JSON object with `findings`, `overall_correctness` (`correct` or `incorrect`), `overall_explanation`, and `overall_confidence_score` (0–1), not incremental yield calls.

3. Act on feedback:
- **P0 (Blocker) / P1 (High)**: fix immediately
- **P2 (Medium)**: fix before completing the slice
- **Lean delete-list**: feed into Stage B simplification (`net: -N lines possible` or `Lean already.`)
- Push back if reviewer is factually wrong (with reproducible code/tests)

## Example

```
[Just completed Task 2: Add conversation index verification]

You: Let me dispatch the reviewer subagent to check the patch and consumer dispatch.

BASE_SHA=$(git rev-parse HEAD~1)
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch reviewer subagent]
  DIFF: git diff a7981ec..3df7661
  MODIFIED_FILES: src/index-verify.ts, src/index-repair.ts
  CONSUMER_CONTEXT: src/cli-dispatch.ts (routes verification commands)
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types

[Reviewer returns]:
  Findings:
    - [P1] src/cli-dispatch.ts: line 42 does not route repair action for corrupt-header error variant
    - [P2] src/index-verify.ts: magic number 100 in progress reporting loop
  Simplest solution (Lean lens):
    - stdlib: replace custom string pad in src/index-verify.ts:18 with String.prototype.padStart
    - net: -8 lines possible
  Verdict: incorrect (P1 blocks completion)

You: [Fix dispatch routing for corrupt-header, replace pad helper, verify tests]
You: [Proceed to Stage B simplification using reviewer delete-list]
```
## PR Body (before requesting merge)

Every PR going to `main` carries a body in `.github/pull_request_template.md` shape:
Summary → Evidence (before → after) → Merge danger → Blast radius.
A PR without runtime evidence is not ready for review — same bar as the oracle
evidence protocol (`agent/agents/oracle.md` § EVIDENCE PROTOCOL).

- **Summary**: 2-5 sentences, what + why. Refactors name the merged concepts.
- **Evidence**: exact command + raw output/counts on a real path
  (e.g. `node --test tools/tests/<name>.test.mjs` → `pass 12, fail 0`).
  Requiring evidence makes the author run the extra test instead of claiming
  "probably works, I read the code".
- **Merge danger**: `two-way door` (plain revert restores state) or `one-way door`
  (data migration, irreversible public action, external side effect — name it).
- **Blast radius**: small (isolated module) / medium (shared contract) / large
  (public API, data shape) + the affected surfaces by name.
- Reviewer checks the body: missing/stale evidence = review finding, not a nit.

## Operational Boundaries

- **Auditable native provenance**: Review records verify native session execution, nonzero model usage, git revision binding, and manifest hash; they provide auditable execution receipts, not cryptographic attestation or sandbox isolation.
- **Read-only role**: The reviewer inspects diffs and codebase files using read-only tools; it never applies edits or triggers destructive git actions.

## Red Flags

**Never:**
- Dispatch `oracle` with implementation plans or tickets (oracle must remain blind).
- Skip review on heavy/program changes because "it looks simple".
- Ignore P0/P1 findings or drop consuming-side routing checks.
- Treat static acceptance markdown as proof of review without recorded native execution evidence.

