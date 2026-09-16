---
name: tier-enforcement
description: Enforce the task-tier protocol with a command instead of a paragraph. Use at the start of any non-trivial task, before writing code, and before declaring work complete.
---

# Tier Enforcement

## Why this is a command and not a rule

The lane protocol and its 4-Wave artifacts were written as prose in the agent
prompt. Measured across 38 real sessions:

| Rule | Form | Compliance |
|---|---|---|
| `openspec` change scaffolded | external command | **84%** |
| memory retained | tool call | 52% |
| manifest with verbatim quotes | prose rule | 36% |
| interfaces contract | prose rule | 31% |
| `CONTEXT.md` glossary used | prose rule | 13% |
| lane verdict in the response | prose rule | **0.7%** |

The pattern is unambiguous: **the easier a rule is to silently skip, the less it
is followed.** A rule with an exit code is followed. This skill makes the protocol
executable.

## The command

```bash
node '<HARNESS>/tools/workflow.mjs' start --tier T2 --task "add rate limiting to the API"
node '<HARNESS>/tools/workflow.mjs' artifact --kind manifest --path openspec/changes/x/manifest.md
node '<HARNESS>/tools/workflow.mjs' check
node '<HARNESS>/tools/workflow.mjs' close
```

State lives in `.workflow/state.json` (gitignored, per project).

## What each tier requires

Requirements accumulate downward: T2 needs everything T1 needs, plus its own.

| Tier | Requires | Use when |
|---|---|---|
| **T0** | lane only | 1–2 known files, localized, obvious |
| **T1** | + recon notes (files touched, acceptance check) | 3+ files, or an unfamiliar area |
| **T2** | + manifest · openspec change · interfaces · oracle verdict | architecture, new module, multi-system |
| **T3** | + isolated worktree per major slice | a program of work |

## The three mechanisms that make it real

1. **`artifact --path` is checked on disk.** Claiming a manifest you did not write
   fails with exit 1. This is the core anti-fabrication guard: the command verifies
   the file exists, so "I recorded it" cannot substitute for having made it.
2. **`check` exits 1 while anything is missing**, naming each gap and the exact
   command to close it. Wire it into CI, a pre-commit hook, or your close-out step.
3. **`close` refuses an incomplete tier.** The only way past is
   `--force --reason "<why>"`, which **records the deviation** in state so it is
   visible in review rather than silently absorbed. An unexplained shortcut is the
   thing this exists to surface.

## How to behave

- **Run `start` before the first edit**, not after. The tier is a decision about
  how much process the work needs; deciding it after the fact is rationalisation.
- **The tier and the lane verdict are one decision.** Do not write `⚡T0` in prose
  and then `start --tier T2` — pick one and be consistent.
- **On T0, say it and move.** The gate exists for non-trivial work; a typo fix
  does not need ceremony. One line: `⚡ [T0] typo in one known file, no artifacts`.
- **Escalate, never quietly shrink.** Discovering mid-task that the work is a T2
  is normal — re-run `start --tier T2 --force --task "<updated>"` and proceed.
  Down-classifying to avoid artifacts is the failure mode this prevents.
- **A failing `check` means the task is not done,** regardless of how good the code
  looks. Report the gap, do not narrate past it.
