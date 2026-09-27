# Sync and installation

## ADDED Requirements

### Requirement: Safe promotion from relative roots

Sync MUST resolve the harness root to a stable absolute filesystem path before prompt substitution and MUST NOT replace text unrelated to the resolved harness path.

#### Scenario: Relative root with punctuation
- **WHEN** a prompt contains `workflow.mjs` and `1.2` and `sync --promote --harness .` runs in an isolated harness
- **THEN** only occurrences of the actual harness path become `<HARNESS>`; punctuation remains byte-for-byte intact.

### Requirement: All active rule copies match

`--deploy` and `--check` MUST cover the enterprise directive under the live harness, user agent directory, and agents-home; `--promote` MUST retain all-or-nothing preflight.

#### Scenario: Two stale copies
- **WHEN** repo rule v2 differs from the OMP agent and harness copies
- **THEN** deploy updates both and subsequent check reports clean only when every copy matches.

### Requirement: Portable, complete OMP installation

A Node-based OMP install MUST provide its doctor-required rule and size baseline, use an executable platform-native MCP command, and reject any destination nested inside a copied source before mutation.

#### Scenario: Fresh POSIX install
- **WHEN** `install.sh` installs OMP with an isolated home and no external provider
- **THEN** the installed-mode doctor finds both rule copies, sync finds the size baseline, and seeded MCP launchers do not require `cmd.exe`.

#### Scenario: Nested install target
- **WHEN** `--root` points inside source `tools/` or another copied subtree
- **THEN** the installer fails promptly before creating a recursively copied destination.

### Requirement: Supplied optional credentials configure usable endpoints

PowerShell install MUST substitute a supplied GitHub token and PostgreSQL URL into the retained MCP entries or explicitly reject incomplete configuration; it MUST preserve unrelated existing user config.

#### Scenario: Dummy configured services
- **WHEN** a synthetic GitHub canary and test PostgreSQL URL are supplied through an isolated secrets file
- **THEN** generated config contains neither `__GITHUB_PAT__` nor a hard-coded sample PostgreSQL URL, and no secret appears in logs.
