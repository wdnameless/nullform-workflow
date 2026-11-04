# Remaining unwired modules

0 of 102 production modules are unwired. All remaining production modules have active consumers or serve as CLI entry points.

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
| `asset-freeze.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `blind-accept.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `capsule.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `checkpoints.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `coverage-check.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `fallback.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `supervision.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `two-phase.mjs` | S3 prune: 0 production callers, experimental dead module. |
| `usage-normalize.mjs` | S3 prune: 0 production callers, experimental dead module. |
