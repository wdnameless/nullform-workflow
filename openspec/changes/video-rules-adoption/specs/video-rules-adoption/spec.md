# Video rules adoption

## ADDED Requirements

### Requirement: Mutation gate in CI
Changed JS files SHALL pass a mutation-testing gate in the `gate` job:
mutants are generated per file and the step fails when the kill rate is
below threshold.

#### Scenario: Weak tests fail the gate
- **WHEN** a changed file's tests survive more mutants than the threshold allows
- **THEN** the `Mutation gate` step exits non-zero and names the file

#### Scenario: Unchanged files skipped
- **WHEN** no `*.mjs` files changed
- **THEN** the step succeeds without running mutation-test

### Requirement: QA-plan section in T2 proposals
Every T2 `proposal.md` SHALL contain a `## QA-план` section naming
contracts, black-box checks, and test changes, written before task slicing.

#### Scenario: This change carries the section
- **WHEN** reading `openspec/changes/video-rules-adoption/proposal.md`
- **THEN** a `## QA-план` section exists with contracts + black-box + test deltas

### Requirement: Enrich-dump before research
Wave 1 SHALL include an enrich-dump: the engineer unloads traps and
implementation sketch into the manifest BEFORE research narrows context.

#### Scenario: Dump recorded
- **WHEN** a T2 manifest is finalized
- **THEN** its Constraints record the engineer's dump (traps/sketch), not only recon facts

### Requirement: Manifest criticality calibrates oracle
Manifests SHALL declare `criticality: core|supporting|generic` outside the
R## table; the oracle calibrates strictness by it (core = full protocol +
product launch; generic = review pass on green gates); missing field
means core.

#### Scenario: Generic change, green gates
- **WHEN** criticality is generic and all gates pass
- **THEN** the oracle may accept on a review pass without launching the product

### Requirement: Reviewer judges against the knowledge base
The reviewer SHALL check the change against CONTEXT.md terms and the
active change's interfaces.md; findings without a KB/contract reference
are invalid.

#### Scenario: Finding without KB reference
- **WHEN** a finding cites no CONTEXT.md term or interface contract
- **THEN** it is marked invalid (verdict NEEDS_KB until fixed)

### Requirement: SAST in CI
The `gate` job SHALL run `npm audit --audit-level=high` (osv/semgrep where
cheap); high/critical findings fail the build.

#### Scenario: Critical CVE in deps
- **WHEN** `npm audit` reports a critical advisory
- **THEN** the audit step fails with the advisory named

### Requirement: Human design approval before Wave 3
Wave 3 fan-out SHALL NOT start before the orchestrator pauses with
`workflow ask design` and receives human confirmation via the ask widget
(`answered` closes the pause).

#### Scenario: No confirmation, no fan-out
- **WHEN** `ask design` is open
- **THEN** no Wave 3 writer subagents are spawned

### Requirement: Dashboard starts without missing-module crash
`workflow start` SHALL bring up the dashboard without
ERR_MODULE_NOT_FOUND; every relative import of dashboard.mjs SHALL be
present in sync-manifest.json (covered by a test).

#### Scenario: Fresh sync then start
- **WHEN** an install is synced from sync-manifest.json and `start` runs
- **THEN** the dashboard serves instead of crashing on `./brief.mjs`
