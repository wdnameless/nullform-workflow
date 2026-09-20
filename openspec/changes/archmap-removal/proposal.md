# Why
The operator does not use archmap: it costs prompt budget (an always-loaded law plus a skill) and analysis weight (a TypeScript dependency) while producing a report nobody reads. Remove the capability cleanly; keep everything it touched working, and keep the deterministic CI gate by repointing auto-review at the debt-ledger check.

## What Changes
- Delete archmap modules, renderer assets, tests, tools/package*.json (typescript), the architecture-observability skill, and local .archmap state.
- Slim tools/auto-review.mjs to tsc/eslint/npm-test/debt-ledger with a real gate; update its test.
- Strip archmap from prompts (AGENTS.md section, orchestrator block), README/CONTEXT, .gitignore.
- Update sync/install/verify/audit/portability wiring and both CI workflow files.
- Remove the deployed copies from the harness root and the installed skill so no leftover binaries remain.

## Impact
Three disjoint workers (tools · PowerShell/CI · prompts/docs/skill); Main performs deployment-level deletion, baseline refresh, suites, oracle; commit keeps suites green at new counts (verify 27→N, audit 11→10).
