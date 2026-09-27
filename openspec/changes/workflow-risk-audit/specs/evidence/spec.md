# Audit evidence

## ADDED Requirements

### Requirement: Reproducible findings

Each reported correctness or security defect MUST cite the path and line range responsible, a realistic invoking command or input, and an observable output/side effect or an explicit reasoning chain from source. Checks passing on their normal path MUST NOT be treated as proof of uncovered edge cases.

#### Scenario: A plausible defect survives review
- **WHEN** a reviewer identifies a data-loss or bypass path
- **THEN** the audit reproduces it in an isolated directory if practical and records the observed outcome.

#### Scenario: A claim does not survive reproduction
- **WHEN** code or a runtime probe contradicts a hypothesis
- **THEN** the audit removes or downgrades that claim rather than presenting it as proven.

### Requirement: No production mutation

The audit MUST NOT change live configs, commit project code or push a branch. Temporary fixtures MUST be cleaned up.

#### Scenario: Investigation ends
- **WHEN** the audit is delivered
- **THEN** live configuration and user data remain unchanged and disposable fixtures are gone.
