# Workflow gates

## ADDED Requirements

### Requirement: Verified local evidence
A T2/T3 task SHALL only record manifest, validated OpenSpec change and interface contract when their paths exist and contain the expected evidence; a negative oracle verdict SHALL NOT close normally.

#### Scenario: Claimed-only or rejected work
- **WHEN** an agent supplies descriptive text without required artifact files, or records `REJECT`
- **THEN** the gate exits nonzero and normal `close` remains unavailable.

### Requirement: Current-tree acceptance
The acceptance verdict SHALL cover the complete source tree state, including tracked modifications, deleted files and untracked source files.

#### Scenario: New file after acceptance
- **WHEN** a source file is added after an accepted verdict
- **THEN** normal `close` exits nonzero until acceptance is renewed.

### Requirement: CI evidence
A pull request SHALL declare exactly one `workflow:T0` through `workflow:T3` label. A T2/T3 PR SHALL carry a change with requirement quotes, proposal, tasks, interfaces and positive oracle evidence; CI SHALL reject missing evidence. T0/T1 SHALL still run normal project checks without heavyweight artifacts.

#### Scenario: No label or missing heavy evidence
- **WHEN** the PR lacks a tier label or declared T2/T3 change artifacts
- **THEN** the workflow CI step exits nonzero rather than silently skipping the ignored local state file.

### Requirement: Dashboard metadata boundary
The HTTP dashboard SHALL NOT return transcript text, tool arguments, arbitrary user content or raw git patches from any route.

#### Scenario: Synthetic sensitive input
- **WHEN** dashboard data collection sees a transcript containing a synthetic secret marker
- **THEN** HTTP responses do not contain that marker and retain only metadata.

### Requirement: Consistent runtime setup
The source and deployed prompt contract SHALL not require removed tools or a T1 interview. Optional Paseo setup SHALL not abort an otherwise valid base installation when no model is configured. Required plugins SHALL use exact tested versions and missing installation SHALL fail rather than masquerade as healthy.

#### Scenario: Fresh environment
- **WHEN** installation runs without a provider model and one required plugin is unavailable
- **THEN** Paseo is skipped with a clear warning and required-plugin failure remains visible as an installation error.
