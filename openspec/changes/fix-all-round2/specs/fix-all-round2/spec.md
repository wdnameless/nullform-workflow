# Fix all round2

## ADDED Requirements

### Requirement: CFR honest by default
`cfr-report` SHALL accept short intervals (`7d`, `30d`) by normalizing
them to git syntax, and SHALL fail loudly (nonzero exit + stderr) when
the git log is empty but the repo is not.

#### Scenario: Short interval matches long form
- **WHEN** `--since 7d` and `--since 7.days.ago` run on the same repo
- **THEN** both report identical counts

#### Scenario: Silent lie impossible
- **WHEN** the git log comes back empty in a non-empty repo
- **THEN** the tool exits nonzero with an explanatory stderr

### Requirement: Dashboard reachable from Paseo
The observability dashboard SHALL open from the Paseo browser tab
without timeout, or the external root cause SHALL be proven with a
documented workaround for the user.

#### Scenario: Paseo open
- **WHEN** the user opens the printed dashboard URL in Paseo
- **THEN** the page renders (no timeout)

### Requirement: Process lifecycle evals in CI
A deterministic lifecycle suite SHALL cover the workflow's own
pickup→409-backoff→approval→deny path and run green in CI.

#### Scenario: Lifecycle green
- **WHEN** CI runs the lifecycle suite
- **THEN** all pickup/409/approval/deny cases pass deterministically

### Requirement: Single-assignee execution locks
Claiming an already-claimed task SHALL return a 409-style refusal;
settlement (worktree/branch cleanup after ACCEPT) SHALL require
explicit confirmation.

#### Scenario: Double claim refused
- **WHEN** the same task is claimed twice without release
- **THEN** the second claim fails with a 409-style error

#### Scenario: Settle needs confirm
- **WHEN** `settle` runs without explicit confirmation
- **THEN** nothing is deleted; with confirmation the worktree/branch is removed

### Requirement: Skill parity source of truth
The live-vs-repo skill parity SHALL have a documented source of truth,
and `sync --check` SHALL be interpretable against it.

#### Scenario: Parity interpretable
- **WHEN** `sync --check` reports parity drift
- **THEN** the doc states which side wins and what the operator does

### Requirement: Local gate counter
A local JSONL counter SHALL record gate/role trigger counts with no
network and no PII.

#### Scenario: Gate run counted
- **WHEN** a gate runs
- **THEN** the local counter increments for that gate

### Requirement: workflow.mjs under ceiling with split plan
`tools/workflow.mjs` SHALL stay at or under 2500 lines with ticket #16
updated (split plan), or be reduced below 2388.

#### Scenario: Ceiling respected
- **WHEN** the size gate runs
- **THEN** workflow.mjs passes and #16 carries the split plan

### Requirement: Split-vs-reseed policy documented
GATES.md SHALL state when to split code vs reseed the COCO baseline.

#### Scenario: Policy present
- **WHEN** the next growth hits the COCO ratchet
- **THEN** the author finds the decision rule in GATES.md

### Requirement: Blind-oracle-only is the norm
Blind oracle acceptance SHALL be documented as the norm for ordinary
T2 changes; keyed review-run evidence SHALL be required only for
releases/money paths.

#### Scenario: No marker needed
- **WHEN** an ordinary T2 closes with blind oracle ACCEPT
- **THEN** no legacy-evidence marker is required

### Requirement: Install reuses prepared storage
Repeat installs SHALL reuse prepared storage instead of a full copy.

#### Scenario: Repeat install fast
- **WHEN** install runs over an existing prepared store
- **THEN** it reuses the store (proven by test or timing)
