# session-safety-nets — spec deltas

## ADDED Requirements

### Requirement: Destructive commands require confirmation
The harness SHALL intercept destructive shell commands via an OMP extension and
ask the user to confirm before execution. In non-interactive mode the command
proceeds under normal permission rules.

#### Scenario: rm -rf triggers a confirm dialog
- **WHEN** an agent calls bash with `rm -rf ./build`
- **THEN** the extension shows a confirm dialog naming the action and scope, and blocks on cancel.

#### Scenario: Non-interactive session skips the guard
- **WHEN** the session is non-interactive (print/RPC mode)
- **THEN** the destructive command proceeds without a dialog.

### Requirement: Budget warning in workflow status
`workflow status` SHALL display a warning when the session approaches the soft
budget (≥80% of token or call ceiling).

#### Scenario: Status warns near budget ceiling
- **WHEN** the session exceeds 80% of the soft budget
- **THEN** `workflow status` output contains a BUDGET warning line.

### Requirement: check-budget gate requires a HANDOFF file
`workflow check-budget` SHALL exit 1 when over budget unless `.workflow/handoff.md`
exists with РЕШЕНИЯ / ТУПИКИ / ДАЛЬШЕ sections newer than task start.

#### Scenario: Over-budget without HANDOFF fails
- **WHEN** over budget and no fresh HANDOFF file exists
- **THEN** `check-budget` exits 1 naming the missing file.

### Requirement: Retro suggest aggregates session repeats
`session-retro suggest` SHALL print the top-5 repeated behaviors across sessions
with session counts and one-line rule templates.

#### Scenario: Repeated command surfaces as a rule
- **WHEN** one bash command repeats 3+ times in ≥2 sessions
- **THEN** `suggest` lists it with counts and a proposed rule line.
