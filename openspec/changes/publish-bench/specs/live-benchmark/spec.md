# Live benchmark

## ADDED Requirements

### Requirement: Live session measurement

`tools/measure-session.mjs` SHALL measure a real session from
`.workflow/state.json` + journal beats + usage snapshots:
per-role normalized units (output×5 + write×1.25 + read×0.1),
wall/active time, tests count. Deterministic re-run on same inputs.

#### Scenario: Universal-1 session
- **WHEN** run against the universal-1 session artifacts
- **THEN** it emits roles/total/time/tests JSON, stable across runs

### Requirement: Published live comparison

`docs/benchmark-live.md` SHALL table our live numbers against
autopilot's published benchmark.md (29.4M→21.1M units, 145→96 min,
review −51%, orchestrator −46%) with method notes and caveats.

#### Scenario: Comparison present
- **WHEN** the doc is read
- **THEN** every autopilot figure has our counterpart or an honest gap note
