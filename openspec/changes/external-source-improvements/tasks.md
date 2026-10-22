# External-source improvements tasks

## Slice A — Review integrity (R01/R02)
- [ ] Cross-family oracle: extend `tools/oracle-model.mjs` to record model family and refuse same-family oracle selection (fixture: builder vs oracle families).
- [ ] Arbitration: new acceptance-criteria matcher; each finding maps to a criterion or is dropped with a reason.
- [ ] Tests: family-mismatch rejection, arbitration mapping/dropping.

## Slice B — Spend & safety (R03/R04)
- [ ] Ledger: extend `tools/review/budget.mjs` with idempotent usage receipts (restart-safe) and tier ceilings T1–T3.
- [ ] Gatekeeper: new pre-call validator for dangerous tools; allow/deny logged with rule name.
- [ ] Tests: receipt idempotency after restart, ceiling refusal, guard allow/deny.

## Slice C — Supervision (R05)
- [ ] State manifests: declarative rules classifying working|blocked|idle.
- [ ] Wait barrier: event-based `wait_for_state/output` with timeout replacing polling.
- [ ] Tests: classifier fixture transitions, barrier resolve/timeout.

## Slice D — Routing & resilience (R06/R07/R08)
- [ ] Triage: extend `suggestTier` with measured blast-radius rationale.
- [ ] Behavioral evals: declarative case runner for the orchestrator return contract.
- [ ] Fallback/budget: ordered tool failover + token budget that triggers compaction.
- [ ] Tests: lane fixtures, eval pass/fail reporting, fallback order, budget trigger.

## Integration (parent)
- [ ] Merge slices from isolated worktrees, resolve conflicts.
- [ ] Run deterministic gates (tests/lint/size) and blind oracle acceptance.
