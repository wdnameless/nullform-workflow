# Run control

## ADDED Requirements

### Requirement: Start MUST accept validated mode and depth dials

`start` MUST accept `--mode full|semi|interview|manual` and
`--depth strict|normal|deep`, persist them in state, and reject invalid values
naming the allowed set.

#### Scenario: Invalid dial rejected
- **WHEN** start receives an unknown mode or depth
- **THEN** it fails naming the allowed values.

### Requirement: Brief MUST freeze with secrets redacted

`freezeBrief(text)` MUST write a dated immutable brief file with secrets
replaced by `[REDACTED:<NAME>]` before disk write; `oracleInput(changeId)`
MUST resolve to the frozen brief only.

#### Scenario: Secret never lands on disk
- **WHEN** a brief contains a token-shaped secret
- **THEN** the frozen file holds a placeholder, not the secret.

### Requirement: Requirements MUST carry type and status with recount

`parseRequirement(row)` MUST extract type (R/Ri/G/A/D) and lifecycle status;
`recount(manifest)` MUST derive counts mechanically from rows.

#### Scenario: Counts derived, not asserted
- **WHEN** rows change status
- **THEN** recount reflects the new counts without manual edits.
