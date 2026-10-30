# fix-all-batch — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. M1 python-COCO (R01): сплит parse_and_aggregate + format_table в
  tools/session_cost.py до ≤ baseline (105/23); остаток — ресид
  .quality-baseline.json с датой+причиной. Zone: tools/session_cost.py,
  .quality-baseline.json (python rows only), tools/tests/test_session_cost.py.
  Owner: @fixer.
- [ ] T2. S1 toolAvailable (R03): .exe/.cmd/.bat проба + where-фолбэк для
  path-like без расширения. Zone: tools/quality.mjs (toolAvailable only),
  tools/tests/u-quality.test.mjs. Owner: @fixer.
- [ ] T3. S3 ledger (R05): компактификация ниже 1MiB + механизм против
  повторного переполнения + тест. Zone: tools/review/budget.mjs,
  tools/tests/review-budget.test.mjs (или соседний), сам ledger-файл.
  Owner: @fixer.
- [ ] T4. S2+S4 (R04+R06): efforts сверка+фикс; claims pin-тест. Zone:
  agent/models.yml.example, tools/tests/task-claim.test.mjs (append only).
  Owner: @sonic.

## Integration (parent)

- [ ] T5. M2+S5: rerun win-24, добыча лога, фикс причины; C1+C2 тикеты.
- [ ] T6. Reconcile: validate --strict, A1–A8 proofs, gates, commit.
- [ ] T7. Oracle vs manifest (blind) + merge + close.
