# Dashboard live parity

## ADDED Requirements

### Requirement: Autopilot run-view layout
The run view SHALL render hero (state color + WIP badge + 1-line summary),
8-stage track, waves task matrix with per-task state colors and repair
counters, verbatim requirements with R/Ri/G/A/D badges and status filters,
G1–G4 grid, timing block, event feed, and the pending human question inside
the orange hero when waiting.

#### Scenario: Full information without chat
- **WHEN** the user opens the run view of an active run
- **THEN** summary, stages, tasks, requirements, gates, timing, feed and
  the pending question are all visible without CLI or chat

### Requirement: Live polling and frozen silence
Polling SHALL be configurable 1–3s (default 2s) with a 1s client clock
tick and full re-render on rev change. Frozen snapshots SHALL perform
zero fetches and zero timer drift.

#### Scenario: Live tick
- **WHEN** the run view is open on a running task
- **THEN** active/wait clocks advance each second and data refreshes ≤3s

#### Scenario: Frozen silence
- **WHEN** the frozen snapshot is opened
- **THEN** no fetch to /api/state occurs and no timer mutates the display
