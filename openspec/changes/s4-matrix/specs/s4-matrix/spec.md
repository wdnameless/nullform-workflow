# proof-matrix spec

## ADDED Requirements

### Requirement: Cross-OS test matrix and install smoke
CI SHALL execute unit tests and linting across Windows, macOS, and Ubuntu on Node 18, 20, 22, and 24, and verify clean installation via an install smoke job.

#### Scenario: Cross-OS execution
- **WHEN** CI runs on windows/macos test-cells
- **THEN** unit tests and eslint execute and pass

#### Scenario: Install smoke execution
- **WHEN** the install smoke job runs in a clean VM
- **THEN** `install-harness.mjs` and `verify.mjs` execute without error

### Requirement: Multi-harness verification
`verify.mjs` SHALL support `--harness claude|codex|opencode`, resolve host roots dynamically, and reject unsupported harnesses.

#### Scenario: Supported harness verify
- **WHEN** `verify.mjs` runs with `--harness claude`, `--harness codex`, or `--harness opencode`
- **THEN** it resolves the respective configuration root and performs verification

#### Scenario: Unsupported harness rejected
- **WHEN** `verify.mjs` runs with an unsupported harness name
- **THEN** it fails with an explicit error naming the allowed harnesses

### Requirement: Category and role tariffs with admission policy
`bench-budget.mjs` SHALL support strict, builder, and scout category tariffs mapped to roles, support admission policies, and enforce a program ceiling up to $50.

#### Scenario: Category and role tariff resolution
- **WHEN** `computeTariffCost` is called with role or category selectors
- **THEN** it applies the configured fixed rates accurately
