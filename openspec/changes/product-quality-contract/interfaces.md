# Interfaces, decisions and ownership

## Existing command, no new framework

`node tools/auto-review.mjs [--root DIR] [--json] [--require SCRIPT]... [--check JSON_ARGV]...`.
`runAutoReview(opts={})` retains root/silent and its success/exitCode/report/reasons result; add `requiredChecks: string[]` and `commands: string[][]` options and `status`, `checks` results. CLI JSON retains ok/exitCode/root/total/problems/report and adds status/checks. No other exported implementation helpers are needed.

Check statuses are `pass`, `fail`, `not-applicable`, `unverified`; each row has a stable id, required boolean, actual argv (or null), status and detail. An executed command exiting nonzero/signal/timeout is fail; a required command that cannot be established/launched is unverified. Both yield nonzero overall. CLI malformed flags/JSON/argv yield exit2, not execution. Execution failures/unverified yield exit1. Zero applicable product checks overall is unverified/exit1; an individual optional absent category is not-applicable, and a passing explicit command can supply the product evidence. Debt checks alone never certify a product.

Auto-discover package scripts build/typecheck/lint/test, run each once as applicable required checks. A repeated --require SCRIPT marks an existing arbitrary package script required (e.g. check:perf); missing script is unverified. --check JSON_ARGV adds a required explicit non-shell command for non-npm projects/smoke/performance/a11y checks; nonempty string argv, reject malformed entries and unknown/positional flags before dispatch. Commands run in the supplied project root. No command interpolation/new shell, no package installation or npx--yes. Existing resolveNpmRunner/spawnSafe provides Windows-safe npm invocation; npm run executes operator-owned scripts normally. Existing configured TS/ESLint checks without scripts may use already-installed local binaries only; missing required checker is unverified, never fetched. Preserve debt-ledger as a separate check. Bound outputs/command execution using existing patterns; do not invent retries or background services.

Overall: fail if any failed check; otherwise unverified if any required check unverified or no product verification ran; otherwise pass. Optional absent categories are not-applicable. Root/package/config read errors are not evidence of absence. No tests-count regex is an outcome oracle; command exit and actual retained results are authoritative.

## Policy contract

Existing manifest records applicable quality outcomes/limits; existing interfaces records domain ownership/dependency direction plus actual command/env/workload/limit and required/n/a rationale. UI may be n/a with reason. Performance budgets belong to the target product, not tool/model spend. No mandatory new file/schema/framework. Useful DB/network/time seams may have one implementation. Roles use canonical core guidance, no duplicated full checklists.

Consumer evaluation uses a bounded maintenance task: extend an already working small order-summary module with refund handling while preserving its public positive-order behavior. Independent checks cover baseline/extension/boundary errors and a declared finite workload; record actual elapsed time/environment and measurement limits, not a universal performance claim. A follow-up-change protocol records affected behavior, regressions, time/change footprint and human explanation of boundaries; unexecuted maintainability/visual judgments remain unverified, never a numeric proxy inferred from LOC. No real model run is authorized.

## Writer zones

A QualityGate owner: tools/auto-review.mjs, tools/tests/auto-review.test.mjs, tools/verify.mjs, .github/workflows/repo-gate.yml, templates/ci/workflow-gate.yml; other direct consumers only after notifying parent. Template uses project checks, not an invented generic project build. Actual repository CI retains existing full unit suite once and supplies an explicit meaningful Node consumer check to auto-review because package intentionally has no npm test script. Do not make auto-review recursively invoke itself. No package/benchmark/policy edits.

B QualityPolicy owner: core/PORTABLE.md, agent/agents/fixer.md, reviewer.md, oracle.md, designer.md, orchestrator.md; skills/nullform-workflow-full/SKILL.md; templates/design/DESIGN.md; bench/tasks.json, bench/README.md and bounded new consumer setup/check modules plus consumer-check regression if required. No auto-review/runtime/CI/README/CONTEXT edits.

Parent: change spec/execplan, CONTEXT.md/README.md and integration, deterministic verification. No project implementation by parent. All writers skip tests/build/lint/formatters while writing; parent owns runs. One owner/file. Existing paid/native acceptance receipts are not edited. New code checker is not evidence of improved LLM output.
