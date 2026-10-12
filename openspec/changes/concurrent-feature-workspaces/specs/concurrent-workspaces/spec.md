## ADDED Requirements

### Requirement: Isolated concurrent writers
The workflow SHALL allocate private detached Git worktrees and indexes for feature writers while preserving one integration branch and existing user changes.

#### Scenario: Two features from a dirty operator checkout
- **GIVEN** staged and unstaged human changes and an existing open workflow in the integration checkout
- **WHEN** two different feature allocations execute concurrently
- **THEN** each has a different worktree/index/workflow state based on the recorded committed base
- **AND** the operator's bytes, staged entries and open state are unchanged

#### Scenario: Duplicate or escaped allocation
- **GIVEN** an existing feature or a junction/foreign repository at the allocation path
- **WHEN** allocation is requested again or with a path-like identifier
- **THEN** duplicate allocation refuses without replacing files or granting a second writer permission to reuse the existing cwd; escaped/foreign paths refuse before mutation

### Requirement: Single-branch conflict-preserving integration
The workflow SHALL serialize managed integration of committed feature work into the recorded integration branch without destructive stash/restoration or hidden conflict resolution.

#### Scenario: Independent completed features
- **GIVEN** two clean committed feature worktrees and a clean correct integration branch
- **WHEN** the integrator accepts their results
- **THEN** both features remain present in that branch and the feature commits/worktrees remain recoverable

#### Scenario: Conflicting completed features
- **GIVEN** two features changed the same base lines differently
- **WHEN** the second result is integrated after the first
- **THEN** integration reports a conflict rather than success and retains both committed sources
- **AND** it does not reset, overwrite or stash the operator's work

#### Scenario: Unsafe integration context
- **GIVEN** dirty staged/unstaged/untracked operator work, wrong branch, active Git operation or a live integration lock owner
- **WHEN** integration is requested
- **THEN** it refuses before mutation and preserves all existing bytes/index/state

### Requirement: Destructive restoration is not preservation
Project-owned writer instructions SHALL use isolated allocated cwd and one integrator. The existing native OMP guard SHALL identify stash/checkout/restore working-tree replacement as destructive and SHALL NOT silently allow that identified operation because the session is headless. Documentation SHALL distinguish this guard from a general cross-harness sandbox.

#### Scenario: Screenshot restoration
- **GIVEN** an agent requests `git checkout stash@{0} -- src/App.tsx`
- **WHEN** the native guard observes it
- **THEN** execution requires explicit interactive authorization or is refused headlessly, never classified as harmless preservation

#### Scenario: Installed guard delivery
- **GIVEN** canonical npm/Node deployment, sync deployment or legacy PowerShell deployment of the OMP adapter into sandbox roots
- **WHEN** the guard is installed or updated
- **THEN** the actual delivered delete-guard contains the current incident defense on each supported route
- **AND** other adapters are explicitly described as managed CLI plus guidance, not native interception
