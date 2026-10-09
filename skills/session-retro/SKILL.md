---
name: session-retro
description: Retrospective over recent agent sessions to find hidden repo and workflow inefficiencies. Use after failed or wasteful sessions, or on a regular cadence, to suggest navigation, guardrail, token-economy, and instruction improvements. Human-in-the-loop only — never auto-applies fixes.
---

# Session Retro

Run a retrospective over real agent sessions and suggest repo/workflow improvements for next time. The agent doing the work hides its struggles with persistence — a second pass over the session transcript sees what it papered over.

## When to run

- After a session that went wrong, felt slow, or burned unusual tokens.
- On a sampling cadence (e.g. weekly, or when you notice you "haven't run retro in a while").
- NEVER as an automated loop: each run needs a human to accept or reject findings.

## Inputs

- Session transcripts: `.jsonl` logs (see `node tools/usage-audit.mjs --help` for the default sessions dir, or pass `--sessions <dir>`).
- Optional focus: one session, the last N sessions, or the current session.

## Procedure

1. Collect sessions: `node tools/session-retro.mjs scan --sessions <dir> [--limit N] [--json]`.
2. For each flagged session, read the transcript and classify findings into categories:
   - **navigate**: codebase hard to navigate (missing codemap, vague names, deep imports).
   - **guardrail**: missing automated check (lint, test, CI step that would have caught it).
   - **standards**: coding standard the reviewer should enforce but doesn't.
   - **instructions**: global agents/prompt surface unhealthy (stale, duplicated, noop steering).
   - **tool-economy**: wrong tool for the job, repeated failing commands, missing MCP/plugin.
   - **context**: information the agent lacked and had to rediscover (missing glossary row, missing doc).
   - **tokens**: token waste (oversized reads, repeated full-file dumps, redundant retries).
   - **compaction**: context lost across compaction (repeated instructions that belong in a skill).
3. Rank findings by severity: most wasteful / most dangerous first, with the session evidence quoted.
4. Present findings to the human. Apply NOTHING without explicit approval per finding.
5. Record an accepted run: `node tools/session-retro.mjs record --state <path>`.

## Rules

- One finding = one session quote + one concrete fix. No vague "improve docs".
- False positives are expected — the human discards them, the tool never re-applies.
- Fixes go through the normal workflow lanes (T0/T1/T2), not through retro itself.
- NEVER run retro on a schedule that writes code. Sampling + human judgment only.
