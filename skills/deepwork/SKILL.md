---
name: deepwork
description: High-cost orchestrator workflow for large, high-risk, multi-phase coding with review gates. Do NOT activate for routine multi-file changes.
---

# Deepwork — Gated Multi-Phase Delivery

Activated ONLY when work is genuinely large or high-risk: multiple dependent delivery phases, cross-cutting architectural change, or sustained specialist coordination.
Do NOT activate for routine multi-file changes, docs, or simple bug fixes.

Canonical protocol: read `<HARNESS>/core/PORTABLE.md` (or harness install root) for full wave definitions, interface rules, fleet execution, and evidence gates.

## State Management

Maintain a progress file at `.deepwork/<task-slug>.md` (gitignored). Record:
- Current goal and phase order.
- Accepted research and interfaces (referenced strictly by path, never pasted).
- Specialist ownership and one-line rationale per review gate.
- Per-phase validation evidence and residual risks.

## Phase Gates

1. **Split into coherent delivery phases** along natural dependency and delivery boundaries.
2. **Execute via delegation**: orchestrator schedules and reviews; specialists implement.
3. **Validate with evidence**: after each phase, verify with real command/test outputs before triggering review.
4. **Independent review gate**: pass planned `@oracle` review against established context before proceeding.
5. **Atomic boundaries**: commit at each independently valid phase boundary before starting the next phase.

## Review Budget

- Each planned review gate receives ONE initial review and at most TWO re-reviews.
- Re-reviews must prioritize unresolved material findings and risks introduced by remediation. Do NOT reopen accepted, unchanged concerns.
- If re-reviews are exhausted, record residual risk in the progress file and request explicit user direction.

## Designer Handoff Guardrail

When a phase includes `@designer`, delivered UI is ACCEPTED DESIGN INTENT for all downstream phases:
- Preserve layout, hierarchy, motion, spacing, color, and component feel.
- Downstream `@fixer` performs bounded mechanical wiring/tests/types only.
- Visual or styling changes must be routed back to `@designer`.
