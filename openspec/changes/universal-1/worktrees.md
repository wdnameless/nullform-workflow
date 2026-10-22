# Worktrees — universal-1

Isolated git worktree per slice under `.tmp/worktrees/` (gitignored).
Parent integrates by merging slice branches into `feat/universal-1`.

| Slice | Worktree | Branch | Zone |
|---|---|---|---|
| A smart-install (R01–R04) | `.tmp/worktrees/u-install` | `feat/u-smart-install` | tools/install-detect.mjs, tools/doctor-lite.mjs, tools/install-harness.mjs (additive), tools/tests/u-install.test.mjs |
| B briefing (R05) | `.tmp/worktrees/u-brief` | `feat/u-briefing` | tools/brief-rounds.mjs, tools/workflow.mjs (cmdBrief only), tools/tests/u-brief.test.mjs |
| C waves+bench (R06–R07) | `.tmp/worktrees/u-waves` | `feat/u-waves-bench` | tools/dashboard.mjs (run-view waves only), tools/benchmark-run.mjs, docs/benchmark.md, tools/tests/u-waves.test.mjs |
| D skills+quality (R08–R09) | `.tmp/worktrees/u-skills` | `feat/u-skills-quality` | skills/nullform/SKILL.md, tools/workflow.mjs (check-ci only), tools/tests/u-quality.test.mjs |

Rules: one owner per file, zones disjoint (B/D share workflow.mjs by function,
parent merges), no edits outside zone, no network/paid calls, `.workflow/` and
`openspec/` parent-owned.
