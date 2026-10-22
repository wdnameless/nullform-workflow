# Worktrees — autopilot-parity

Isolated git worktree per slice; all under `.tmp/worktrees/` (gitignored).
Parent integrates by merging slice branches into the program branch.

| Slice | Worktree | Branch | Zone |
|---|---|---|---|
| A run-control (R01/R02/R05) | `.tmp/worktrees/ap-run` | `feat/ap-run-control` | `tools/workflow.mjs` (`cmdStart` dials only), `tools/brief.mjs` (new), `tools/requirements.mjs` (new), `tools/tests/ap-run.test.mjs` (new) |
| B plan-gates (R03/R06/R07) | `.tmp/worktrees/ap-gates` | `feat/ap-plan-gates` | `tools/plan-check.mjs` (new), `tools/coverage-check.mjs` (new), `tools/blind-accept.mjs` (new), `tools/tests/ap-gates.test.mjs` (new) |
| C build-discipline (R04/R08/R09) | `.tmp/worktrees/ap-discipline` | `feat/ap-build-discipline` | `tools/review/arbitrate.mjs` (additive), `tools/worker-contract.mjs` (new), `tools/checklists.mjs` (new), `tools/tests/ap-discipline.test.mjs` (new) |
| D ops-journal (R10/R11/R12) | `.tmp/worktrees/ap-ops` | `feat/ap-ops-journal` | `tools/dashboard.mjs` (additive snapshot/server), `tools/cost-snapshot.mjs` (additive cost), `tools/journal.mjs` (new), `tools/carry.mjs` (new), `tools/tests/ap-ops.test.mjs` (new) |

Rules: one owner per file, zones disjoint, no edits outside the zone,
no network/paid calls/probes, `.workflow/` and `openspec/` are parent-owned.
