# Acceptance basis (no native review-evidence run)

This change cannot carry `review-evidence.json`: the mechanism requires a live
model dispatch (`NULLFORM_GATEWAY_API_KEY` or an admitted `openai` route), and
this environment has **no credentials**
(verified: `NULLFORM_GATEWAY_API_KEY` absent, `OPENAI_API_KEY` absent,
provider quota exhausted earlier with HTTP 429).

What was verified instead, all locally executed and cited by command:

- `task-claim` suite (the settle surface's direct consumer): 67 pass / 0 fail.
- Tamper-evidence test with the pinned integrity assertion: pass.
- `sync-manifest-coverage`: 3 pass / 0 fail (the new module is listed).
- A junction planted in `.tmp/worktrees` is not collected and outside data
  survives (`.tmp/probe-settle-junction.mjs`).
- A crashed gate probe throws instead of satisfying the tamper assertions
  (`.tmp/probe-gate-crash.mjs`).
- `eslint`, `code-size`, COCO ratchet, `agent-lint`: all green.

The change is a mechanical module move plus four one-condition hardenings and one
test-only change; every public name keeps its importer working through re-exports.
