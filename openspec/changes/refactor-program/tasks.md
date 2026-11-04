# refactor-program — tasks

## Slice graph (T2 each, one writer per worktree)

- [ ] S1. workflow-split (R01+R02): сплит 2500 → <1200×3 по плану #16.
  Zone: tools/workflow.mjs, NEW tools/workflow-ci.mjs, NEW tools/workflow-core.mjs,
  tools/tests/workflow-gate.test.mjs (move only), .code-size.baseline.json (s1 rows).
  Owner: @fixer. blocked-by: ничего (первый).
- [ ] S2. dashboard-family (R01+R02): ui/collectors/тесты в потолки с запасом.
  Zone: tools/dashboard-ui.mjs, tools/dashboard-collectors.mjs,
  tools/tests/dashboard.test.mjs, tools/tests/benchmark.test.mjs,
  .code-size.baseline.json (s2 rows). Owner: @fixer. blocked-by: S1.
- [ ] S3. gates-coco-prune (R01+R02): quality/sync/usage-audit + prune 9 unwired.
  Zone: tools/quality.mjs, tools/sync.mjs, tools/usage-audit.mjs,
  9 unwired-модулей (delete only с доказательством), CODEMAP'ы зон.
  Owner: @fixer. blocked-by: S1.
- [ ] S4. proof-matrix (R03+R04+R05): CI cells + verify + тарифы + evals.
  Zone: .github/workflows/repo-gate.yml, tools/verify*.mjs, tools/install-* (smoke
  только), tools/bench-budget.mjs, tools/model-router.mjs (тарифы only),
  bench/tasks.json (append only). Owner: @fixer. blocked-by: ничего (параллелен).
- [ ] S5. behavior-deltas (R06): было→стало + отчёт доказательства.
  Zone: bench/runs/* (new), docs/benchmark-live.md (append), отчёт доказательства.
  Owner: @sonic. blocked-by: S1, S2, S3.

## Fronts

- Front A (сейчас): S1 + S4 (disjoint: workflow-ядро vs CI/verify/тарифы).
- Front B (после S1): S2 + S3 (disjoint: dashboard vs gates/prune).
- Front C (после S1–S3): S5 (меряет остальных).
- Front D (финал): интеграционный oracle + merge + close (parent).

## Integration (parent)

- [ ] T6. Reconcile: validate --strict, A1–A6 proofs, spend ≤$50, commit.
- [ ] T7. Integration oracle vs программный манифест (blind) + close.
