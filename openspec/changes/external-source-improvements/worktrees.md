# Worktrees — external-source-improvements

Isolated git worktree per slice; all under `.tmp/worktrees/` (gitignored).
Parent integrates by merging slice branches into the program branch.

| Slice | Worktree | Branch | Zone |
|---|---|---|---|
| A review-integrity (R01/R02) | `.tmp/worktrees/ext-review` | `feat/ext-review-integrity` | `tools/oracle-model.mjs`, `tools/review/arbitrate.mjs` (new), `tools/tests/review-integrity.test.mjs` (new) |
| B spend-safety (R03/R04) | `.tmp/worktrees/ext-spend` | `feat/ext-spend-safety` | `tools/review/budget.mjs`, `tools/review/gatekeeper.mjs` (new), `tools/tests/spend-safety.test.mjs` (new) |
| C supervision (R05) | `.tmp/worktrees/ext-supervision` | `feat/ext-supervision` | `tools/supervision.mjs` (new), `tools/tests/supervision.test.mjs` (new) |
| D routing-resilience (R06/R07/R08) | `.tmp/worktrees/ext-routing` | `feat/ext-routing-resilience` | `tools/workflow.mjs` (`suggestTier` only), `tools/orchestrator-evals.mjs` (new), `tools/fallback.mjs` (new), `tools/tests/routing-resilience.test.mjs` (new) |

Rules: one owner per file, zones disjoint, no edits outside the zone,
no network/paid calls/probes, `.workflow/` and `openspec/` are parent-owned.
