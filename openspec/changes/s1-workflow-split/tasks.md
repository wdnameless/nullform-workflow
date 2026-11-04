# Tasks — s1-workflow-split

- [x] T-01: Create tools/workflow-core.mjs with state persistence, locking, metrics, and journal helpers.
- [x] T-02: Expand tools/workflow-ci.mjs with review-run, stage-b, and openspec/coverage/manifest validators.
- [x] T-03: Refactor tools/workflow.mjs to delegate to workflow-core.mjs and workflow-ci.mjs while keeping exports intact.
- [x] T-04: Verify file size limits (< 1200 lines each) and clean code-size baseline updates.
- [x] T-05: Run frozen test suite, record Stage B disposition, and produce blind oracle verdict.
