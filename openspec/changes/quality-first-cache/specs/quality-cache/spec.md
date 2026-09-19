# Quality-first cache

## ADDED Requirements
### Requirement: Measured cache observability
The system SHALL report provider usage fields without inventing universal hit rates.
#### Scenario: Mixed cached and uncached turns
- **WHEN** transcript has cacheRead and input usage across models
- **THEN** report outputs per-model warm/cold counts and cache-read share

### Requirement: Explain only observable misses
The doctor SHALL attach only evidence-backed cause codes and unknown otherwise.
#### Scenario: Model switch before cold turn
- **WHEN** model_change precedes input>0/cacheRead=0
- **THEN** cause includes model-change

### Requirement: Deterministic layered fingerprint
Identical prompt surfaces SHALL produce byte-identical canonical fingerprints regardless of filesystem enumeration order.
#### Scenario: Repeat fingerprint
- **WHEN** command runs twice unchanged
- **THEN** combined and layer hashes match

### Requirement: Quality-first policy
Policy SHALL never automatically compact context, truncate output, or alter model routing.
#### Scenario: advisory threshold exceeded
- **WHEN** inline output exceeds configured guidance
- **THEN** validator warns but exits zero unless a safe static gate fails

### Requirement: Executable return contract
Malformed agent returns SHALL fail with actionable errors.
#### Scenario: missing test counts
- **WHEN** TESTS claims pass without counts/not-run owner
- **THEN** validator exits one
