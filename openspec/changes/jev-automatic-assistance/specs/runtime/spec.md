# Automatic OMP skill assistance

## ADDED Requirements

### Requirement: Assistance MUST preserve engineering safety

The extension MUST append bounded skill suggestions in turn context and MUST NOT alter the stable system/catalog prefix, main or child models, task tiers, permissions, tests or Oracle/reviewer roles. The user selected skills-only: model routing, provider registration, task caches and model-switch hooks MUST be removed rather than left dormant.

#### Scenario: Native skill suggestion
- **WHEN** an eligible main turn begins with credentials and a current validated v2 policy
- **THEN** the native OMP hook automatically supplies only relevant real skill identifiers from its effective registry at validated confidence >=0.80.

#### Scenario: Models remain unchanged
- **WHEN** any turn or subagent task executes
- **THEN** original model selectors and approval policies remain unchanged; this assistance never switches models.

### Requirement: Externalization MUST protect credentials and private input

Credentials MUST come only from environment/native vault. Requests MUST use the live-confirmed OpenRouter Decisions endpoint and one skill-choice question with bounded input/response. Secrets, personal data, code dumps, local private content and transcript bodies MUST NOT be transmitted or logged by this assistance.

#### Scenario: Credential-shaped prompt
- **WHEN** a turn contains a credential canary, including short JWT claims or explicit quoted/Unicode/opaque credential assignments
- **THEN** no JEV request occurs and logs contain no value.

### Requirement: Failures MUST preserve the baseline

Missing/stale/v1 activation evidence, no credential, unsupported hooks, opt-out, context-dependent input, timeout, API/auth/quota/TLS errors and malformed decisions MUST retain baseline behavior without interrupting the session.

#### Scenario: Provider unavailable
- **WHEN** the API times out or returns invalid data
- **THEN** the original behavior continues with only a redacted diagnostic status.

### Requirement: Installation MUST make validated assistance automatic

Both OMP installers MUST install the native extension idempotently without changing unrelated profile files, canonical human prompts or writing API keys. The user approved activation in the current OMP profile after positive proof; new sessions load the extension without per-task commands. Do not kill the current daemon for reload.

#### Scenario: Fresh OMP sandbox
- **WHEN** OMP is installed with an isolated home
- **THEN** the extension exists, core imports resolve through its harness pointer, and absent credentials/policy cause zero API requests.
