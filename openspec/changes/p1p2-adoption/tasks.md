# p1p2-adoption — tasks

## Ready frontier (parallel, disjoint zones)

- [ ] T1 (R01): manifest `verify:` column + validation.
  Zone: tools/requirements.mjs, tools/workflow-core.mjs (validateManifestRows),
  tools/tests/manifest-verify.test.mjs. Owner: @fixer.
- [ ] T2 (R02,R04): reviewer adversarial mode + perf-check rule.
  Zone: agent/agents/reviewer.md, tools/workflow-ci.mjs (review-run flag),
  tools/tests/reviewer-modes.test.mjs, tools/tests/perf-gate.test.mjs. Owner: @fixer.
- [ ] T3 (R03): cost per lane.
  Zone: tools/workflow-core.mjs (budgets/metric), tools/workflow.mjs (status/check),
  tools/tests/lane-cost.test.mjs. Owner: @fixer.
- [ ] T4 (R05): cross-model critique.
  Zone: tools/workflow-ci.mjs (oracle flag), tools/tests/cross-model.test.mjs,
  agent/agents/oracle.md. Owner: @fixer.

## Integration (parent)

- [ ] T5. Reconcile: validate --strict, A1–A5 proofs, gates, commit.
- [ ] T6. Blind oracle vs manifest + close.

## Notes
- T1 and T3 both touch workflow-core.mjs: sequence T1 → T3 (shared owner or ordering).
- T2 and T4 both touch workflow-ci.mjs: sequence T2 → T4.
- Prompt surfaces (reviewer.md, oracle.md) require explicit user permission (C6).
