## ADDED Requirements

### Requirement: One immutable archive certification
The release pipeline SHALL build one candidate npm tarball and SHALL certify those exact bytes on hosted Linux, Windows and macOS with maintained Node22/24LTS. The certificate SHALL bind source commit, package/version metadata, archive checksums and observed platform/tool versions. Consumers SHALL not repack a different candidate under the same certificate.

#### Scenario: Hosted portable package lifecycle
- **GIVEN** the one uploaded archive and its recorded digest
- **WHEN** each platform runner installs globally in an isolated prefix and exercises all eight existing configuration adapters, repeat application and registry update
- **THEN** every claimed configuration path preserves human data and emits version/integrity-bound evidence for that same archive
- **AND** actual native third-party execution is not inferred from these configuration tests

#### Scenario: Different artifact bytes
- **GIVEN** a successful certificate for one archive
- **WHEN** bytes, version or source identity differ before publication
- **THEN** publication is refused

### Requirement: Authenticated public npm release
Publication SHALL require actual package-owner authorization, verified current checks/acceptance and source/integrity binding. Hosted trusted publishing SHALL use explicit identity/ref/environment guards and least required permissions. A missing owner prerequisite SHALL be visible, never replaced by a fake token or dry-run success.

For an unpublished npm name, the initial release requires user-controlled authenticated bootstrap of the real certified package; OIDC cannot be configured against a nonexistent package. Configure owner-controlled trusted publishing after bootstrap for subsequent releases. Candidate acceptance certifies executable controls and exact source/archive identity; it is not a claim that publication has occurred. Program completion separately requires observed published-registry verification.

#### Scenario: Missing publisher access
- **GIVEN** npm has returned ENEEDAUTH
- **WHEN** release preparation completes
- **THEN** publication remains blocked on user-controlled authorization while all reachable verification is completed

#### Scenario: Missing or stale independent candidate acceptance
- **GIVEN** certificates for an exact archive and source digest
- **WHEN** publication is requested without an independently observed positive release-candidate oracle verdict bound to that current source, or retained evidence is stale or REJECT
- **THEN** publication fails before registry upload even if package-owner authentication is available
- **AND** local tests, an archive hash or a handwritten ACCEPT cannot substitute for independent acceptance

#### Scenario: Initial public package bootstrap
- **GIVEN** the npm package does not yet exist and no package trusted-publisher configuration is possible
- **WHEN** all candidate gates and immutable artifact certification have passed
- **THEN** first publication waits for user-controlled web authorization and publishes only the certified real package
- **AND** subsequent OIDC setup is owner-controlled, with authentic build attestation or explicit provenance limitations rather than fabricated provenance

#### Scenario: Published registry artifact
- **GIVEN** authenticated publication of the certified archive
- **WHEN** a fresh client installs the actual registry version
- **THEN** registry integrity/version and observed installed CLI match the verified release
