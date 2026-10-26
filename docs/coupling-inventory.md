# Remaining unwired modules

9 of 111 production modules have no production consumer and are not a CLI entry point.

Each one is a declared slice of an OPEN change, not dead code. They are listed with their
owning change so the next session wires them as part of that change rather than guessing.

| module | owning change |
|---|---|
| `asset-freeze.mjs` | round2-resilience |
| `blind-accept.mjs` | autopilot-parity |
| `capsule.mjs` | round2-resilience |
| `checkpoints.mjs` | round2-resilience |
| `coverage-check.mjs` | autopilot-parity |
| `fallback.mjs` | external-source-improvements |
| `supervision.mjs` | external-source-improvements |
| `two-phase.mjs` | round2-resilience |
| `usage-normalize.mjs` | round2-resilience |

**Do not delete these.** An open change whose tasks are all unchecked is unfinished
work; deleting its modules would delete the plan along with the code. `round2-resilience`
has 18 open tasks, `external-source-improvements` 15, `autopilot-parity` 21.

## Wired since the audit

| module | consumer |
|---|---|
| `tripwire.mjs` | `workflow-ci`: per-tier changed-LINE ceiling (a file count cannot see a large single-file edit) |
| `trajectory.mjs` | `dashboard`: repeated-call loop detection over the transcript it already reads |
| `hud-status.mjs` | `dashboard`: emits the `hud-status.v1` contract from values it already computes |
| `gatekeeper.mjs` | `review/evidence`: `product-command` goes through pre-call authorization |
| `arbitrate.mjs` | `workflow review-run`: re-review ceiling now counted from evidence history |
| `plan-check.mjs` | `workflow` openspec gate: blocked-by cycles and unknown dependencies in `tasks.md` |

## Removed

| module | why |
|---|---|
| `worker-contract.mjs` | strictly weaker duplicate of `return-contract.mjs`: it accepted prose in FILES and free text in TESTS, where the survivor refuses both. Its three tests were migrated to the survivor. |
