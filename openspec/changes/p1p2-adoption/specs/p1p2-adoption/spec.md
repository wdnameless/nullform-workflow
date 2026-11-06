# P1+P2 adoption

## ADDED Requirements

### Requirement: Requirement-to-verification traceability
Manifests with a `verify` column SHALL require a non-empty verification
criterion for every requirement row; manifests without the column keep working.

#### Scenario: Missing verify
- **WHEN** a manifest declares `verify` in the header and a row leaves it empty
- **THEN** `workflow check` reports the row and refuses

#### Scenario: Legacy manifest
- **WHEN** a manifest has no `verify` column
- **THEN** validation behaves exactly as before

### Requirement: Adversarial review mode
Reviewer SHALL support an adversarial mode that produces at least three
falsification scenarios with evidence instead of confirmation.

#### Scenario: Adversarial output
- **WHEN** review runs in adversarial mode
- **THEN** the result lists ≥3 failure scenarios, each with evidence or a
  stated unverified reason

### Requirement: Per-lane cost ceiling
Lane budgets SHALL support a USD ceiling; close SHALL record actual cost and
flag overruns, and missing tariffs SHALL be unverified rather than passing.

#### Scenario: Overrun recorded
- **WHEN** lane cost exceeds `maxCostUsd`
- **THEN** status and the close metric both report the overrun

#### Scenario: Unknown cost
- **WHEN** no tariff is available for the session
- **THEN** cost is reported `unverified`, never `pass`

### Requirement: Performance check for hot paths
Diffs touching hot paths SHALL carry a before/after measurement or an explicit
`n/a` reason from the reviewer.

#### Scenario: Hot path touched
- **WHEN** a change modifies dashboard, HTTP, or collector code
- **THEN** the review records a measurement or an explicit n/a reason

#### Scenario: Docs-only change
- **WHEN** only documentation changes
- **THEN** the perf check does not fire

### Requirement: Cross-model critique
Oracle SHALL support an optional second pass with a different model;
disagreement SHALL escalate. Without the flag the behaviour is unchanged.

#### Scenario: Disagreement escalates
- **WHEN** cross-model is enabled and verdicts differ
- **THEN** the change is escalated rather than accepted

#### Scenario: Flag absent
- **WHEN** cross-model is not requested
- **THEN** a single oracle pass runs as today
