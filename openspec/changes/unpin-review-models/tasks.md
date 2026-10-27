# unpin-review-models — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. Transport: `user-configured` route in budget.mjs + credential
  gate in evidence.mjs + http-runtime.mjs. Zone: tools/review/budget.mjs,
  tools/review/evidence.mjs, tools/review/http-runtime.mjs,
  tools/review/http-evidence.mjs. Owner: @fixer.
- [ ] T2. Docs: orchestrator.md, PORTABLE.md §review, nullform-workflow-full
  SKILL.md, CONTEXT.md Review-execution term. Zone: 4 doc files.
  Owner: @sonic. Depends: T1 (exact policy field names).
- [ ] T3. Tests: replace pinned-OpenAI fixtures with user-configured
  fixtures in 5 test files; keep all assertions' intent. Zone:
  tools/tests/oss-safety, review-boundaries, review-controlled-http,
  review-arbitration, round2-routing. Owner: @fixer. Depends: T1.

## Integration (parent)

- [ ] T4. Reconcile: A1 dry-run proof, A3 grep proof, gates, commit.
- [ ] T5. Oracle vs manifest (non-blind fallback if spawn dead).
