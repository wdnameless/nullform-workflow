# Worktrees — round2-resilience

Isolated git worktree per slice; all under `.tmp/worktrees/` (gitignored).
Parent integrates by merging slice branches into the program branch.

| Slice | Worktree | Branch | Zone |
|---|---|---|---|
| A model-routing (R01/R02/R07) | `.tmp/worktrees/r2-routing` | `feat/r2-model-routing` | `tools/oracle-model.mjs` (additive), `tools/fallback.mjs` (additive), `tools/usage-normalize.mjs` (new), `tools/tests/round2-routing.test.mjs` (new) |
| B edit-safety (R03/R05/R09) | `.tmp/worktrees/r2-safety` | `feat/r2-edit-safety` | `tools/review/gatekeeper.mjs` (additive), `tools/two-phase.mjs` (new), `tools/trajectory.mjs` (new), `tools/tests/round2-safety.test.mjs` (new) |
| C durable-evidence (R04/R08/R10) | `.tmp/worktrees/r2-evidence` | `feat/r2-durable-evidence` | `tools/asset-freeze.mjs` (new), `tools/checkpoints.mjs` (new), `tools/capsule.mjs` (new), `tools/tests/round2-evidence.test.mjs` (new) |
| D ops-visibility (R06/R11/R12) | `.tmp/worktrees/r2-ops` | `feat/r2-ops-visibility` | `tools/cost-snapshot.mjs` (new), `tools/hud-status.mjs` (new), `tools/tripwire.mjs` (new), `tools/tests/round2-ops.test.mjs` (new) |

Rules: one owner per file, zones disjoint, no edits outside the zone,
no network/paid calls/probes, `.workflow/` and `openspec/` are parent-owned.
