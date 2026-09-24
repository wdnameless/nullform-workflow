# Durable workflow state

## ADDED Requirements

### Requirement: Monotonic tier escalation
Escalation SHALL preserve task identity, start time and prior evidence while adding higher-tier requirements.

#### Scenario: T1 investigation expands to T2
- **WHEN** recon was recorded before escalation
- **THEN** the same task retains recon and requires the remaining T2 evidence.

### Requirement: Serialisable state mutation
Two processes targeting one project SHALL not silently overwrite each other's task or artifact state.

#### Scenario: Concurrent artifact recording
- **WHEN** distinct evidence records race from two processes
- **THEN** both persist or one operation explicitly fails without falsely claiming success.

### Requirement: Recoverable terminal record
Closing a task SHALL yield exactly one terminal metric despite interruption between state and metric writes.

#### Scenario: Interrupted close
- **WHEN** persistence stops after closed state is durable
- **THEN** restart/reconciliation restores the missing terminal record once.

### Requirement: Source-bound and content-bound acceptance
Artifacts SHALL resolve inside the project and verdict freshness SHALL depend on source content and path membership, not timestamp alone.

#### Scenario: Symlink and touch
- **WHEN** an artifact symlink points outside the project
- **THEN** registration fails.
- **WHEN** an accepted file is touched but its content hash is unchanged
- **THEN** ordinary close succeeds.
