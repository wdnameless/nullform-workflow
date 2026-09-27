# Verification honesty

## ADDED Requirements

### Requirement: A check never passes when its subject is absent

A verification or audit check SHALL report a failure or an explicit not-configured status
when the file or directory it inspects does not exist. It SHALL NOT report success.

#### Scenario: Missing agent definitions

- **WHEN** the agent-definition directory does not exist
- **THEN** the role-definition check fails instead of reporting that every definition is valid.

#### Scenario: Missing MCP configuration

- **WHEN** the MCP configuration file does not exist
- **THEN** the pinning check reports not-configured rather than clean.

#### Scenario: Missing glossary

- **WHEN** the project glossary does not exist
- **THEN** the glossary-coverage check reports not-configured rather than clean.

#### Scenario: Stale architectural map

- **WHEN** files have changed since the map was generated
- **THEN** the currency check reports a failure with the changed-file count.

### Requirement: Both profiles classify prerequisites identically

The install profile and the audit profile SHALL classify the same missing prerequisite with
the same status, so a caller cannot read an unconfigured environment as a passing one.

#### Scenario: Same missing prerequisite

- **WHEN** the same prerequisite is absent in both profiles
- **THEN** both profiles emit the same status for it.

### Requirement: A check is named for what it executes

A check whose label claims a parse SHALL perform that parse. A check that matches patterns
SHALL be named for pattern matching.

#### Scenario: Claimed YAML parse

- **WHEN** a check is labelled as parsing a configuration file
- **THEN** a syntactically invalid file fails the check even if the expected substrings are present.

#### Scenario: Corrupted upstream output

- **WHEN** a check consumes another tool's structured output and that output cannot be parsed
- **THEN** the check fails and reports the parse error.

### Requirement: Destructive operations stay inside their root

A routine that deletes files SHALL verify each candidate resolves inside the root it was given,
before deleting it.

#### Scenario: Candidate outside the root

- **WHEN** a delete candidate resolves outside the harness root
- **THEN** it is reported as failed and left on disk.

#### Scenario: Runtime files are not orphans

- **WHEN** the harness root contains runtime state written by the host agent
- **THEN** the orphan scan does not report those files as prunable.
