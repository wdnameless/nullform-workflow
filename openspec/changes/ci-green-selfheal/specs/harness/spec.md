# Spec delta — harness resilience

## ADDED Requirements

### Requirement: Historical evidence binding

The system SHALL validate a change's review evidence against the tree state at
the revision that last touched that change directory when evaluating a push.

#### Scenario: Later unrelated commit does not invalidate history

- **WHEN** a previously accepted change is committed and a later, unrelated
  commit modifies other files
- **THEN** evaluating a push range that includes both commits SHALL still
  validate the change's evidence successfully

#### Scenario: PR gate still validates the working tree

- **WHEN** a pull request is evaluated
- **THEN** evidence SHALL be validated against the current working tree,
  unchanged from current behaviour

#### Scenario: Tampered evidence still fails

- **WHEN** an evidence record does not match the tree at its own recorded
  revision
- **THEN** validation SHALL fail with a message naming the mismatch

### Requirement: Agent-driven setup

`nullform setup` SHALL print a plan before writing anything, and SHALL require
confirmation unless explicitly skipped.

#### Scenario: Plan printed before any write

- **WHEN** `nullform setup` runs with a detected harness
- **THEN** it SHALL print each detected harness with its detection reason, the
  chosen target, and the actions to be applied, before modifying any file

#### Scenario: Dry run performs no writes

- **WHEN** `nullform setup --dry-run` runs
- **THEN** no file SHALL be created or modified and the exit code SHALL be 0

#### Scenario: Ambiguity fails closed

- **WHEN** multiple harnesses are detected and neither `--harness` nor `--yes`
  is supplied
- **THEN** the command SHALL exit 2 naming the candidates

#### Scenario: Non-interactive install for agents

- **WHEN** `nullform setup --yes --harness <name>` runs
- **THEN** it SHALL install without prompting and still print the plan

### Requirement: Self-healing

`nullform heal` SHALL repair allow-listed defects idempotently and verify the
result.

#### Scenario: Healthy installation is a no-op

- **WHEN** `doctor` reports no failures
- **THEN** `heal` SHALL exit 0 without applying any change

#### Scenario: Broken installation is repaired and re-verified

- **WHEN** `doctor` reports a failure covered by an allow-listed repair
- **THEN** `heal` SHALL apply that repair, re-run `doctor`, and report
  before/after failure counts

#### Scenario: Unlisted destructive repair refuses

- **WHEN** the only available repair is not allow-listed
- **THEN** `heal` SHALL stop and report the blocker instead of improvising

#### Scenario: Heal dry run

- **WHEN** `nullform heal --dry-run` runs
- **THEN** it SHALL list the repairs it would apply and modify nothing

### Requirement: Dashboard guarantee

Starting the strict workflow SHALL never leave the dashboard's state unreported.

#### Scenario: Live dashboard reported

- **WHEN** the workflow starts and a dashboard server responds to a liveness probe
- **THEN** the command SHALL report the dashboard as live with its URL

#### Scenario: Degradation is explicit

- **WHEN** the dashboard cannot be started or probed
- **THEN** the command SHALL report the dashboard as unavailable with a named
  reason and SHALL NOT fail silently

#### Scenario: Opt-out respected

- **WHEN** `--no-dashboard` or `NF_NO_DASHBOARD=1` is set
- **THEN** no dashboard process SHALL be started
