# Round2 resilience proposal

## Why

T1 round2 analysis (`.tmp/external-sources-analysis-round2.md`) produced twelve
portable mechanisms from video/GitNexus/ECC/PDF sources. The user approved all:
«Давай это интегрируем».

## What changes (12 requirements, 4 slices)

1. **Model routing** (R01/R02/R07): diversity gate for checker assignment,
   provider-correct usage normalization, circuit breaker with model failback.
2. **Edit safety** (R03/R05/R09): fact-forcing pre-edit guard, two-phase
   destructive edits, subagent trajectory loop/step monitor.
3. **Durable evidence** (R04/R08/R10): oracle asset isolation, wave
   checkpoint/resume, EvalCapsule hash-chained receipts.
4. **Ops visibility** (R06/R11/R12): cost snapshots + tiered alerts, HUD
   status schema, LOC tripwire + golden fixtures.

## Non-goals

- No GitNexus service (PolyForm Noncommercial), no tmux engine, no sql.js.
- No new paid model calls in tests; no provider probes by default.
- No second agent loop, no runtime chassis, no shared-tree parallelism.

## Reuse first

- Extend `tools/oracle-model.mjs` (round1 family rule), `tools/review/budget.mjs`,
  `tools/review/gatekeeper.mjs` (round1), `tools/fallback.mjs` (round1),
  `tools/workflow.mjs` metrics, `tools/dashboard.mjs` before new modules.
- New modules only where no seam exists: usage normalizer, fact-forcing,
  checkpoint store, trajectory monitor, capsule receipts, HUD schema, tripwire.
