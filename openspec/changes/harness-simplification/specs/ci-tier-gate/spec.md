# CI tier gate

## ADDED Requirements

### Requirement: Lean tiers carry their own evidence

A pull request labelled with a lean tier SHALL satisfy that tier's own requirement, not only
its file-count ceiling. A standard-tier pull request SHALL present its reconnaissance
evidence, exactly as a heavy-tier pull request presents its change artifacts.

#### Scenario: Standard tier with no evidence

- **WHEN** a pull request is labelled for the standard tier and carries no reconnaissance evidence
- **THEN** CI refuses it instead of reporting the tier as passed.

#### Scenario: Fast tier exceeding its ceiling

- **WHEN** a pull request is labelled for the fast tier and changes more than two files without a recorded override
- **THEN** CI refuses the tier.

#### Scenario: Standard tier with evidence

- **WHEN** a pull request is labelled for the standard tier and carries reconnaissance evidence naming the touched files and its acceptance check
- **THEN** CI accepts the tier.
