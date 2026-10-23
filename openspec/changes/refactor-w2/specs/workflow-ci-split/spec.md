# Workflow-ci split

## ADDED Requirements

### Requirement: CI block extracted

validateCheckCiOracleFiles, checkPushEvidence, checkQualityGates,
cmdCheckCi SHALL live in tools/workflow-ci.mjs; tools/workflow.mjs
SHALL delegate cmdCheckCi in ≤10 lines.

#### Scenario: Delegate thin
- **WHEN** cmdCheckCi in workflow.mjs is read
- **THEN** it imports and calls workflow-ci.mjs within 10 lines

### Requirement: CI behavior invariant

`node tools/workflow.mjs check-ci` SHALL behave identically
(gates, exit codes, violator names); workflow-gate.test.mjs green.

#### Scenario: Gate suite green
- **WHEN** the gate + quality + install suites run
- **THEN** all pass
