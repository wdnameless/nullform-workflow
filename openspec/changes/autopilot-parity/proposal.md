# Autopilot parity proposal

## Why

Deep analysis (`.tmp/autopilot-gap-registry.md`) mapped every autopilot
mechanism against our harness. The user demands full parity plus superiority:
«весь их фунцкионал и мы были лучше этого фреймворка по все параметрам».

## What changes (13 requirements, 5 slices)

1. **Run control** (R01/R02/R05): mode/depth dials, frozen brief + redaction,
   requirement types/statuses with mechanical recount.
2. **Plan gates** (R03/R06/R07): G3 plan validator, G2 blind coverage check,
   G4 blind acceptance in an isolated temp clone.
3. **Build discipline** (R04/R08/R09): REDPROOF worker contract, depth +
   adversarial checklists, three-axis review with F1 and repair limits.
4. **Ops journal** (R10/R11/R12): beats/honest time, waits, commits check,
   trailers, carried debts, normalized cost, skills-lock, snapshot server.
5. **Run view** (R13): dashboard run tab — hero-статус, трек стадий, «твои слова», G1–G4, лента, часы active/wait, --freeze.

## Non-goals

- No ap.py monolith port, no shared-tree parallelism, no Python runtime.
- No `window.STATE` executable JS, no regex manifest parsing, no WMI.
- No new paid model calls in tests; no provider probes by default.
- Keep our superior frozen tests, worktrees, evidence protocol, zero-dep modules.

## Reuse first

- Extend `tools/workflow.mjs` (start/check), `tools/dashboard.mjs`,
  `tools/review/arbitrate.mjs`, `tools/checkpoints.mjs`, `tools/cost-snapshot.mjs`
  before new modules.
- New modules only where no seam exists: brief freeze, plan check, coverage,
  worker contract, checklists, review axes, journal, carried, skills-lock.
