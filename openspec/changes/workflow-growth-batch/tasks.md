# workflow-growth-batch — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. Metrics tools (R01+R05): NEW tools/lead-time.mjs + NEW
  tools/cfr-report.mjs + тесты на фикстурах. Zone: tools/lead-time.mjs,
  tools/cfr-report.mjs, tools/tests/lead-time.test.mjs,
  tools/tests/cfr-report.test.mjs. Owner: @fixer.
- [ ] T2. Coverage gate (R03): NEW tools/coverage-changed.mjs + тест
  парсинга + шаг `Coverage gate` в repo-gate.yml. Zone:
  tools/coverage-changed.mjs, tools/tests/coverage-changed.test.mjs,
  .github/workflows/repo-gate.yml. Owner: @fixer.
- [ ] T3. Canon docs (R02+R06+R07): Bugfix fast-lane, experience-цитата,
  видео-принципы §9. Zone: core/PORTABLE.md,
  agent/agents/orchestrator.md. Owner: @sonic.
- [ ] T4. ADR seed (R04): docs/adr/0001-*.md + CONTEXT.md:124.
  Zone: docs/adr/, CONTEXT.md. Owner: @sonic. Depends: none.

## Integration (parent)

- [ ] T5. Reconcile: validate --strict, A1–A8 proofs, gates, R08b files
  (sync-manifest + closure test уже в ветке), commit, integrity sweep.
- [ ] T6. Oracle vs manifest (blind) + merge + R09 описание.
