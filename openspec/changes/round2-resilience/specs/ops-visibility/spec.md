# Ops visibility

## ADDED Requirements

### Requirement: Costs MUST snapshot atomically with tiered alerts

`writeSnapshot(dir, costs)` MUST write atomically in O(1) relative to history
size; `checkAlerts(state, costs)` MUST emit `notice|warning|critical` once per
tier with dedup until the tier clears.

#### Scenario: Alert fires once per tier
- **WHEN** costs cross a tier twice without clearing
- **THEN** the tier alert emits once.

### Requirement: Session status MUST follow a versioned HUD schema

`emitHudStatus(session)` MUST return `{ schema: "hud-status.v1", state, waits, costs }`
with state in `working|blocked|idle`; `validateHudStatus(value)` MUST reject
off-schema payloads.

#### Scenario: Off-schema status rejected
- **WHEN** a payload misses fields or uses an unknown state
- **THEN** validation throws naming the violation.

### Requirement: Diffs MUST trip tier LOC ceilings with golden fixtures

`checkTripwire(diffStat, tier)` MUST throw when changed lines exceed the tier
ceiling; `verifyGolden(fixture, actual)` MUST compare declared input/output
contracts byte-exactly.

#### Scenario: Oversize diff blocked
- **WHEN** a T1 diff exceeds its ceiling
- **THEN** the tripwire throws naming tier, ceiling and actual lines.
