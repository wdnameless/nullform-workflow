# Harness health

## ADDED Requirements

### Requirement: Promote refuses before any write

The sync engine SHALL inspect every candidate's timestamp before modifying the repo.

#### Scenario: A later candidate is newer in the repo
- **WHEN** an earlier live file differs and a later repo file is newer
- **THEN** promote exits nonzero and neither repo file changes.

### Requirement: The OMP law copy cannot silently disappear

The sync engine SHALL report a missing runtime-loaded law file and restore it on deploy.

#### Scenario: Runtime law copy is absent
- **WHEN** the harness law exists but `~/.omp/agent/AGENTS.md` does not
- **THEN** check reports drift and deploy restores the file.

### Requirement: Sync output is unambiguous

Explicit roots SHALL fail closed; JSON mode SHALL emit only JSON on stdout.

#### Scenario: Invalid repo path
- **WHEN** a caller passes an explicit repo path lacking required markers
- **THEN** sync exits 2 rather than falling back to another repository.

#### Scenario: JSON check finds drift
- **WHEN** `--json` is used on a drifted tree
- **THEN** stdout parses as one JSON document with the drift list.

### Requirement: Code-size gate measures code rather than text

Function-size detection SHALL include multiline method signatures and exclude
function-looking text in comments and template strings.

#### Scenario: Multiline method exceeds the limit
- **WHEN** a method signature spans lines and its body exceeds the threshold
- **THEN** the method is reported.

#### Scenario: Comment or template contains function-looking text
- **WHEN** text inside a block comment or template literal resembles a function
- **THEN** it does not produce a function-size finding.

#### Scenario: Baseline is regenerated unchanged
- **WHEN** the baseline is generated twice from the same tree
- **THEN** the two files are byte-identical.

### Requirement: Dashboard URL is health-verified

Workflow start SHALL report only a dashboard URL whose HTTP health endpoint responds.

#### Scenario: Runtime file names an unresponsive process
- **WHEN** a stale runtime file names a live PID but an unresponsive port
- **THEN** workflow start reports a newly verified dashboard URL instead.
