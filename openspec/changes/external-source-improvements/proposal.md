# External-source improvements proposal

## Why

T1 analysis (`.tmp/external-sources-analysis.md`) showed eight portable mechanisms from
video/paperclip/herdr/PDF sources. The user approved all: «Давай все брать».

## What changes (8 slices, 4 workstreams)

1. **Review integrity** (R01/R02): cross-family oracle selection + arbitration of
   reviewer findings against acceptance criteria.
2. **Spend & safety** (R03/R04): durable idempotent usage ledger with tier ceilings;
   pre-call gatekeeper for dangerous tools.
3. **Supervision** (R05): declarative state manifests + event wait barrier.
4. **Routing & resilience** (R06/R07/R08): blast-radius triage, declarative
   orchestrator evals, tool fallback + token budget/compaction.

## Non-goals

- No SaaS/org-chart/DB-stack/UI from paperclip; no full PTY engine from herdr.
- No new paid model calls in tests; no provider probes by default.
- No second agent loop, no runtime chassis, no compulsory microservices.

## Reuse first

- Extend `tools/oracle-model.mjs`, `tools/review/budget.mjs`, `suggestTier` in
  `tools/workflow.mjs` before creating new modules.
- New modules only where no seam exists: arbitration, gatekeeper, state-manifest
  classifier, wait barrier, eval runner, fallback/budget policy.
