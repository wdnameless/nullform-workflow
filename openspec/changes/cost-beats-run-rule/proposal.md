# cost-beats-run-rule — proposal

## Why
Scoring vs nick-vels/skills (7.9 vs 7.1) found three concrete gaps, all
measured, all with "бери" from the user: (1) no per-run cost accounting
by role — we can't price our own rules; (2) new gates/skills ship without
a proving run; (3) the working clock depends on page-observed beats
instead of tool-written ones with waits subtracted.

## What Changes
- **T1 `session_cost.py --by-role`.** Extend the existing aggregator:
  agent-name → role mapping (orchestrator/executor/reviewer/oracle/…),
  normalized units (W_OUT=5, W_WRITE=1.25, W_READ=0.1, already our
  documented formula), per-role table + shares. Fixture-tested.
- **T2 reviewer lens line.** One sentence in the PR-body (evidence gate)
  lens: a new gate/skill/rule owes one measured run proving it fires
  and what it costs — else finding. Prompt-lint stays green.
- **T3 beats wiring.** `journal.mjs` exists; wire the missing
  `recordBeat` calls at workflow event points (start/stage/ticket/close)
  so `honestTime` (beats ≤45m minus waits) is tool-written end-to-end;
  dashboard already renders it. Proven by a scripted 2-beats+1-wait run.

## Non-Goals
- New dashboard UI (rendering exists).
- Changing normalized weights (documented, shared with benchmark-live).
- Touching browser skills, gates' thresholds, or live-tree files.
