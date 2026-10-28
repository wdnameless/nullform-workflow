# Workflow growth batch

## ADDED Requirements

### Requirement: Verification cost measured
Lead time SHALL be computable from `.workflow/events.jsonl`: median
start→close per tier and ask→answered pauses, via `tools/lead-time.mjs`.

#### Scenario: Empty journal
- **WHEN** events.jsonl is missing or empty
- **THEN** lead-time prints zeros and exits 0

#### Scenario: Tier medians
- **WHEN** the journal holds start/close pairs for T1 and T2
- **THEN** per-tier medians are reported (and as JSON with --json)

### Requirement: Bugfix fast-lane separated
A bugfix SHALL follow reproduce→fix→regression→oracle-lite without
enrich, design approval, QA-plan, or OpenSpec (PORTABLE + orchestrator).

#### Scenario: Protocol lookup
- **WHEN** an engineer asks how to run a bugfix
- **THEN** PORTABLE names the 4-step fast-lane and forbids T2 artifacts

### Requirement: Coverage gate on changed lines
Changed JS lines SHALL be ≥50% covered (native test coverage);
`tools/coverage-changed.mjs` fails below threshold; repo-gate.yml runs it.

#### Scenario: Uncovered change fails
- **WHEN** changed lines coverage is below 50%
- **THEN** the Coverage gate step exits non-zero naming the file

#### Scenario: Covered change passes
- **WHEN** changed lines coverage is at/above 50%
- **THEN** the step exits 0

### Requirement: ADR directory seeded
`docs/adr/0001-*.md` SHALL exist with Status/Context/Decision/Consequences;
CONTEXT.md SHALL point at `docs/adr/`.

#### Scenario: Reviewer anchors KB
- **WHEN** the reviewer grounds a finding in architecture
- **THEN** a citable ADR file exists on disk

### Requirement: CFR report available
`tools/cfr-report.mjs --since 7d` SHALL print post-merge fix rate from
git log (read-only, no gate).

#### Scenario: Week with fixes
- **WHEN** fix( commits land within 48h of feat( commits
- **THEN** the report lists them with a nonzero rate

### Requirement: Experience loop closed
Manifest Constraints SHALL quote ≥1 line from
`.workflow/experience/<domain>.md` or state no experience exists.

#### Scenario: Missing quote
- **WHEN** Constraints carry no experience quote
- **THEN** the manifest violates the Wave 1.5 rule

### Requirement: Video principles in canon
PORTABLE §9 SHALL state «instruction is intent, artifact is fact» with
gate consequences, and name confirmation as the bottleneck.

#### Scenario: Canon lookup
- **WHEN** an engineer asks what the workflow trusts
- **THEN** §9 answers: artifacts, never instructions

### Requirement: Integrity holds live
Live `workflow start` SHALL reach dashboard http 200; all gates
(code-size, clone, eslint, quality, mutation, coverage) SHALL be green.

#### Scenario: Fresh start
- **WHEN** `workflow start` runs on the live harness
- **THEN** a verified dashboard URL is printed (no "unavailable")
