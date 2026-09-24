# Dashboard runtime

## ADDED Requirements

### Requirement: Match serving process to deployed protocol
A current client SHALL NOT reuse an old dashboard process solely because health returns `ok`. The runtime process SHALL be tied to expected project and protocol/build identity.

#### Scenario: Old server remains on expected port
- **WHEN** health responds with a legacy shape from an older build
- **THEN** the new client refuses reuse and serves metadata-only responses from current code.

### Requirement: Restrict HTTP authority
All dashboard HTTP routes SHALL reject requests whose Host is not a local loopback authority.

#### Scenario: Rebound host
- **WHEN** a request uses `Host: attacker.example` on the loopback port
- **THEN** the server refuses it; localhost and 127.0.0.1 continue to work.
