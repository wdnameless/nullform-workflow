# Proposal — s1-workflow-split

## Why
`tools/workflow.mjs` reached 2500 lines (at the defer ceiling), blocking further maintainability. Ticket #16 specifies splitting the monolithic workflow CLI into `tools/workflow-ci.mjs` (CI surface, review-run, validators), `tools/workflow-core.mjs` (shared state, persistence, locking, metrics, journal), and `tools/workflow.mjs` (lane core).

## What Changes
1. Extract state/journal/locking helpers from `tools/workflow.mjs` into `tools/workflow-core.mjs`.
2. Extract CI/review-run/stage-b/validators into `tools/workflow-ci.mjs`.
3. Retain lane core (start, artifact, check, close, ask, answered, metrics, escalate, status, settle, brief) in `tools/workflow.mjs`.
4. Re-export signatures from `tools/workflow.mjs` for backward compatibility.
5. Keep `bin/nullform.mjs` passthrough byte-identical.
6. Verify all files < 1200 lines and frozen test suite remains green.
