# Open-source adaptive workflow

## ADDED Requirements

### Requirement: Safe and distinct review execution transitions
The workflow SHALL reject HTTP oracle ACCEPT when the actual fixed product command fails or has invalid provenance. It SHALL reject ordinary repeated dispatch of completed identity-matching work, retain completed results across publication failure, support explicit no-dispatch resume and intentional newly-admitted redo, and fail closed on bounded-candidate-scan overflow. It SHALL not write financial state that makes an admitted session's requests or settlement unreadable. Missing-policy dry-run SHALL expose prerequisites without mutation, and CLI extra positionals SHALL refuse.

#### Scenario: Failed product and an optimistic oracle reply
- **GIVEN** the fixed command exits23 and the local HTTP fixture replies ACCEPT
- **WHEN** the execution is projected or validated
- **THEN** ACCEPT is refused with the failed product preserved as evidence, for both native and controlled paths

#### Scenario: Publication fails and work is retried
- **GIVEN** a completed run whose evidence publication failed
- **WHEN** ordinary retry, explicit resume and explicit redo are requested separately
- **THEN** ordinary retry dispatches zero new work, resume imports the same execution once, redo starts a fresh explicitly authorized cycle and preserves history

#### Scenario: Retained scan limit is exceeded
- **GIVEN** more than256 retained run directories and matching completed work exists
- **WHEN** a fresh ordinary invocation is requested
- **THEN** it refuses before any runner/HTTP dispatch rather than treating the bounded scan as no matches

#### Scenario: Ledger approaches its persistence limit
- **GIVEN** valid historical accounting close to the reader size ceiling
- **WHEN** admission/request consumption could strand later session accounting
- **THEN** authority is refused before dispatch or sufficient bounded persistence space is guaranteed through settlement, without dropping charges or outstanding records

#### Scenario: Safe CLI preview
- **GIVEN** an isolated project without a spending policy
- **WHEN** review-run --dry-run is requested
- **THEN** a structured missing-authority prerequisite is reported with no writes/key read/dispatch
- **AND** a supplied invalid policy or unexpected positional argument is rejected before dispatch

### Requirement: One-command native-first setup
The npm artifact SHALL expose a single documented npx init command using safe discovery/selection of the existing named clients and custom contract. The selected client SHALL use its source-verified instruction loader while human-owned configuration and operator disablement remain intact. Unknown capability evidence SHALL not create extra services or native-state duplicates.

#### Scenario: Explicit, saved, unique and ambiguous client choices
- **GIVEN** isolated homes and controlled client-presence metadata
- **WHEN** init runs with explicit choice, saved choice, one candidate or multiple candidates
- **THEN** precedence is explicit then saved then unique candidate, ambiguity requires a choice, and no arbitrary fallback is applied
- **AND** noninteractive ambiguity refuses with actionable flags before mutation

#### Scenario: First install and reapplication from the actual npm archive
- **GIVEN** the exact packed artifact installed through a local npm registry fixture and preserved human config
- **WHEN** each supported adapter is configured then reapplied and checked
- **THEN** CLI/runtime imports resolve including nested modules, managed policy is singular, human bytes are preserved, runtime absence is explicit and no unspecified MCP/skill/task service is installed

### Requirement: Cohesive discoverable implementation
The implementation SHALL group internal feature responsibilities and retain actual command entrypoints without compatibility shims. Package/sync/install/doctor/tests/docs SHALL agree on the new module tree. Existing source-bound acceptance SHALL not be weakened by the refactor.

#### Scenario: Nested runtime cutover
- **GIVEN** internal modules moved into responsibility directories
- **WHEN** CLI, installer, doctor, sync inventory and packed consumer run
- **THEN** every real caller uses the new location, old duplicate implementations are absent, Node syntax checks cover nested runtime files and hashes still detect source/test changes

### Requirement: Evidence-backed public presentation
Public documentation SHALL cite primary host contracts and distinguish observed deterministic guarantees from unmeasured AI-quality effects. It SHALL provide contributor navigation and reproducible verification/release commands without claiming an unpublished package is released or an unavailable client was exercised.

#### Scenario: No paid comparison authorization
- **GIVEN** the user declined paid experiments
- **WHEN** evidence and README claims are produced
- **THEN** no paid comparison/provider run occurs, deterministic results and limitations are reported, and universal/AI-quality superiority remains unproven
