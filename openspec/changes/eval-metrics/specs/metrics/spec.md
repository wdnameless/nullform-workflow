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

### Requirement: LM cassettes replay deterministically at zero cost
Recorded LM transcripts SHALL replay byte-identical responses for matching prompts
and fail loudly on mismatch; replay runs SHALL cost $0.

#### Scenario: Replay hit returns recorded bytes
- **WHEN** replaying a cassette with the recorded prompt
- **THEN** output equals recorded bytes and usage cost is 0.

#### Scenario: Prompt drift fails loudly
- **WHEN** replaying with a changed prompt under --strict
- **THEN** exit is 1 with a STALE/drift message naming the prompt hash.

#### Scenario: Secrets never land in cassettes
- **WHEN** verifying a cassette containing an API key pattern
- **THEN** verify fails naming the offending turn.
