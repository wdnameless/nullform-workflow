# Skill benefit evaluation

## ADDED Requirements

### Requirement: Compare observable behavior
Skill evaluation SHALL compare identical task inputs in fresh baseline and candidate sessions and score actual defects/false positives or requirement satisfaction rather than mock echoes.

#### Scenario: Positive and near-negative skill cases
- **WHEN** a review/workflow skill is evaluated
- **THEN** the cases include appropriate activation, inappropriate near-neighbor activation and a real task result with deterministic scoring

#### Scenario: Candidate is worse
- **WHEN** candidate results do not improve baseline
- **THEN** the observed unfavorable result remains in the evidence and report

### Requirement: Bound additional evaluation spending
Fresh comparisons SHALL stay within one additional USD and explicitly record real cost and model identity.

#### Scenario: Unknown spending
- **WHEN** provider usage cannot support actual spend accounting
- **THEN** further paid evaluations stop and no zero-cost claim is substituted
