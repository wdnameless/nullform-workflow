# omh-model-routing — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. Categories+router (R01+R02): categories в models.yml схеме +
  резолв + tools/model-router.mjs (scan/plan/apply) + тесты. Zone:
  tools/model-router.mjs (new), tools/tests/model-router.test.mjs (new),
  tools/oracle-model.mjs (import probeProvider only — read, не менять),
  agent/models.yml.example (categories пример). Owner: @fixer.
- [ ] T2. Status gate (R03): verified-флаг стадий + close-гейт + тесты.
  Zone: tools/workflow.mjs (cmdClose + stage-статус), tools/tests/
  (workflow-гейт тесты, append). Owner: @fixer.
- [ ] T3. Memory reasons (R04): decision+reason в cadence + пакет + тесты.
  Zone: tools/memory-cadence.mjs, tools/tests/ (cadence тесты, append/new).
  Owner: @sonic.

## Integration (parent)

- [ ] T4. Reconcile: validate --strict, A1–A4 proofs, gates, commit.
- [ ] T5. Oracle vs manifest (blind) + merge + close.
