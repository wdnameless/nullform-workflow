# Ops journal

## ADDED Requirements

### Requirement: Journal MUST track honest time, waits, commits and trailers

`recordBeat(journal)` MUST append event timestamps; `honestTime(journal)`
MUST exclude gaps over 45 minutes and archived waits; `commitsCheck(dir)`
MUST verify ancestors via merge-base; trailers MUST record run/requirements.

#### Scenario: Sleep excluded from work time
- **WHEN** beats gap exceeds 45 minutes
- **THEN** honest time excludes the gap.

### Requirement: Runs MUST carry debts, normalized cost and skill locks

`carryDebts(prev, next)` MUST transfer open debts/placeholders; `normalizedCost(usage)`
MUST apply out×5 + write×1.25 + read×0.1 with role split and cache-churn
tripwire; `verifySkillsLock(lock)` MUST check SHA-256 hashes.

#### Scenario: Tampered skill detected
- **WHEN** a SKILL.md hash mismatches the lock
- **THEN** verification fails naming the skill.

### Requirement: Dashboard MUST snapshot with a guarded server

`embedSnapshot(html, state)` MUST embed state between markers for file://
viewing; the server MUST shut down gracefully with foreign-process protection;
`detectCollision(dir)` MUST flag parallel live sessions.

#### Scenario: Foreign server survives
- **WHEN** a non-harness process holds the port
- **THEN** shutdown leaves it running.
