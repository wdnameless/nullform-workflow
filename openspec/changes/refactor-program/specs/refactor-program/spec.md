# Refactor program

## ADDED Requirements

### Requirement: Hotspots within ceilings with margin
Every sliced file SHALL sit at or under its defer/baseline ceiling with
≥5% margin, proven by `code-size check` PASS with headroom printed.

#### Scenario: Margins printed
- **WHEN** `code-size check` runs after S1–S3
- **THEN** each touched file shows ≥5% under its ceiling

### Requirement: Bit-identical behavior
Refactored code SHALL behave bit-identically: Stage-A tests frozen and
green, diff contains only moves/splits/deletes of dead code.

#### Scenario: Frozen suite green
- **WHEN** the pre-slice suite runs on the post-slice tree
- **THEN** it passes unmodified (move/split only)

### Requirement: Cross-OS proof cells
CI SHALL run tests/lint on windows + macos cells and Node 18/20,
not only tarball certify.

#### Scenario: New cells green
- **WHEN** CI runs on win/mac × Node 18/20
- **THEN** test/lint cells pass like ubuntu

### Requirement: Harness verify + install smoke
`verify` SHALL cover claude/codex/opencode harnesses; an install smoke
job SHALL run installers in a clean CI VM.

#### Scenario: Verify extended
- **WHEN** `verify` runs with `--harness claude|codex|opencode`
- **THEN** it checks that harness root instead of hardcoded OMP

#### Scenario: Install smoked
- **WHEN** the install smoke job runs in CI
- **THEN** install + verify pass in a clean VM

### Requirement: Model-category tariff matrix
Bench budgets SHALL price strict/builder/scout categories across roles;
category × role evals SHALL run inside the $50 program ceiling.

#### Scenario: Tariffed eval
- **WHEN** a category × role eval runs
- **THEN** cost settles against the ledger and total stays ≤$50

### Requirement: Behavior deltas reported
S5 SHALL report lead-time/CFR/bench before→after on S1–S3 with raw
evidence, marking `not-proven` where no paired A/B exists.

#### Scenario: Deltas honest
- **WHEN** the proof report is read
- **THEN** every delta carries raw command output or `not-proven`
