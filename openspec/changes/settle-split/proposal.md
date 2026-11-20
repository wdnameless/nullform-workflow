# Settle lifecycle extraction and containment hardening

## Why

`tools/workflow-ci.mjs` grew to 1234 lines, past the 1200-line acceptance of issue
#16, and its settle target collection used the lexical-only containment check: a
junction planted inside `.tmp/worktrees` passed collection and reached a recursive
delete outside the project. The same session also found a test that cannot fail —
the controlled-HTTP `gate()` helper returned the exact `{ok:false}` shape the tamper
test asserts, so a crashed probe satisfied it.

## What Changes

- The settle block (git-ref guards, target resolution, removal, `cmdSettle`) moves to
  `tools/workflow/settle.mjs`; `workflow-ci.mjs` re-exports every public name.
- All four settle target checks pair the lexical test with `isRealPathInsideRoot`.
- The fixture `gate()` throws when its probe crashes; the tamper test pins the genuine
  integrity error text.
- The stale monolith defer marker is removed from `tools/workflow.mjs`.
