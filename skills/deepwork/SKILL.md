---
name: deepwork
description: High-cost orchestrator workflow for large, high-risk, multi-phase coding with review gates. Do NOT activate for routine multi-file changes.
---

# Deepwork — Gated Multi-Phase Delivery

Use ONLY when the work is genuinely large or high-risk: multiple dependent phases,
cross-cutting architectural change, an unsafe-to-partially-ship migration, or
sustained coordination across several specialist lanes.

Do NOT infer Deepwork from "touches multiple files". Not for trivial edits, docs,
simple bug fixes, or routine bounded features.

## State

Maintain a progress file at `.deepwork/<task-slug>.md` (gitignored). It holds, as
applicable: current goal; accepted research (by path, not pasted); plan drafts and
gate order; per-phase status; validation evidence; unresolved questions.

Update it after every major decision, accepted research, review, phase completion,
and scope change. Reference files by path — never copy their contents in.

## Phase Gates

1. Draft a plan; split into coherent delivery phases along dependency and delivery
   boundaries. Do NOT split phases merely to shrink a review's scope.
2. Declare, UP FRONT, in the deepwork file: phase order, specialist ownership,
   gate order, one-line rationale per gate. Share the compact version with the user.
3. Before each phase: replace the todo list with actionable todos for THAT phase.
4. Execute via the scheduler model (delegate; do not implement in the orchestrator lane).
5. After each phase: run validation, record evidence in the deepwork file, then pass
   the planned `@oracle` gate. Record the phase goal, changed paths, evidence, and
   the specific decision/risk under review — so Oracle reviews established context
   instead of repeating discovery.
6. If the phase changed module boundaries, dependency direction, or file placement,
   run an `@explorer` structure scan in PARALLEL with the Oracle gate.
7. Reconcile findings → ONE bounded remediation pass → validate with focused evidence.
8. Commit at each independently valid delivery boundary before starting the next phase.

## Review Budget

Each planned Oracle gate gets ONE initial review and at most TWO re-reviews.
Request a re-review only when remediation materially changed the reviewed decision,
or when the original concern cannot be verified with focused evidence. Never spend a
re-review on a mechanical or already-verified change. State the attempt in every
Oracle prompt: `Gate 2 — attempt 2 of 3 (1 re-review remaining)`.

Re-reviews must prioritize unresolved material findings and risks introduced by
remediation, and must NOT reopen accepted, unchanged, or resolved concerns. When the
re-reviews are exhausted, record the residual risk and ask the user to accept the
risk, change scope, or authorize an exceptional review.

## Designer Handoff Guardrail

When a phase includes `@designer`, the delivered UI is ACCEPTED DESIGN INTENT for
all later phases. Record its key decisions in the deepwork file. Afterwards:

- preserve layout, rhythm, hierarchy, motion, spacing, color, affordances, responsiveness;
- `@fixer` may do bounded mechanical follow-up ONLY that preserves the design exactly
  (wiring, tests, type fixes, non-visual behavior);
- route any visual, responsive, motion, hierarchy, polish, or component-feel change
  back to `@designer`;
- if design intent must change, record WHY before changing it.

## Completion

Final validation against the plan, then a concise summary. The deepwork file is the
durable record of what was decided and what remains uncertain.
