# eval-metrics — spec deltas

## ADDED Requirements

### Requirement: Report aggregates pass@k and pass^k
Report and compare SHALL show pass@k (solved at least once in K runs) and
pass^k (solved in all K runs) per task×arm and across the task set.

#### Scenario: Mixed results aggregate correctly
- **WHEN** task A passes 5/5, B 4/5, C 1/5, D 0/5
- **THEN** pass@5 = 75% (A,B,C) and pass^5 = 25% (A only).

#### Scenario: Single run degenerates to pass
- **WHEN** K = 1
- **THEN** pass@1 = pass^1 = task pass rate.
