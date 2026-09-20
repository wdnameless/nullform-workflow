# Why
The harness claims its process produces leaner, verified work (adopted from the ponytail benchmark), but has no instrument to measure that claim. Build the measurement infrastructure: same task, several arms, isolated runs, recorded LOC/time/checks/cost, and a comparison report — with the agent runner supplied by the user, so the harness measures instead of pretending.

## What Changes
- `tools/benchmark.mjs`: init/run/report/compare/list, zero deps, RU output, `--dry-run`/`--yes` safety seam, per-run clones, deterministic metrics from git.
- `tools/tests/benchmark.test.mjs`: full self-test against a temp git fixture with a portable node runner.
- Wiring: sync manifest, portability assert, audit check.
- Docs: README section, CONTEXT.md terms.

## Impact
Two workers (tool+tests · wiring) plus docs; no prompt surfaces touched; oracle blind acceptance against the manifest.
