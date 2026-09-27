# Declared dependencies and delivery

## ADDED Requirements

### Requirement: Update all declared repository libraries without breaking contracts

The release MUST inventory version declarations in plugin manifest, MCP template, CI actions/OpenSpec and Python requirements, update supported current stable versions, and preserve exact version pins where the existing manifest uses them. Unknown/unavailable latest versions MUST be reported rather than guessed.

#### Scenario: Current pinned package exists
- **WHEN** a declared package has a newer stable release in its authoritative registry
- **THEN** the pin is updated and at least its relevant install/CLI smoke is exercised.

#### Scenario: Upgrade cannot be verified
- **WHEN** a package is unavailable or a breaking release has no tested migration path
- **THEN** keep the last verified pin, document the blocker, and do not pretend every package was updated.

### Requirement: Observable delivery on supported platforms

The final branch MUST pass focused regressions and the full repo suite, installed sandbox verify/audit/sync and size gates, and the pull-request OS CI matrix before being reported complete.

#### Scenario: Final check
- **WHEN** all slices and manifests are integrated
- **THEN** Oracle blind acceptance compares the running artifact against verbatim R01–R14 and the pushed remote SHA and job results are observed.
