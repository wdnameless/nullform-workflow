# Plan gates

## ADDED Requirements

### Requirement: Plan MUST validate coverage, topology and zones

`checkPlan(manifest, tickets)` MUST enforce R↔ticket coverage in both
directions, `wave = 1 + max(deps)` topology, and disjoint file zones within
one wave; violations MUST name the ticket/requirement.

#### Scenario: Zone collision caught
- **WHEN** two same-wave tickets share a path prefix
- **THEN** validation fails naming both tickets.

### Requirement: Coverage check MUST be blind to the manifest

`coverageCheck(brief, spec)` MUST record `{ found, fixed, deferred }` without
access to manifest/tickets; the gate MUST fail when gaps are uncovered.

#### Scenario: Uncovered gap fails the gate
- **WHEN** found exceeds fixed + deferred
- **THEN** the gate reports failure with the gap items.

### Requirement: Blind acceptance MUST run in an isolated temp clone

`blindAccept(repo, brief)` MUST clone into a temp dir, run acceptance from
the brief only, and keep spec/manifest/tickets unreachable; results MUST
record `{ checked, matched, mismatches }`.

#### Scenario: Spec unreachable in clone
- **WHEN** acceptance runs in the temp clone
- **THEN** spec/manifest/ticket paths do not exist there.
