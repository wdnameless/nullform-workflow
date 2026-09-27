# Dashboard session and filesystem boundaries

## ADDED Requirements

### Requirement: Session identifiers never become unchecked paths

The dashboard MUST confine every runtime write to the project runtime directory, including caller-provided `--session` identifiers. A failed write MUST NOT leave a changed file outside root.

#### Scenario: Traversal key
- **WHEN** `--session ../../../unrelated` or an equivalent key reaches runtime creation
- **THEN** the call refuses it before touching `unrelated.json` outside the project.

### Requirement: One dashboard session maps to its own server

`--ensure` and `--url` MUST honor the explicit session flag. Reuse/adoption MUST verify the server session as well as project/build/protocol and MUST preserve same-session idempotence.

#### Scenario: Two sessions sharing a candidate port
- **WHEN** session alpha has an active server and beta requests the same free-port window
- **THEN** beta does not adopt alpha's PID/port or see alpha's session data.

#### Scenario: Explicit CLI selection
- **WHEN** `--ensure --session alpha` or `--url --session alpha` runs without environment session IDs
- **THEN** the runtime and URL refer to alpha, not local.
