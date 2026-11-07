# Release 1.3.0

## ADDED Requirements

### Requirement: Python analyzer executes
The quality gate SHALL execute the python stack and report `pass` rather than
`unverified` when pylint is installed in the project virtualenv.

#### Scenario: Python stack green
- **WHEN** `quality check` runs with pylint in `.venv`
- **THEN** the output contains a real `python pass (...)` row

### Requirement: Host interpreter untouched
`quality install` SHALL refuse to install analyzers into the system interpreter
and SHALL require a project virtualenv.

#### Scenario: No venv
- **WHEN** `quality install` runs without a project venv
- **THEN** it reports `skipped-no-venv` and installs nothing

### Requirement: Virtualenv excluded
The project virtualenv SHALL be ignored by git and absent from the npm archive.

#### Scenario: Archive contents
- **WHEN** the package tarball is packed
- **THEN** it contains no `.venv/` entries

### Requirement: Archive matches HEAD
The candidate tarball SHALL be rebuilt from the current HEAD; certification
SHALL fail on any file whose archive hash differs from the repository.

#### Scenario: Stale archive refused
- **WHEN** the tarball predates a commit that changed a packed file
- **THEN** certification fails with the mismatching path

### Requirement: Publication is real
Version 1.3.0 SHALL appear on the npm registry, verified by `npm view`.

#### Scenario: Published
- **WHEN** publication completes
- **THEN** `npm view nullform-workflow version` returns 1.3.0
