# FCC adopt 1267

## ADDED Requirements

### Requirement: Harness versions probed
Matrix entries SHALL carry optional versions/activation; probeHarness
SHALL verdict installed/version/status per entry with injectable runner.

#### Scenario: Missing binary
- **WHEN** detect.cmd is not on PATH
- **THEN** status is not_installed, version null, exit paths unaffected

#### Scenario: Below minimum
- **WHEN** parsed version is below versions.min
- **THEN** the report flags compatible:false for that entry

### Requirement: Doctor report bundle
`nullform doctor --report` SHALL print shareable JSON (versions, probes,
config status) containing no secrets.

#### Scenario: Secret sweep
- **WHEN** the report is grepped for sk-/ghp_/PRIVATE KEY/token values
- **THEN** no matches are found

### Requirement: Effort vocabulary canonical
CONTEXT SHALL define Effort (none/low/medium/high/xhigh/max, default
medium); models.yml.example SHALL carry the same list uncommented.

#### Scenario: Vocab lookup
- **WHEN** an engineer asks for valid effort levels
- **THEN** CONTEXT and models.yml.example agree exactly

### Requirement: Compat facts encoded
Hermes (≥0.20.4, MANAGED_DIR) and codex (catalog) facts SHALL live in
matrix entries with FCC source references.

#### Scenario: Hermes entry read
- **WHEN** the hermes entry is inspected
- **THEN** min 0.20.4 and the MANAGED_DIR note with source are present
