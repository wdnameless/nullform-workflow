# Audit evidence contract

## ADDED Requirements

### Requirement: Every claim is reproduced

A reported defect MUST name `file:line`, the triggering input, and the observed
output. A score MUST name the evidence behind it.

#### Scenario: A defect is reported without a repro

- **WHEN** a finding has no reproduction and no code-reading chain
- **THEN** it is labelled as unverified rather than asserted

#### Scenario: A gate result is quoted

- **WHEN** the report states a gate passes
- **THEN** the exact command and its exit status appear beside the claim
