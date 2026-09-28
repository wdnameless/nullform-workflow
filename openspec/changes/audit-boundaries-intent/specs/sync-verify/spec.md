# Sync and verification boundaries

## ADDED Requirements

### Requirement: Sync stays within declared tree roots

`--check`, `--deploy`, and `--promote` MUST refuse any manifest source or destination whose real file or existing ancestor resolves outside its declared repo/live root, including dangling file symlinks that `existsSync` misses, before reading out-of-root data or writing any affected file. The OMP law copy is subject to the same boundary. Ordinary in-root sync remains usable.

#### Scenario: Destination directory junction escapes harness
- **WHEN** a manifest destination's parent is a junction to a directory outside the live tree and `sync --deploy` would update it
- **THEN** sync exits nonzero without altering the external sentinel or an earlier in-root manifest file.

#### Scenario: Promotion source symlink escapes live tree
- **WHEN** a live manifest file points outside its declared root and `sync --promote` runs
- **THEN** sync refuses before copying external contents into the repo.

#### Scenario: Dangling destination link
- **WHEN** a later manifest destination is a symlink to a nonexistent file outside the live root, while an earlier destination is drifted
- **THEN** sync refuses without creating the external target or updating the earlier file.

### Requirement: Prompt root substitution honors line boundaries

Promotion MUST replace a full occurrence of the resolved harness root followed by CR/LF with `<HARNESS>` while leaving unrelated periods and partial path prefixes unchanged.

#### Scenario: Harness root ends a line
- **WHEN** a live prompt says `Root: <actual-root>\nnext` and is promoted
- **THEN** the repo prompt says `Root: <HARNESS>\nnext` without a machine path.

### Requirement: Sandbox verification uses the sandbox profile

When `--user-home` is supplied, the verification drift check MUST compare the live harness against that home's `.omp/agent`, not the operator's profile, on both Windows and POSIX.

#### Scenario: Host and sandbox laws differ
- **WHEN** a sandbox law matches its harness, but another agent directory contains a stale law
- **THEN** the verifier's sync check reports clean for the sandbox and does not inspect the unrelated law.
