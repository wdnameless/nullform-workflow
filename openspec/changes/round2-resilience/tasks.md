# Round2 resilience tasks

## Slice A — Model routing (R01/R02/R07)
- [ ] Diversity gate: checker assignment refuses same-family reviewer/oracle.
- [ ] Usage normalizer: provider-correct totals, UNKNOWN for unreported fields.
- [ ] Circuit breaker: opens after N retryable failures, fails back to reserve.
- [ ] Tests: diversity refusal, both-provider fixtures, breaker open/half-open/close.

## Slice B — Edit safety (R03/R05/R09)
- [ ] Fact-forcing: pre-edit guard requires caller/consumer reads.
- [ ] Two-phase edits: dry_run → plan_token → verified execution.
- [ ] Trajectory monitor: loop detection + per-task step limit.
- [ ] Tests: guard refusal, token lifecycle, loop/limit trips.

## Slice C — Durable evidence (R04/R08/R10)
- [ ] Oracle isolation: hashed frozen assets + exclude-masks.
- [ ] Checkpointing: durable wave progress, resume from failed step.
- [ ] Capsule receipts: NDJSON + SHA-256 chain + effect classes.
- [ ] Tests: tamper detection, resume continuity, chain verification.

## Slice D — Ops visibility (R06/R11/R12)
- [ ] Cost snapshots: atomic O(1) write, tiered alerts with dedup.
- [ ] HUD schema: versioned session status consumed by dashboard.
- [ ] Tripwire: tier LOC ceilings + golden input/output fixtures.
- [ ] Tests: snapshot/alerts, schema validation, tripwire + fixtures.

## Integration (parent)
- [ ] Merge slices from isolated worktrees, resolve conflicts.
- [ ] Run deterministic gates (tests/lint/size) and blind oracle acceptance.
