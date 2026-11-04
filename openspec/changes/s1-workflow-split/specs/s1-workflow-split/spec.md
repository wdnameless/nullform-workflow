# Spec — s1-workflow-split

## ADDED Requirements

### Requirement: Workflow Split
The system SHALL divide `tools/workflow.mjs` into cohesive modules (`tools/workflow-core.mjs`, `tools/workflow-ci.mjs`, and `tools/workflow.mjs`), with each file strictly under 1200 lines.

#### Scenario: File sizes within bounds
- **WHEN** line counts are measured for `tools/workflow.mjs`, `tools/workflow-ci.mjs`, and `tools/workflow-core.mjs`
- **THEN** each file is strictly fewer than 1200 lines.

### Requirement: Zero Behavior Drift
The system SHALL preserve byte-identical passthrough for `bin/nullform.mjs` and execute all frozen workflow gate tests cleanly.

#### Scenario: Existing tests pass
- **WHEN** `workflow-gate.test.mjs` runs
- **THEN** all tests complete with zero failures and zero behavioral regressions.
