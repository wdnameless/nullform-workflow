# Portable workflow

## ADDED Requirements
### Requirement: Primary OMP path without Paseo
The workflow SHALL preserve OMP execution while requiring no Paseo installation, daemon or configuration mutation in its base path.
#### Scenario: Base installation
- **WHEN** installed in an isolated home without Paseo
- **THEN** core tools and OMP instruction files install and the workflow CLI works

### Requirement: Optional integration remains convenient
Paseo integration SHALL be explicit and preserve unrelated profiles/settings.
#### Scenario: Optional setup
- **WHEN** the user explicitly configures Paseo
- **THEN** its workflow profile and supervisor instructions are available without changing core correctness rules

### Requirement: Portable policy and truthful model independence
Core policy and CLI SHALL avoid OMP-specific APIs and universal model/provider limits; OMP bindings SHALL reside in the adapter layer.
#### Scenario: Read portable protocol
- **WHEN** a user reads the core protocol
- **THEN** requirements describe capabilities/artifacts rather than proprietary tool names and unverified second-harness support is not claimed
