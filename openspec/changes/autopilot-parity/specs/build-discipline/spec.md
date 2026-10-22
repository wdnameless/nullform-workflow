# Build discipline

## ADDED Requirements

### Requirement: Worker reports MUST carry REDPROOF within 25 lines

`validateWorkerReport(text)` MUST require a `REDPROOF:` line stating the
pre-implementation test failure and reject reports over 25 lines or without
the mandatory sections.

#### Scenario: Oversize report rejected
- **WHEN** a report exceeds 25 lines or lacks REDPROOF
- **THEN** validation fails naming the violation.

### Requirement: Spec and Wave 0 MUST run depth and adversarial checklists

`depthChecklist(spec)` MUST verify the 8 depth dimensions; `adversarialPass(brief)`
MUST run the 7 adversarial questions; missing items MUST be reported by name.

#### Scenario: Missing dimension reported
- **WHEN** a spec skips a depth dimension
- **THEN** the checklist names it.

### Requirement: Review MUST score three axes with F1 and repair limits

`scoreReview(findings)` MUST score Manifest/Spec/Craft independently;
`consolidateF1(blockers)` MUST merge branch blockers into one ticket;
`repairBudget(state)` MUST enforce ≤2 repairs, ≤2 retries, 1 re-review.

#### Scenario: Repair budget exhausted
- **WHEN** a third repair is requested
- **THEN** the budget refuses naming the limit.
