# Workflow hardening

## ADDED Requirements
### Requirement: Heuristic tier suggestion
`workflow.mjs suggest --files ...` SHALL output tier, confidence and concrete reasons without claiming ML.
#### Scenario: Small local edit
- **WHEN** 1 known file changed
- **THEN** suggestion is T0 with reasons; 10 files or schema keyword raises tier

### Requirement: Per-tier configurable budgets
Budgets SHALL come from .workflow/budgets.json with documented defaults and no universal provider quota.
#### Scenario: Custom budget
- **WHEN** budgets.json sets T1:20
- **THEN** start prints budget 20 for T1

### Requirement: Guarded autonomous T0
Auto mode SHALL require explicit opt-in flags, allowlist, diff cap and refuse above T0; every auto action recorded.
#### Scenario: Unsafe auto attempt
- **WHEN** --auto requested for a T2-sized change
- **THEN** command refuses and records the refusal

### Requirement: CI gate and auto-review
Shipped CI template SHALL run validate/tests/archmap/workflow-check; auto-review CLI SHALL fail on critical/high problems and never edit code.
#### Scenario: Cycle in PR
- **WHEN** a new cycle is scanned in CI
- **THEN** auto-review exits 1 and prints Russian explanation
