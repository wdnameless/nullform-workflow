# Integration and policy

## ADDED Requirements

### Requirement: Atomic Paseo profile configuration
An interrupted update SHALL leave either the complete old or complete new valid JSON, without losing unrelated profile fields.

#### Scenario: Failure before replace
- **WHEN** a sandbox writer fails after generating new content but before installation
- **THEN** the original config remains valid and unchanged.

### Requirement: Verified required plugins
A pinned required plugin whose installed version is absent SHALL fail doctor; optional unknown versions SHALL warn.

#### Scenario: Name-only plugin report
- **WHEN** the required plugin name is present but its version cannot be verified
- **THEN** doctor reports FAIL.

### Requirement: Consistent instructions and honest worker evidence
Active OMP, Paseo and skill prompts SHALL express one conditional interview policy and one return contract. Reconciliation SHALL validate actual worker output, not a fixture or boolean alone.

#### Scenario: Worker claims tests passed without executing them
- **WHEN** a subagent returns a bare success boolean without command/count evidence
- **THEN** the parent does not mark the task verified.

### Requirement: Explicit skill parity and portable claims
Default skill diagnostics SHALL not report all checks passed when repository comparison was absent. Sync and quickstart documentation SHALL state what was and was not verified.

#### Scenario: Comparison root missing
- **WHEN** the default comparison path cannot be found
- **THEN** output says parity unverified or exits nonzero, not green parity.

### Requirement: Memory remains optional on outage
An unavailable Hindsight call SHALL not stall a coding task indefinitely, cause repeated immediate retries, or generate a fictitious recall result.

#### Scenario: Memory server unavailable
- **WHEN** recall times out
- **THEN** the orchestrator proceeds using local context with a visible unavailable note.
