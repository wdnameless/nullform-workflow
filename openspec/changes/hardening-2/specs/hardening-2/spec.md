# Hardening-2

## ADDED Requirements
### Requirement: Acceptance evidence is verbatim
The oracle role SHALL require raw command output and exact line references for every claim, SHALL forbid paraphrase/translation, and SHALL fail the report when a summary number is not present verbatim in the pasted output. Flash-class oracles SHALL be double-passed on T2.
#### Scenario: Fabricated number
- **WHEN** an oracle report states a test count absent from its pasted raw output
- **THEN** the acceptance is invalid and a second independent pass is required

### Requirement: The harness prunes what the repo no longer has
`doctor` SHALL report orphan files in the installed tree and `sync` SHALL offer a dry-run prune that deletes only after explicit confirmation.
#### Scenario: Leftover after removing a tool
- **WHEN** a tool is deleted from the repo but still present in the installed harness
- **THEN** doctor reports it and `sync -Prune` lists it without deleting until confirmed

### Requirement: Unused registry entries are disabled, not silently kept
Unused skills SHALL be movable to a disabled list honored by `skills-doctor`, so pruning shrinks the always-loaded registry without breaking parity checks.
#### Scenario: Disabled skill
- **WHEN** a skill is listed in `.skills-disabled.json` and absent from the installed tree
- **THEN** skills-doctor reports it as informational and exits 0

### Requirement: Value is measured, not assumed
The benchmark harness SHALL be exercised with real agent runs and the raw results archived.
#### Scenario: First measured comparison
- **WHEN** two arms run the same tasks
- **THEN** the archived report shows per-task LOC/duration/checks deltas with the sample size stated
