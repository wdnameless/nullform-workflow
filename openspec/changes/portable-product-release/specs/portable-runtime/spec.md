## ADDED Requirements

### Requirement: Data-preserving recoverable installation
The runtime SHALL preserve user-owned instructions, configuration and edited assets during installation/update and SHALL commit the last verified installation identity atomically. It SHALL reject escaped destinations/journals before mutation and SHALL recover or fail explicitly after interruption rather than leaving an unrecoverable mixed state.

#### Scenario: Failed application after earlier writes
- **GIVEN** an existing verified installation and human-edited assets
- **WHEN** a deterministic write failure interrupts application before completion
- **THEN** the prior verified identity remains intact and recovery/retry restores a coherent installation without losing human bytes
- **AND** the CLI does not report complete success

#### Scenario: Concurrent application
- **GIVEN** one active installation application for the same identity
- **WHEN** another process attempts an overlapping application
- **THEN** it is refused or serialized through a single ownership boundary without lost updates

#### Scenario: Global package advances but target reapplication fails
- **GIVEN** a global npm binary at the new version and a last verified target identity at the previous version
- **WHEN** target application fails or its process is interrupted
- **THEN** doctor/status report the version divergence as pending or recoverable, not clean or fully updated
- **AND** retry uses the last verified identity and valid recovery records to complete coherently without treating partially deployed package bytes as human edits

#### Scenario: Abandoned installation owner
- **GIVEN** a prior owner process stopped while retaining a lock and incomplete application
- **WHEN** a subsequent application checks that owner
- **THEN** a verified dead owner allows scoped recovery and reacquisition, while a live or uncertain owner is not displaced
- **AND** an abandoned lock cannot permanently block every future valid application


### Requirement: Node-native usable workflow front door
The installed package SHALL expose core project workflow gates through its public CLI, reusing existing parser/dispatch behavior without absolute installed-root discovery or shell interpolation. Basic init/doctor/update and T0/T1 workflow operations SHALL not require an unrelated harness runtime.

#### Scenario: Non-OMP core workflow
- **GIVEN** a Node runtime and a selected non-OMP configuration adapter without OMP or Bun
- **WHEN** the user initializes configuration and runs the documented T1 declaration/recon/check/close through nullform
- **THEN** the core path completes or reports exact host setup prerequisites without invoking OMP/Bun

### Requirement: Explicit capability boundaries
The CLI SHALL distinguish configuration deployment, basic workflow gates, actual native host presence and supported automated review/execution. It SHALL not claim tested native execution merely from copied files or silently route an unsupported host through another engine.

#### Scenario: Unsupported automated reviewer
- **GIVEN** a configuration adapter without a certified automated review transport
- **WHEN** that user requests automated review
- **THEN** the operation fails explicitly before dispatch with the capability/prerequisite and no fabricated acceptance
