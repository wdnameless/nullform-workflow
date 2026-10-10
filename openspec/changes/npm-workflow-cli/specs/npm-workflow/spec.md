# npm-workflow

## ADDED Requirements

### Requirement: npm installs a self-contained executable
The package SHALL install with npm without a git repository and expose nullform as an executable.

#### Scenario: Packed package installs without lifecycle scripts
- **WHEN** npm installs the generated .tgz globally into an isolated prefix with --ignore-scripts
- **THEN** nullform --help and --version work and the operator's home is unchanged until init.

### Requirement: Operator chooses and persists the harness
init SHALL provide interactive selection and an explicit --harness mode, preview writes and persist successful installation identity.

#### Scenario: Interactive and headless selection
- **WHEN** the operator selects a listed harness or passes --harness with --yes
- **THEN** the selected integration is installed and subsequent doctor/update use the same harness and custom root.

#### Scenario: Cancellation and dry run
- **WHEN** selection is cancelled, required input is absent in noninteractive mode, or --dry-run is used
- **THEN** no target or installation state is modified.

### Requirement: Native configuration preserves user data
The installer SHALL reuse existing adapters, install their supported native instructions/skills/integrations and preserve unrelated user instructions, configuration fields, secrets and files.

#### Scenario: Reinstallation preserves local configuration
- **WHEN** init runs twice around user config and instruction changes
- **THEN** user data remains unchanged, the managed integration is not duplicated and malformed existing config causes an explicit error before destructive writes.

### Requirement: Doctor verifies the selected harness
Doctor SHALL verify package assets and the selected native integration, using OMP requirements only for OMP.

#### Scenario: Non-OMP installation
- **WHEN** doctor inspects an OpenCode or another non-OMP installation without OMP plugins
- **THEN** OMP requirements do not cause failure and missing host runtimes are reported honestly as SETUP rather than readiness.

### Requirement: npm updates the saved installation
update SHALL obtain a package version from npm, install it through real npm and reapply/check the saved target with the new package executable, without invoking Git.

#### Scenario: Registry upgrade
- **WHEN** a loopback registry serves a newer actual tarball and nullform update is invoked
- **THEN** both global executable and saved installation reach the newer version, the harness/root are unchanged and user settings remain preserved.

#### Scenario: Update failure
- **WHEN** registry/npm/installation/doctor fails
- **THEN** exit is nonzero and no successful-update claim is emitted.

### Requirement: Distribution excludes private and generated data
The npm artifact SHALL contain runtime assets only and SHALL NOT include user credentials, repo runtime history, benchmark runs or node_modules.

#### Scenario: Tarball inventory
- **WHEN** npm pack enumerates the package
- **THEN** required runtime imports/assets are present, generated/private paths are absent and no public registry publication occurs in this run.
