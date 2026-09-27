# Lane gate

## ADDED Requirements

### Requirement: An abandoned lane does not block the project

The lane gate SHALL treat a lane left open beyond a configured window as abandoned: it
reports the owning session and the lane's age, and offers a release path, instead of
refusing every subsequent start with no explanation.

#### Scenario: Lane abandoned by a crashed session

- **WHEN** a lane has been open longer than the configured window and no work has been recorded against it
- **THEN** start reports the lane as abandoned, names the owning session, and offers to release it.

#### Scenario: Active lane still blocks

- **WHEN** a lane is open and within the window
- **THEN** start refuses a second lane and names the owning session, as today.

#### Scenario: Released lane is attributable

- **WHEN** an abandoned lane is released
- **THEN** the released lane's task, tier, start time and owning session are recorded rather than discarded silently.

### Requirement: A deviation record names what was missing

When a lane closes with a forced deviation, the recorded deviation SHALL list the missing
artifact kinds as readable names.

#### Scenario: Forced close with missing artifacts

- **WHEN** a task closes with force while tier artifacts are missing
- **THEN** the persisted deviation lists those artifact kind names, and the console line names them.

### Requirement: An unknown command is an error

The tier CLI SHALL exit nonzero when invoked with an unrecognised subcommand.

#### Scenario: Misspelled subcommand

- **WHEN** the CLI is invoked with a subcommand it does not implement
- **THEN** it prints usage and exits nonzero.

### Requirement: Artifact recording validates the artifact, not the note

Recording an artifact SHALL apply a content pattern to the artifact's file body. It SHALL NOT
apply that pattern to the free-text note a human writes about the artifact.

#### Scenario: Recording a valid manifest with a prose note

- **WHEN** an operator records a manifest file that contains requirement rows, with a note that describes the work in prose
- **THEN** the recording succeeds, because the row pattern was satisfied by the file.

#### Scenario: Recording a manifest whose body has no rows

- **WHEN** an operator records a manifest file that contains no requirement rows
- **THEN** the recording fails and names the missing pattern.
