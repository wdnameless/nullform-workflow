# Acceptance basis (no native review-evidence run)

1. **No model-spending credential.** No admitted provider credential is present in
   this environment, so `review-run` cannot dispatch a paid pass from this tree.
   Blind-oracle-only per PORTABLE §5/B3 applies; keyed runs are releases/money paths.

## Executed evidence on this tree (master 501a679)

- `openspec/changes/p1p2-adoption/oracle.md` — blind **ACCEPT R01–R05**.
- Feature suites: **36/36** (`manifest-verify`, `reviewer-modes`, `lane-cost`,
  `perf-gate`, `cross-model`).
- Neighboring suites: **96/96** (`workflow-gate`, `workflow-budget`,
  `review-evidence`, `http-runtime`).
- `node tools/quality.mjs check` → `node pass (222 functions)`.
- `node tools/code-size.mjs check` → `PASS` (301 files, 2211 functions, 4 exempt).
- `node tools/prompt-lint.mjs check --root .` → 321 surfaces match baseline.
- Backward compatibility: 70 existing manifests validate with 0 verify errors.

## Limitations

- R05 live two-model execution is UNVERIFIED (no credential); deterministic
  divergence/escalation/unverified branches are proven by tests.
- Python pylint is not installed locally; the executed analyzer gate is node.

## What would retire this marker

An admitted provider credential and a `review-run` for this change.
Operator action; unavailable here.
