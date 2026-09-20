# Archmap removal

## ADDED Requirements
### Requirement: No archmap in the harness
The harness SHALL NOT ship archmap modules, renderer assets, archmap tests, the TypeScript tooling dependency, the architecture-observability skill, or an always-loaded architecture-report law. Prompt surfaces SHALL NOT mention archmap.
#### Scenario: Invoking the removed tool
- **WHEN** `node tools/archmap.mjs` runs after removal
- **THEN** Node reports a missing module and no report is produced

### Requirement: Deterministic gate survives
`tools/auto-review.mjs` SHALL keep a real gate without archmap: `npm test` failure or a no-trigger `defer:` marker (via `debt-ledger --check`) SHALL exit 1; clean input SHALL exit 0; tsc and ESLint stay report-only.
#### Scenario: Untriggered defer marker
- **WHEN** auto-review runs over a directory whose .js file carries `defer:` without `upgrade:`
- **THEN** it prints the debt-ledger section and exits 1

### Requirement: Wiring and CI carry no archmap
sync manifest, install script, verify/audit checks, portability assertions, and both CI workflow files SHALL NOT reference archmap; the portability test SHALL assert archmap is absent from a fresh install while debt-ledger is present.
#### Scenario: Fresh install
- **WHEN** the installer runs into a sandbox home
- **THEN** `tools/archmap.mjs` and `tools/report/` do not exist in the installed harness and `tools/debt-ledger.mjs` does
