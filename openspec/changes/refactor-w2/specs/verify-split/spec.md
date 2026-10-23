# Verify split

## ADDED Requirements

### Requirement: Profiles extracted

runVerifyProfile SHALL live in tools/verify-profile.mjs,
runAuditProfile in tools/audit-profile.mjs; tools/verify.mjs
SHALL be ≤400 lines (parseArgs, resolveRoots, format tables,
main, testTierGate re-export or local).

#### Scenario: Facade thin
- **WHEN** `wc -l tools/verify.mjs` runs
- **THEN** ≤400 lines

### Requirement: CLI invariant

`node tools/verify.mjs --profile <verify|audit> [--json]`
SHALL behave identically (exit codes, JSON shape, table text).

#### Scenario: Golden CLI
- **WHEN** both profiles run on fixtures before/after
- **THEN** outputs match byte-for-byte modulo timestamps/paths
