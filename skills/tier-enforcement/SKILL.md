---
name: tier-enforcement
description: Enforce the task-tier protocol with a command instead of a paragraph. Use at the start of any non-trivial task, before writing code, and before declaring work complete.
---

# Tier Enforcement

Enforces the task-tier protocol via command-line gating when tier tracking is explicitly adopted by the user or project for non-trivial tasks.

Canonical protocol: read `<HARNESS>/core/PORTABLE.md` (or harness install root) for full lane requirements, artifact definitions, and evidence rules.

## The Commands

```bash
nullform workflow start --tier <T0|T1|T2|T3> --task "<task description>" [--no-dashboard]
nullform workflow artifact --kind <manifest|openspec|interfaces|oracle|recon> --path <file> [--detail "<text>"]
nullform workflow check
nullform workflow close [--force --reason "<why>"]
```
*(Also callable as `node '<HARNESS>/tools/workflow.mjs' ...`)*

State lives in `.workflow/state.json` (gitignored, per project). `start` auto-opens the dashboard by default; pass `--no-dashboard` (or `NF_NO_DASHBOARD=1`) for headless or lean execution.

## What Each Tier Requires

Requirements accumulate downward: T2 needs everything T1 needs, plus its own.

| Tier | Requires | Use when |
|---|---|---|
| **T0** | lane only | 1–2 known files, localized change, no architectural ambiguity |
| **T1** | + recon notes (files touched, acceptance check) | 3+ files, or an unfamiliar area needing small recon |
| **T2** | + manifest · openspec change · interfaces · oracle verdict | architecture decision, new module, multi-system change |
| **T3** | + isolated worktree per major slice (native first, or portable workspace) | multi-feature program or major migration |

## Core Enforcement Mechanisms

1. **`artifact --path` is checked on disk.** Claiming an artifact file that does not exist fails with exit code 1.
2. **`check` exits 1 while required artifacts are missing**, naming each gap and the exact command to provide it.
3. **`close` refuses an incomplete tier.** The only bypass is `--force --reason "<why>"`, which records the deviation visibly in state rather than silently skipping it.

## How to Behave

- **Run `start` when adopting tier tracking**, not retroactively. Pass `--no-dashboard` if browser visualization is not needed.
- **On T0, state it and move.** Trivial edits (e.g. typos, 1-line fixes in 1 known file) need no ceremony: `⚡ [T0] localized edit, no artifacts`.
- **Escalate honestly.** If mid-task discovery shows the work is T2, run `nullform workflow start --tier T2 --force --task "<updated>"` and proceed. Never down-classify to avoid artifacts.
- **A failing `check` means the task is incomplete**, regardless of code appearance. Report the gap truthfully.
