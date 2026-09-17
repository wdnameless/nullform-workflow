# Why
User approved T3 program: archmap must explain problems in Russian by category and priority, offer one-click AI fix prompts, and show per-file local graphs; workflow weak spots (speed, CI/CD, budget, auto-review, tier suggestion, guarded T0) get fixed in the same program. Dashboard deferred explicitly.

## What Changes
- Problem engine: categorized, severity-graded Russian problems with ready AI prompts (structure/optimization/security/reliability/maintainability).
- Renderer: view buttons, folder clusters, per-file local graph, problems view with copy buttons.
- Incremental cache for repeat scans.
- workflow.mjs: suggest, per-tier budgets, guarded auto T0.
- CI template + auto-review CLI.

## Capabilities
- `problem-system` (new), `workflow-hardening` (new).

## Impact
See interfaces.md: 4 disjoint ownership zones, 4 explicit worktrees. No new mandatory deps; dashboard deferred (R09e) with reason.