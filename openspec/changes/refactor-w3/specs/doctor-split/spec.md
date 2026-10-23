# Doctor split

## ADDED Requirements

### Requirement: Checks extracted

The 16 inline checks of runDoctor SHALL live in
tools/doctor-checks.mjs as exported functions
`(ctx) => {id, status, detail}`; runDoctor SHALL be ≤100 lines
(ctx assembly + ordered calls + summary).

#### Scenario: Doctor thin
- **WHEN** runDoctor body is measured
- **THEN** ≤100 lines excluding ctx assembly

### Requirement: Doctor behavior invariant

checks[].id order, summary shape, all 15 exports, CLI output
SHALL be identical; doctor.test.mjs + 3 dependent suites green.

#### Scenario: Golden CLI
- **WHEN** `node tools/doctor.mjs --json` runs before/after
- **THEN** outputs match modulo timestamps/paths
