# Workflow audit fixes

## ADDED Requirements

### Requirement: A rename cannot launder a recorded complexity ceiling
`baseline` SHALL carry forward a recorded entry whose function no longer appears, and SHALL
report how many entries it kept without a current match. Dropping them SHALL require the
explicit `--prune` flag.

#### Scenario: Function renamed after being baselined
- **WHEN** `a.mjs:f` is recorded at 40 and the function is renamed to `g` before `baseline` runs
- **THEN** the entry `a.mjs:f=40` survives the re-seed
- **AND** the report names one entry kept without a current match

#### Scenario: Explicit prune
- **WHEN** `baseline --prune` runs over the same tree
- **THEN** the orphan is removed and the report counts it as pruned

### Requirement: A check that decides nothing is not a pass
`executeCheck` SHALL return `UNVERIFIED` when a check returns no verdict, and `verify.mjs`
SHALL count `UNVERIFIED` as red and exit non-zero.

#### Scenario: Check returns an empty object
- **WHEN** a check returns `{}` or `{ok: undefined}`
- **THEN** its status is `UNVERIFIED`, never `PASS`
- **AND** the run exits 1

#### Scenario: Explicit verdict still wins
- **WHEN** a check returns `{ok: true}` or an explicit `status`
- **THEN** that status is used unchanged

### Requirement: Worktree sprawl is visible and removable
`tools/worktree-doctor.mjs` SHALL list every worktree with its branch, dirt, age and merge
state, and SHALL mark as prunable only those whose branch is merged and which hold no local
work.

#### Scenario: Merged clean worktree
- **WHEN** a worktree's branch is an ancestor of the base ref and `git status --porcelain` is empty
- **THEN** it is reported prunable and `--prune` removes it

#### Scenario: Worktree with uncommitted work
- **WHEN** a worktree holds any uncommitted or untracked file
- **THEN** it is reported and never removed, even when its branch is merged

#### Scenario: Main checkout
- **WHEN** the main worktree is clean and merged
- **THEN** it is still never prunable

### Requirement: The quality gate works at any tree size
The gate SHALL batch the file list when it would exceed the platform command-line limit, and
SHALL NOT grade archived repository copies under `bench/runs/`.

#### Scenario: Full checkout on Windows
- **WHEN** 226 source files would exceed the command-line limit
- **THEN** the analyzer runs in batches and the reports are merged, instead of failing with `ENAMETOOLONG`

#### Scenario: Machine that has run benchmarks
- **WHEN** `bench/runs/<run>/repo/` contains full repository copies
- **THEN** those copies are excluded from the run
