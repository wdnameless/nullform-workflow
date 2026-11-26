# Pack format

## ADDED Requirements

### Requirement: A pack declares its full file list with hashes

Every installable file MUST be listed in `pack.json` with a sha256. The installer
MUST refuse files not listed (allow-list) and MUST refuse hash mismatches.

#### Scenario: Pack with an unlisted file

- **WHEN** `modules/` contains a file absent from `pack.json`
- **THEN** installation refuses before writing anything

### Requirement: Installation is journaled and confined

All writes go through the deployment journal + lock and stay inside the resolved
target root. A second install of the same pack version MUST be a no-op reporting
"already installed".

#### Scenario: Reinstall same version

- **WHEN** `pack install` runs twice with identical pack and target
- **THEN** the second run writes nothing and exits 0

### Requirement: Verification runs after integration

After copying, the installer MUST run the pack's `tests/` entrypoint and the
doctor subset named in the manifest. Any failure MUST exit non-zero without
marking the installation complete.

#### Scenario: Failing pack test

- **WHEN** the pack test entrypoint exits non-zero
- **THEN** `pack install` exits non-zero and reports which check failed
