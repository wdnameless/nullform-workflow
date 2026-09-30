# Automatic OMP assistance

## ADDED Requirements

### Requirement: Assistance MUST preserve engineering safety

The extension MUST append bounded skill suggestions in turn context and MUST NOT alter the stable system/catalog prefix, main model, task tiers, permissions, tests or protected Oracle/reviewer roles. Named low-risk child tasks MAY use an exact validated cheaper model only for evaluated leaf-task archetypes (`lookup,json-transform,formatting,text-normalization`), when caller selectors, role, task identity and evidence permit it; role membership alone is insufficient.

#### Scenario: Native skill suggestion
- **WHEN** an eligible turn begins with credentials and current validated policy
- **THEN** the native OMP hook automatically supplies only real relevant skill identifiers from the effective registry.

#### Scenario: Protected or caller-explicit task
- **WHEN** an Oracle, reviewer, risky/context-dependent task, ambiguous spawn or caller-explicit model is dispatched
- **THEN** its original model selectors and approval policy remain unchanged.

### Requirement: Externalization MUST protect credentials and private input

Credentials MUST come only from environment/native vault; API requests MUST use the live-confirmed OpenRouter Decisions contract with bounded input and response. Secrets, personal data, code dumps, local private content and transcript bodies MUST NOT be transmitted or logged by this assistance.

#### Scenario: Credential-shaped prompt
- **WHEN** a turn or task contains a synthetic credential canary
- **THEN** no outgoing JEV request occurs and logs contain no canary.

### Requirement: Failures MUST preserve the baseline

Missing/stale activation evidence, missing credentials, unsupported hooks, timeout, API/auth/quota/TLS errors, malformed decisions and unknown model availability MUST retain the baseline behavior without interrupting the session.

#### Scenario: Provider unavailable
- **WHEN** the API times out or returns an invalid response
- **THEN** the original skill/model path continues with only a redacted diagnostic status.

### Requirement: Installation MUST make validated assistance automatic

Both OMP installers MUST install the native extension idempotently, without mutating unrelated user configuration or writing API keys to files. This machine MUST have an observed activation state; new sessions load the extension without per-task commands.

#### Scenario: Fresh OMP sandbox
- **WHEN** OMP is installed with an isolated home
- **THEN** the extension exists, core imports resolve through its harness pointer, and no credential means zero API requests.
