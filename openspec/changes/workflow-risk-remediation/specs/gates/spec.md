# Tier and acceptance gates

## ADDED Requirements

### Requirement: Claimed tier has enforceable evidence

CI MUST reject T1 without reconnaissance and T3 without recorded worktree evidence; guarded auto MUST derive actual changed paths and diff size, not trust optional caller arguments.

#### Scenario: Oversized PR called T1
- **WHEN** a PR with many changed files carries a `workflow:T1` label but no recon evidence
- **THEN** CI refuses the tier instead of returning success.

#### Scenario: Out-of-scope auto edit
- **WHEN** a T0 `--auto --allow src/** --max-diff 1` task changes `outside.txt` by 12 lines and closes without `--diff-lines`
- **THEN** close refuses because measured edits violate the allow-list and cap.

### Requirement: Every acceptance verdict applies to current code

All Oracle evidence files MUST be considered and any explicit REJECT MUST block. A tracked source file named `credentials.ts` MUST invalidate acceptance when changed, without reading its secret contents. Errors getting Git evidence MUST fail closed rather than silently pass.

#### Scenario: Conflicting Oracle verdicts
- **WHEN** `oracle-1.md` states ACCEPT and `oracle-2.md` states REJECT
- **THEN** check-ci rejects the change.

#### Scenario: Sensitive-named source changes
- **WHEN** tracked `src/credentials.ts` is changed after Oracle acceptance
- **THEN** close refuses based on Git metadata or content-safe evidence.

### Requirement: Local and CI gates agree on artifact completeness and freshness

Local T2 closure and CI MUST require the same durable artifacts. PR merge commits containing only an unrelated target-branch update MUST NOT invalidate feature acceptance; a feature-head change after the verdict MUST still be detected.

#### Scenario: Minimal local artifacts
- **WHEN** manifest/interfaces/recon and ACCEPT detail exist but proposal, tasks, specs or oracle file do not
- **THEN** local close refuses rather than deferring the failure to CI.

#### Scenario: Target branch advances
- **WHEN** a clean accepted feature is tested via a synthetic merge with an unrelated newer base commit
- **THEN** the feature evidence still validates while a later feature edit fails.
