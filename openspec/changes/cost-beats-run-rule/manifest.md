# Manifest — cost-by-role, no-rule-without-run, beats-log

Source: scoring recon `.tmp/recon-workflow-scoring.md` (T1/T2/T3) + user "бери" (2026-10-27).

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Per-run cost accounting by role with normalized units, extending session_cost.py | "T1 (their best, our gap): per-run cost accounting by role with normalized units" | open |
| R02 | Every new gate/skill owes one measured run proving it fires and what it costs ("no rule without a run") | "T2 (their habit worth copying): 'no rule without a run'" | open |
| R03 | Beats-log: working clock written by the tool with waits subtracted, surviving sleep/dead server | "T3 (their dashboard beats): waits-subtracted working clock, beats log written by the tool" | open |
| R04 | Nothing breaks: all existing gates stay green, no behavior change outside the three slices | "Бери" (in the context of the scoring lane's non-breaking execution) | open |

## Constraints (recon facts — challengeable)

- C1: `tools/session_cost.py` aggregates by provider/model/agent/day; role must be derived (agent-name → role mapping), normalized units W_OUT=5/W_WRITE=1.25/W_READ=0.1 already documented in docs/benchmark-live.md:61.
- C2: `tools/journal.mjs` (recordBeat/askKind/answered/honestTime) EXISTS and `measure-session.mjs` consumes it; T3 = wire missing recordBeat calls + prove waits-subtraction end-to-end, not a rewrite.
- C3: Reviewer prompt surface: PR-body lens at agent/agents/reviewer.md:113 is the anchor for R02 (user approved prompt-surface edits with "бери").
- C4: Orchestrator (this session) writes NO project code on T2 — only specs/manifest/interfaces/git.

## Acceptance (observable)

- A1: `tools/session_cost.py --by-role <jsonl>` prints per-role normalized units; unit test proves grouping on a fixture.
- A2: reviewer.md contains the no-rule-without-run sentence; prompt-lint sizes green.
- A3: a scripted run (2 beats + 1 wait interval) yields honestTime = beats-delta − wait; dashboard shows the subtracted clock.
- A4: code-size PASS, clone PASS, eslint exit 0, quality = same 3 foreign violations.
