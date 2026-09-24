# CI evidence

## ADDED Requirements

### Requirement: Validate every declared heavy change
A T2/T3 PR SHALL fail when its changed OpenSpec directory was deleted, split by shell whitespace, or otherwise not actually validated.

#### Scenario: Deleted change
- **WHEN** a T2 PR deletes its only changed OpenSpec directory
- **THEN** CI exits nonzero rather than completing with zero validated directories.

### Requirement: Positive and current acceptance
CI SHALL accept only an explicit positive verdict for the current manifest, specifications and interface contract.

#### Scenario: Negated verdict or later requirement edit
- **WHEN** the report says `NOT ACCEPTED`, or a later commit changes a requirement after the report
- **THEN** `check-ci` exits nonzero.

### Requirement: Lower bound on lean tier
A PR labelled T0 SHALL include at most two changed files unless an explicit reviewed override is recorded.

#### Scenario: Twenty-four-file T0 PR
- **WHEN** T0 is declared for a PR changing more than two files
- **THEN** CI refuses the tier before treating it as a lean change.
