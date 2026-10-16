# Adaptive harness profiles

## ADDED Requirements

### Requirement: Evidence-aware host inspection

The public CLI SHALL report the selected host/profile, capability evidence, module decisions and reasons without paid inference, credential inspection or implicit service startup. Documented support, configuration, user declaration and actual runtime execution SHALL remain distinct. Unknown capability SHALL NOT be treated as absence. A headless command or isolated subagent context SHALL NOT imply durable task state or Git worktree isolation.

#### Scenario: Default inspection of an unconfigured host
- **WHEN** an operator inspects a named host without requesting a probe
- **THEN** no host process or model request starts and no profile file changes
- **AND** unavailable evidence remains unknown rather than a fake ready state

#### Scenario: Explicit bounded Hermes probe
- **WHEN** the operator requests a probe in an isolated profile
- **THEN** only the fixed version/path/tool-list commands may execute under finite deadlines/output limits
- **AND** a failure is explicit, plugin/bootstrap side-effect limits are disclosed, and only validated nonsecret fields are returned

### Requirement: Correct and stable host profile routing

Hermes resolution SHALL honor explicit host home, trusted HERMES_HOME, safe active-profile selection and platform-native Windows/POSIX defaults. The selected profile SHALL persist through init/doctor/update so changing the ambient profile cannot redirect an existing installation. Existing canonical confinement and transaction recovery SHALL remain enforced.

#### Scenario: Windows default without HERMES_HOME
- **GIVEN** an isolated Windows user home and LOCALAPPDATA
- **WHEN** Hermes initialization is planned without HERMES_HOME
- **THEN** the selected default is LOCALAPPDATA/hermes, not userHome/.hermes

#### Scenario: Isolation and update stability
- **GIVEN** a selected isolated profile and unchanged human configuration
- **WHEN** installation is updated while the process environment names another profile
- **THEN** the stored profile remains the target and the other profile's bytes remain unchanged
- **AND** escaping names, symlink destinations and unintended real-user environment paths fail before mutation

### Requirement: Minimal native-first non-OMP deployment

Non-OMP profiles SHALL avoid mandatory external task state, dashboard startup, coding interviews/specifications for routine/general tasks and an unsolicited MCP/skill bundle. They SHALL provide bounded result-verification guidance and conditional native reuse, while retaining explicit portable tools for genuine gaps and complex coding work. OMP's actual strict native integration SHALL remain available and honestly labeled.

#### Scenario: Fresh Hermes deployment
- **WHEN** the adaptive profile is installed in an isolated Hermes home
- **THEN** human settings are preserved, SOUL.md is not created/changed, no default MCP server is registered, and the full home-skill catalogue is not copied
- **AND** instructions do not force a second task tracker or coding ceremony for unrelated requests

#### Scenario: Previously installed managed assets
- **GIVEN** legacy Nullform blocks/registrations alongside human edits
- **WHEN** adaptation replaces a recognized managed block
- **THEN** only proven-owned generated content may be removed
- **AND** unknown/modified assets remain unchanged with a visible legacy-behavior warning rather than a false deactivation claim

### Requirement: Open declarative custom-host contract

Alongside eight named adapters the package SHALL accept a bounded schema1 custom-host manifest with an explicit project-relative instruction destination and capability declarations. It SHALL reject executable commands, unknown fields, traversal, absolute/ADS/control-character destinations and missing custom prerequisites before writes. It SHALL NOT claim that creating a file proves the unknown host loads it or that declarations prove runtime readiness.

#### Scenario: Valid custom host
- **WHEN** a valid manifest and project root are supplied
- **THEN** inspection reports declared capabilities and installation writes only the scoped managed instruction destination and existing approved package state/assets
- **AND** human text survives repeat application and stored routing survives update

#### Scenario: Invalid custom manifest
- **WHEN** a contract contains a command, escaping path, invalid capability or malformed field
- **THEN** inspection/init fail explicitly before profile/project changes

### Requirement: Honest verification and overhead evidence

The change SHALL execute deterministic public-CLI/adapter/update tests in isolated homes and compare retained baseline/adaptive deployment observations. It SHALL retain adverse results, distinguish prompt bytes/catalogue entries/server registrations from actual context load/performance/answer quality, and dispatch no new paid A/B. Actual Hermes CLI availability SHALL be checked separately from configuration/source evidence; missing runtime SHALL be explicit.

#### Scenario: Baseline and adaptive comparison
- **WHEN** the same bounded installation scenario is measured before/after
- **THEN** the report includes actual module/byte/catalogue measurements and elapsed-time limits
- **AND** general AI quality benefit remains not-proven without a valid comparative experiment

#### Scenario: Native host not reachable
- **WHEN** Hermes is not executable in the verification environment
- **THEN** configuration/source checks are labeled as such and no live Hermes/session success is claimed
