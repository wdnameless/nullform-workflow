# Interfaces — external-source-improvements

Owner per slice; zones are disjoint. Parent owns `CONTEXT.md` glossary and integration.

## Slice A — Review integrity (R01/R02)

- `resolveOracleModel({ builderFamily, candidates }) → candidate | throws`
  (extend `tools/oracle-model.mjs`). Family derived deterministically from the
  model id string, no network. Same-family selection throws naming the conflict.
- `arbitrate(findings, criteria) → { accepted, dropped }`
  (new `tools/review/arbitrate.mjs`). Accepted iff the finding references a
  criterion id present in `criteria`; else dropped with `reason: "no-criterion-match"`.
- Tests: new `tools/tests/review-integrity.test.mjs`.

## Slice B — Spend & safety (R03/R04)

- `recordReceipt(ledger, receipt)` idempotent on `receipt.id`;
  `admit(ledger, tier, cost)` throws over ceiling
  (extend `tools/review/budget.mjs`; keep nano-USD integers and lock discipline).
- `authorize(tool, args) → { ok: true } | { ok: false, rule }`
  (new `tools/review/gatekeeper.mjs`). Default deny for exec/write/network;
  every decision appended to an audit log with tool, rule, timestamp.
- Tests: new `tools/tests/spend-safety.test.mjs`.

## Slice C — Supervision (R05)

- `classify(manifest, tail) → working|blocked|idle`
  (new `tools/supervision.mjs`). First matching `{ id, state, pattern }` wins;
  default `idle`. Input is plain text tail lines, no PTY engine.
- `waitForState(classifier, want, { timeoutMs })`
  (same module). Resolves on a wanted state, rejects with `timeout`.
- Tests: new `tools/tests/supervision.test.mjs`.

## Slice D — Routing & resilience (R06/R07/R08)

- `suggestTier({ files, task }) → { tier, rationale }`
  (extend in `tools/workflow.mjs`). Rationale names file count, directory
  spread, keywords.
- `runEvals(cases, subject) → [{ id, pass, detail }]`
  (new `tools/orchestrator-evals.mjs`, cases + runner in one file).
  Nonzero exit when any case fails.
- `withFallback([toolA, toolB], args)` tries in order, logs order, throws when
  all fail; `checkBudget({ used, limit }) → ok|compact|refuse`
  (new `tools/fallback.mjs`; `compact` fires before `refuse`).
- Tests: new `tools/tests/routing-resilience.test.mjs`.

## Shared non-goals

No network, no paid model calls, no provider probes, no new dependencies,
no edits outside the assigned zone, no `CONTEXT.md`/openspec/`.workflow/` edits.
