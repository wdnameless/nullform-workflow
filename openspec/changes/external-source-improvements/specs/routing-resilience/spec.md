# Routing resilience

## ADDED Requirements

### Requirement: Triage MUST derive the lane from measured blast-radius

`suggestTier({ files, task })` MUST return `{ tier, rationale }`. The rationale
MUST name the measured signals: file count, directory spread, keywords.

#### Scenario: Lane rationale printed
- **WHEN** a file list and task are suggested
- **THEN** the result names the tier plus the signals that produced it.

### Requirement: Orchestrator contract MUST have declarative behavioral evals

Eval cases MUST be declarative `{ id, input, expect }` records.
`runEvals(cases, subject)` MUST return per-case `{ id, pass, detail }` and the
runner MUST exit nonzero when any case fails.

#### Scenario: Failing case reported
- **WHEN** a case expectation is not met
- **THEN** the report marks that case failed with a detail.

### Requirement: Tools MUST fail over in order and budgets MUST compact first

`withFallback([toolA, toolB], args)` MUST try tools in order, return the first
success, log the order, and throw when all fail. `checkBudget({ used, limit })`
MUST return `ok | compact | refuse`, with `compact` firing before `refuse` so
consumers can shrink context first.

#### Scenario: Fallback order exhausted
- **WHEN** every tool in the chain fails
- **THEN** the call throws and the log shows the attempted order.
