# Tasks — ci-green-selfheal

Wave 1 (unblocked, disjoint)

- [ ] **T-01 (Z1)** Historical evidence binding — `validateReviewEvidenceAtRevision`
      + push-gate uses merge-base revision instead of working tree. Blocked-by: —
- [ ] **T-02 (Z2)** `nullform setup` — detection with reasons, plan, confirm,
      `--yes`/`--dry-run`/`--json`. Blocked-by: —
- [ ] **T-03 (Z4)** Root-cause and fix the hanging `adaptive-harness-cli` test. Blocked-by: —
- [ ] **T-04 (Z3)** Dashboard guarantee in `workflow start` (live url or explicit
      degradation) + regression test. Blocked-by: T-01 (shares nothing, but
      sequenced to keep `workflow*` single-writer windows clean)

Wave 2 (depends on Wave 1)

- [ ] **T-05 (Z2)** `nullform heal` — doctor→repair→doctor, idempotent,
      `--dry-run`. Blocked-by: T-02 (reuses install primitives)
- [ ] **T-06 (docs)** README + docs/SETUP.md: `setup`, `heal`, dashboard
      guarantee. Blocked-by: T-02, T-05, T-04

Wave 3 (integration)

- [ ] **T-07** Weakness report R04 with file:line + severity. Blocked-by: —
- [ ] **T-08** Full-suite green run (all `tools/tests/*.test.mjs`) with counts.
      Blocked-by: T-01, T-03, T-04, T-05
- [ ] **T-09** FF merge to master + push; verify `origin/master` sha.
      Blocked-by: T-08
- [ ] **T-10** Clean-install verification from master in OS temp.
      Blocked-by: T-09
