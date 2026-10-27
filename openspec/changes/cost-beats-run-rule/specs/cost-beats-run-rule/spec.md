# Cost accounting, run-rule, beats-log

## ADDED Requirements

### Requirement: Per-role cost accounting
`session_cost.py` SHALL aggregate normalized cost units by agent role
when `--by-role` is passed, using W_OUT=5 / W_WRITE=1.25 / W_READ=0.1.

#### Scenario: Role grouping
- **WHEN** a fixture jsonl with orchestrator + executor entries is processed
- **THEN** output shows per-role units and shares summing to the total

### Requirement: No rule without a run
The reviewer PR-body lens SHALL require one measured run for every new
gate/skill/rule, proving it fires and what it costs.

#### Scenario: Missing proof
- **WHEN** a patch adds a gate with no measured run cited
- **THEN** the reviewer raises a finding (P1 minimum)

### Requirement: Tool-written beats clock
Workflow events SHALL record beats via `recordBeat`; working time SHALL
equal beats-deltas (≤45m) minus archived waits.

#### Scenario: Scripted journal
- **WHEN** beats span 10m with a 3m wait inside
- **THEN** honestTime reports 7m
