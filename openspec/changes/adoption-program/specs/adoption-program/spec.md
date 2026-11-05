# Adoption program

## ADDED Requirements

### Requirement: Safe settlement
Settlement SHALL remove only confirmed existing targets associated with the
change, SHALL refuse protected/current branches, and SHALL fail on deletion
errors or missing target. Positional and flag forms SHALL agree.

#### Scenario: Protected ref survives
- **WHEN** settle is asked for a change matching main/master/current branch
- **THEN** protected refs survive and a failure is reported

#### Scenario: Positional form
- **WHEN** `workflow settle <change> --yes` is invoked
- **THEN** it resolves the same target as `--change <change> --yes`

### Requirement: Real install smoke
CI install-smoke SHALL perform a real isolated install and verify that target.

#### Scenario: Isolated install verified
- **WHEN** the smoke job runs
- **THEN** a temporary root/home is installed and its verifier executes

### Requirement: Race-free port allocation
Replay/dashboard tests SHALL obtain an OS-assigned listener without a
close/relisten window.

#### Scenario: Parallel listeners
- **WHEN** parallel tests request listeners
- **THEN** no free-port close/relisten race is introduced

### Requirement: Harness semantics
Path-like harness root and named harness selection SHALL resolve appropriate
root and agent directory without silently forcing Claude for every path.

#### Scenario: Path target
- **WHEN** a path-like harness is supplied
- **THEN** its root and corresponding agent directory are used

### Requirement: Meaningful experience and registry
Experience gate SHALL require a valid fresh lesson, and skill registry
SHALL reject duplicate identity/orphan entries. Module-only CI file SHALL
not pretend to be a CLI.

#### Scenario: Empty lesson refused
- **WHEN** an empty experience file is newer than start
- **THEN** close refuses it

### Requirement: Advisory scope and skill assurance
Deterministic advisory scope classification, skill security/eval/registry
checks SHALL operate offline with tests.

#### Scenario: Scope report
- **WHEN** a mixed diff is classified against intent
- **THEN** unrelated paths/signals are reported without repo mutation

### Requirement: Worker and dependency contracts
Worker brief SHALL carry complete inputs and explicit gap/redispatch rules;
dependency diagnosis SHALL be offline and non-mutating.

#### Scenario: Worker gap
- **WHEN** required worker input is missing
- **THEN** the result states INPUT GAP instead of inventing it

### Requirement: Candidate-only optimizer
Optimizer SHALL generate candidates and evidence only, applying no prompt
changes, and SHALL not exceed $10 additional spend.

#### Scenario: Candidate kept or reverted
- **WHEN** a candidate is evaluated
- **THEN** baseline/candidate evidence decides keep/revert without auto-apply

### Requirement: Honest proof
Executed evidence SHALL be reported for available systems, with UNVERIFIED
for unavailable cells and no unproven quality claim.

#### Scenario: Unavailable model
- **WHEN** an admitted provider is unavailable
- **THEN** live model quality is UNVERIFIED, never simulated
