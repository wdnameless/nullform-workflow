# cost-beats-run-rule — tasks

## Ready frontier (Wave 3, parallel, disjoint zones)

- [ ] T1. `tools/session_cost.py --by-role` + fixture test. Zone: tools/session_cost.py, tools/tests/test_session_cost.py (+fixture). Owner: @fixer.
- [ ] T2. Reviewer lens sentence. Zone: agent/agents/reviewer.md (1 line). Owner: @sonic. Depends: nothing.
- [ ] T3. Beats wiring at workflow events + scripted proof test. Zone: tools/workflow.mjs (recordBeat calls only), tools/tests/workflow-beats.test.mjs (new). Owner: @fixer. Depends: nothing (journal.mjs untouched).

## Integration (parent)

- [ ] T4. Reconcile: run gates (code-size/clone/eslint/quality), spot-check diffs, commit.
- [ ] T5. Oracle blind acceptance vs manifest.
