# Review integrity

## ADDED Requirements

### Requirement: Oracle selection MUST enforce a different model family

`resolveOracleModel({ builderFamily, candidates })` MUST return a candidate whose
family differs from `builderFamily`, or throw naming the conflict. Family
derivation MUST be deterministic from the model id string with no network.

#### Scenario: Same-family oracle rejected
- **WHEN** all candidates share the builder's family
- **THEN** resolution throws and names the conflicting family.

### Requirement: Findings MUST arbitrate against acceptance criteria

`arbitrate(findings, criteria)` MUST return `{ accepted, dropped }`. A finding is
accepted only when it references a criterion id present in `criteria`; otherwise
it is dropped with `reason: "no-criterion-match"`.

#### Scenario: Unmapped finding dropped
- **WHEN** a finding references no criterion id from the criteria list
- **THEN** it lands in `dropped` with the machine-readable reason.
