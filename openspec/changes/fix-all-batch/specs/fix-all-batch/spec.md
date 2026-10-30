# Fix all batch

## ADDED Requirements

### Requirement: Python COCO green
`tools/session_cost.py` SHALL pass the python COCO ratchet: no function
above its baseline; any reseed SHALL carry date+reason.

#### Scenario: Ratchet clean
- **WHEN** pylint 4.1.3 + COCO plugin runs per repo-gate.yml
- **THEN** zero growth-failures on python stack

### Requirement: CI fully green with fetchable logs
Repo Gate SHALL pass on all cells incl. windows-24; a documented command
SHALL fetch CI logs programmatically.

#### Scenario: Rerun proof
- **WHEN** the win-24 cell is rerun after the fix
- **THEN** it passes and the log-fetch command returns non-empty output

### Requirement: Windows venv python detected
`toolAvailable` SHALL resolve extensionless venv interpreters on win32
via .exe/.cmd/.bat probing or `where`.

#### Scenario: Venv without extension
- **WHEN** QUALITY_PYTHON points at `.venv/Scripts/python` (no .exe)
- **THEN** the python stack runs instead of reporting missing-tool

### Requirement: Efforts match OMP schema
`models.yml.example` efforts SHALL equal the OMP-supported set with a
named verification source, or stay commented with a reason.

#### Scenario: Schema lookup
- **WHEN** the efforts block is compared to the OMP schema source
- **THEN** they agree exactly or the block is a comment

### Requirement: Review ledger under bound
The review budget ledger SHALL stay below 1MiB via a tested compaction
mechanism; `review-run --dry-run` SHALL pass admission.

#### Scenario: Near-bound write
- **WHEN** a write would exceed 1MiB
- **THEN** compaction keeps it under bound with an honest rollup

### Requirement: Claims ceiling pinned
A nested workspace without its own .git SHALL record null baseCommit,
locked by a regression test.

#### Scenario: Nested workspace claim
- **WHEN** claiming inside a subdir of a git repo (no nested .git)
- **THEN** baseCommit is null, not the parent HEAD

### Requirement: C1/C2 tracked as tickets
GitHub issues SHALL exist for the workflow.mjs split and the skills
prune/lazy-catalog, each with measurement and plan.

#### Scenario: Ticket lookup
- **WHEN** the oracle asks for C1/C2 issue numbers
- **THEN** both resolve with measurement + plan in the body
