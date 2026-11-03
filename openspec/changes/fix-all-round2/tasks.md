# fix-all-round2 — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. D1 CFR-честь (R01): нормализация интервала + fail-loud + тесты.
  Zone: tools/cfr-report.mjs, tools/tests/cfr-report.test.mjs. Owner: @fixer.
- [ ] T2. D2 дашборд-Paseo (R02): диагностика 7.5s + loopback-bind; фикс до
  открытия из Paseo ИЛИ доказанный внешний корень + обходной путь.
  Zone: tools/dashboard.mjs, tools/dashboard-collectors.mjs,
  tools/dashboard-ui.mjs (read-only сверх потолка — только чтение).
  Owner: @fixer.
- [ ] T3. A1 lifecycle-evals (R03): NEW tools/lifecycle-evals.mjs + CI-шаг
  в repo-gate.yml + тесты. Zone: tools/lifecycle-evals.mjs (new),
  .github/workflows/repo-gate.yml (append step), tools/tests/lifecycle*.test.mjs.
  Owner: @fixer.
- [ ] T4. A2 локи+settlement (R04): execution-lock 409 + settle с confirm.
  Zone: tools/workflow/claims.mjs, tools/workflow.mjs (settle cmd only),
  tools/tests/task-claim.test.mjs. Owner: @fixer.
- [ ] T5. A3+A5+B2+B3 доки+счётчик (R05+R06+R08+R09): parity-дока, NEW счётчик,
  GATES-правило, PORTABLE-правка. Zone: docs/ (sync/GATES), tools/gate-counter.mjs
  (new), core/PORTABLE.md, tools/tests/gate-counter.test.mjs. Owner: @sonic.
- [ ] T6. B1+B4 (R07+R10): workflow.mjs снижение/план + install reuse.
  Zone: tools/workflow.mjs (shrink only), tools/install-harness.mjs,
  tools/tests/install-harness.test.mjs. Owner: @fixer.

## Integration (parent)

- [ ] T7. Reconcile: validate --strict, A1–A10 proofs, gates, commit.
- [ ] T8. Oracle vs manifest (blind) + merge + close.
