# CLI entry specification

## ADDED Requirements

### Requirement: Symlink-safe entry detection

A shipped CLI MUST execute its command when the module is invoked through a path
whose parent directories are symlinks (including the macOS `os.tmpdir()`
`/var` → `/private/var` case).

#### Scenario: invoked through a symlinked directory
- **WHEN** a directory symlink (or NTFS junction) points at the repository and
  `node <link>/tools/verify.mjs --help` is run
- **THEN** the process prints the usage text and exits 0

#### Scenario: invoked through a symlinked directory (workflow gate)
- **WHEN** `node <link>/tools/workflow.mjs status` is run
- **THEN** the process prints the task status instead of exiting silently

#### Scenario: unresolvable entry path
- **WHEN** the entry path cannot be resolved (for example `node -e`, where
  `process.argv[1]` does not exist on disk)
- **THEN** the predicate returns false and the module does not run its CLI body

### Requirement: Unconditional tools stay unconditional

A tool that currently runs its body without a direct-run guard MUST keep doing
so; the change MUST NOT introduce a guard that can suppress it.

#### Scenario: sync engine
- **WHEN** `tools/sync.mjs` is imported or executed
- **THEN** its body runs exactly as before the change
