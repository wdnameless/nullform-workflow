# Template integrity

## ADDED Requirements

### Requirement: Promote preserves template placeholders

The sync promotion path SHALL replace the resolved harness path with the `<HARNESS>`
placeholder before writing a prompt surface into the repository tree, so no machine-specific
absolute path is ever committed as a template.

#### Scenario: Promoting an edited prompt surface

- **WHEN** an operator edits a prompt surface in the live tree and runs promote
- **THEN** the repository copy contains `<HARNESS>` where the live copy contained the absolute harness path.

#### Scenario: Promoting a non-prompt surface

- **WHEN** the promoted file is not a prompt surface, for example `tools/workflow.mjs`
- **THEN** the content is written unchanged, because such a file documents paths rather than templating them.

### Requirement: Tripwire rejects machine paths in prompt surfaces

The prompt-surface linter SHALL report a volatile-literal finding for an absolute
machine path, so a contaminated template fails before review rather than after.

#### Scenario: Planted absolute path

- **WHEN** a prompt surface contains a drive-letter or home-directory absolute path
- **THEN** the linter reports a finding and exits nonzero.

#### Scenario: Placeholder path

- **WHEN** a prompt surface contains `<HARNESS>` or a documented example path
- **THEN** the linter reports no finding.

## ADDED Requirements

### Requirement: Every installed prompt copy is checked for drift

The drift check SHALL cover each prompt copy the runtime actually loads, including the
agent-directory law file, not only the copy inside the harness root.

#### Scenario: Stale runtime copy

- **WHEN** the runtime-loaded law file differs from its repository source
- **THEN** the drift check reports drift and names the file.

#### Scenario: Deploy repairs the runtime copy

- **WHEN** deploy runs against a stale runtime copy
- **THEN** the runtime copy is written with the resolved harness path substituted.

### Requirement: Runtime state is not published as harness state

A generated state file that is read while it is written SHALL be written atomically, so a
reader never observes a partial document.

#### Scenario: Concurrent read during write

- **WHEN** a file is being rewritten while another process polls and parses it
- **THEN** the reader observes either the previous complete document or the new complete one.

#### Scenario: Agent state lands in the distributed tree

- **WHEN** the host agent writes its own runtime files into the harness root
- **THEN** they are distinguishable from distributed files and are never reported as drift or as prunable orphans.
