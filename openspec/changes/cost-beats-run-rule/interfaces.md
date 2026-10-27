# cost-beats-run-rule — interfaces

Functions-first: three independent functions → three modules. No shared
zone (each slice owns its files; the only common node is the manifest).

## T1: `tools/session_cost.py` (owner: @fixer)

- New flag: `--by-role` (alongside existing grouping flags).
- New pure function: `role_of(agent_name: str) -> str` — maps agent/session
  names to orchestrator/executor/reviewer/oracle/other (regex table, order
  matters; orchestrator exact-match first).
- Extended output: per-role table (steps, normalized units, share %) +
  existing totals unchanged. Default output byte-identical when flag absent.
- Test: `tools/tests/test_session_cost.py::test_by_role_*` on a synthetic
  .jsonl fixture (no live sessions).

## T2: `agent/agents/reviewer.md` (owner: @sonic)

- One sentence appended to the PR-body (evidence gate) lens:
  "A new gate/skill/rule owes one measured run proving it fires and what
  it costs — else finding (P1 minimum)."
- No other line touched. prompt-lint sizes must stay green.

## T3: beats persistence (owner: @fixer)

Correction (Wave 3 finding): no journal object exists in workflow.mjs —
events go through logEvent() into .workflow/events.jsonl, and
measure-session.mjs already derives beats from events as fallback.
So instead of calling recordBeat into a nonexistent object:
- `tools/journal.mjs`: UNTOUCHED (recordBeat/askKind/answered/honestTime
  already correct).
- `tools/workflow.mjs`: in logEvent(), after appending the event line,
  also append the event timestamp to state.beats in .workflow/state.json
  (cap 2000, drop oldest — same constants as journal.mjs). One function
  touched, no signature changes, failure silent (observability, not gate).
- New test `tools/tests/workflow-beats.test.mjs`: (1) scripted journal
  (2 beats 10m apart + 1 wait of 3m) → honestTime == 7m; (2) logEvent
  writes a beat readable from state.json (tmp .workflow dir).
- Dashboard + measure-session: UNTOUCHED (already prefer state.beats
  when present — this change feeds that exact path).
