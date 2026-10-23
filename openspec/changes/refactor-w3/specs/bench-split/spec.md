# Bench split

## ADDED Requirements

### Requirement: Analytics and smoke extracted

summarizeRuns/compareArms SHALL live in tools/bench-analytics.mjs;
runSmoke/validateTasks/loadSmokeRuns in tools/bench-smoke.mjs;
benchmark.mjs main SHALL be a router ≤60 lines.

#### Scenario: Router thin
- **WHEN** main body is measured
- **THEN** ≤60 lines of dispatch

### Requirement: Bench behavior invariant

All exports consumed by run-skill-benefit-eval.mjs,
lm-replay.test.mjs, benchmark.test.mjs SHALL stay importable
from benchmark.mjs (direct or re-export); benchmark.test.mjs green;
CLI golden match.

#### Scenario: Imports intact
- **WHEN** consumers import from benchmark.mjs
- **THEN** no import errors and identical behavior
