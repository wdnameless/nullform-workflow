# Review integrity

## ADDED Requirements

### Requirement: Separate implementation review and blind acceptance
Implementation review SHALL use the reviewer role with diff and consumer context. Blind acceptance SHALL use the oracle role with original manifest and running artifact, without planning documents.

#### Scenario: Request implementation review
- **WHEN** a user or orchestrator requests code review
- **THEN** reviewer inspects the patch and reports evidence-backed findings, without substituting blind oracle acceptance

### Requirement: Require actual execution evidence
Heavy and program workflow gates SHALL validate native execution records tied to the reviewed source and manifest, including a reviewer, frozen-test simplification disposition and adequate independent oracle sessions.

#### Scenario: Static acceptance text only
- **WHEN** a T2/T3 change contains ACCEPT Markdown without validated execution records
- **THEN** local completion and CI acceptance fail with an actionable explanation

#### Scenario: Flash double acceptance
- **WHEN** the final oracle uses a flash/fallback model for a slice beyond the Oracle-lite limits
- **THEN** two distinct successful native oracle sessions on the same current source and manifest are required

#### Scenario: Stale or invalid provenance
- **WHEN** source, manifest, model, role or evidence differs from recorded execution, a session is duplicated, or usage/process status is invalid
- **THEN** acceptance fails rather than trusting caller-supplied verdict strings
