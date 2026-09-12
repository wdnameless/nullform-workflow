---
name: grill-me
description: "Wave 0 interview for T2/T3 tasks: turn a dictated idea into explicit forks, constraints, and success criteria BEFORE any spec or code. Runs the `grilling` design-tree mechanic; output goes through ONE structured `ask` widget call per round, never chat text."
---

# Grill Me — Wave 0 Interview Protocol

**Mechanics live in `skill://grilling`** (design tree, frontier, rounds, facts-via-subagents, shared-understanding gate). Read it first. What this file adds is the harness binding:

- **Each round renders as ONE `ask` widget call** — every ❓ question of the frontier = one widget question (2–5 options, tradeoffs in descriptions, `recommended` index set). Never print rounds as chat markdown.
- Rounds iterate until the frontier is empty, then the confirmation gate (grilling's rule) — no spec, no code before it.
- Facts are yours, not the user's: repo/tool lookups and @scout subagents for anything the environment can settle; only decisions go to the widget.
- Answers land in the manifest (status changes, constraints), not in chat history.
- Redact secrets from answers before any file write (rule://enterprise-directives §9).
- A cancelled ask = user declined the interview: state assumptions in one line, record them, proceed.

## Coverage checklist (what the tree must reach)
- Success criteria — observable ("user can X", "command Y exits 0")
- Scope edges — what is explicitly OUT
- Blocking unknowns — payments/hosting/accounts: resolved or marked `placeholder`, never silent stubs
- Constraints — stack, deadlines, systems to respect, must-not-break
- Failure modes — empty states, errors, interruptions, limits (the brief names none)
