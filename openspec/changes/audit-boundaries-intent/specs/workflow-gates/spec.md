# Workflow evidence gates

## ADDED Requirements

### Requirement: Every Oracle verdict is considered locally and in CI

An explicit ACCEPT path MUST NOT hide other oracle evidence in the OpenSpec change or borrow ACCEPT from another change. Local `check`/`close` and `check-ci` MUST require a positive verdict in the registered change and reject any matching file there with an anchored REJECT, including repeated-hyphen filenames and conventional Markdown-bold `**Verdict:** REJECT`; all-positive evidence retains the existing passing behavior.

#### Scenario: Local explicit ACCEPT plus sibling REJECT
- **WHEN** the oracle artifact selects `oracle-1.md: ACCEPT` and `oracle-2.md` states REJECT
- **THEN** both local `check` and `close` refuse without a forced deviation.

#### Scenario: Committed multi-hyphen rejection
- **WHEN** a committed change contains `oracle-1.md: ACCEPT` and `oracle-blind-recheck.md: REJECT`
- **THEN** `check-ci` fails even though the ACCEPT file is valid.

#### Scenario: Positive path from another change
- **WHEN** the registered change has no ACCEPT and an explicit oracle `--path` names an ACCEPT file from a different change
- **THEN** local `check` and `close` refuse rather than borrowing that verdict.

#### Scenario: Markdown-bold rejection
- **WHEN** a current-change oracle file states `**Verdict:** REJECT` beside another file's ACCEPT
- **THEN** local check/close and committed CI evidence refuse rather than treating the rejection as prose.

### Requirement: Guarded auto never treats Git failure as no changes

In an initialized Git worktree, including a selected project root inside a repository, errors obtaining status or diff MUST fail guarded-auto closure. Paths emitted by Git for non-ASCII or special-character untracked filenames MUST be parsed without lossy C quoting, and an unreadable untracked file MUST fail measurement rather than contribute zero lines. Neither the allow-list nor measured diff cap may be skipped; genuinely non-Git roots retain their existing behavior.

#### Scenario: Git unavailable with out-of-scope edit
- **WHEN** a T0 guarded-auto task allows `src/**`, its repo has an out-of-scope changed file, and Git inspection fails
- **THEN** `close` returns nonzero and leaves the task open.

#### Scenario: Git diff fails after status succeeds
- **WHEN** Git status succeeds but the numstat command fails
- **THEN** guarded-auto closure fails instead of treating the measured line count as zero.

#### Scenario: Project is nested inside Git checkout
- **WHEN** `--root` selects a subdirectory of a Git repository without its own `.git` entry and an out-of-scope file changes there
- **THEN** guarded-auto close refuses instead of skipping measurement.

#### Scenario: Unicode untracked filename exceeds diff cap
- **WHEN** an initialized repository has an untracked `é.txt` with 100 lines, `--allow '**'`, and `--max-diff 1`
- **THEN** guarded-auto close refuses even if Git's human-readable porcelain format would quote the filename.
