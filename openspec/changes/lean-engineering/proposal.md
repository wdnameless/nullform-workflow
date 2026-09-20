# Why
The ponytail reference implementation shows a code-minimisation layer our harness only partly has: reuse-first exists as a law, but the ladder's lower rungs (stdlib → native platform → installed dependency → one line), the tagged over-engineering review format, and the debt ledger for deliberate deferrals are absent. Measured on the reference benchmark: −54% LOC, −22% tokens while staying 100% safe — the safe part depends on an explicit never-cut list, which we adopt with the ladder.

## What Changes
- fixer.md / designer.md: the 7-rung solution ladder, never-cut list, root-cause-before-edit rule.
- reviewer.md: over-engineering lens with `delete:/stdlib:/native:/yagni:/shrink:` tags, mandatory replacement, `net: -N lines` verdict metric.
- tools/debt-ledger.mjs: `defer: … | ceiling: … | upgrade: …` marker convention, scan/json/check/write CLI, no-trigger rot flag.
- tools/archmap-problems.mjs: `detectDebtProblems` — no-trigger markers surface as `maintainability/debt-no-trigger` problems.
- AGENTS.md / orchestrator.md: LEAN-FIRST law line + gate metric.
- CONTEXT.md + README.md: vocabulary and operator docs.
- Wiring: sync manifest, portability assert, audit presence, verify gate check.

## Impact
Four disjoint workers (tool+tests · archmap+tests · prompts+docs · PowerShell wiring); one cross-module contract frozen before spawn (`scanText` import); baseline refreshed deliberately; oracle acceptance blind against this manifest.
