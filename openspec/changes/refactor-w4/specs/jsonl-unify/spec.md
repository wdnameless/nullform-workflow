# JSONL unify

## ADDED Requirements

### Requirement: Single session-log module

tools/session-log.mjs SHALL provide readJsonlSafe/findNewestSession/
transcriptTokens; dashboard-collectors, cache-doctor, cost-snapshot,
measure-session SHALL use it; their local duplicates SHALL be removed.

#### Scenario: No duplicates
- **WHEN** the 4 consumers are grepped for local JSONL parsing
- **THEN** none remains outside session-log.mjs

### Requirement: Consumers green

All test suites of the 4 consumers SHALL pass unchanged in behavior.

#### Scenario: Suites green
- **WHEN** affected suites run
- **THEN** all pass
