# fcc-adopt-1267 — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. Probe+report (R01+R02): tools/harness-probe.mjs + doctor --report
  + тесты. Zone: tools/harness-probe.mjs (new),
  tools/tests/harness-probe.test.mjs (new), bin/nullform.mjs (doctor path
  only), tools/doctor.mjs (если нужен hook — иначе нет). Owner: @fixer.
- [ ] T2. Matrix+vocab (R01+R03+R04): versions/activation/compat в matrix +
  CONTEXT Effort + models.yml.example + schema-тест. Zone:
  tools/harness-matrix.json, CONTEXT.md, agent/models.yml.example,
  tools/tests/init-wizard.test.mjs (только matrix-schema тест). Owner: @sonic.

## Integration (parent)

- [ ] T5. Reconcile: validate --strict, A1–A4 proofs, gates, commit.
- [ ] T6. Oracle vs manifest (blind) + merge + close.
