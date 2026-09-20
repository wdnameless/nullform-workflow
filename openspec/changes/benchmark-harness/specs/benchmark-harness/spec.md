# Benchmark harness

## ADDED Requirements
### Requirement: Measured runs in isolation
The harness SHALL execute each benchmark run in a fresh clone of the target repository, capturing agent exit code, wall-clock duration, git-derived lines added/removed, changed files, per-check results, and — when a transcript is supplied — cost from the session accounting tool.
#### Scenario: Two runs of the same task
- **WHEN** a task runs twice under one arm
- **THEN** two `bench/runs/*/result.json` files exist with independent metrics and the second run started from clean HEAD

### Requirement: Comparison report
`report` and `compare` SHALL aggregate runs by task and arm and print deltas (lines, duration, checks) without inventing numbers for missing data.
#### Scenario: No runs yet
- **WHEN** `report` runs before any benchmark run
- **THEN** it prints an honest empty message and exits 0

### Requirement: Safety seam
`run` SHALL refuse to execute without `--yes`, SHALL support `--dry-run` that performs no writes and no spawning, and SHALL exit 2 on a non-git root.
#### Scenario: Dry run
- **WHEN** `run --dry-run` is invoked
- **THEN** the planned commands are printed and no run directory is created
