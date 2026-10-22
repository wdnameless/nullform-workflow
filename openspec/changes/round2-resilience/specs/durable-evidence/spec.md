# Durable evidence

## ADDED Requirements

### Requirement: Oracle assets MUST be hashed and masked

`freezeAssets(files)` MUST record SHA-256 hashes plus exclude-masks;
`verifyAssets(record)` MUST fail when any asset hash mismatches or an asset
matches an agent-patch mask.

#### Scenario: Tampered asset detected
- **WHEN** a frozen asset changes or matches a patch mask
- **THEN** verification fails naming the asset.

### Requirement: Waves MUST checkpoint and resume

`checkpointWave(store, wave, state)` MUST persist progress durably;
`resumeWave(store)` MUST return the first incomplete wave so resume continues
without rerunning completed steps.

#### Scenario: Resume skips completed waves
- **WHEN** waves 1–2 are checkpointed complete and wave 3 failed
- **THEN** resume returns wave 3 with its saved state.

### Requirement: Receipts MUST chain by hash with effect classes

`appendReceipt(log, entry)` MUST append NDJSON with a SHA-256 chain hash over
the previous receipt; `verifyChain(log)` MUST fail on any broken link.
Entries MUST carry an effect class (SE0–SE4).

#### Scenario: Broken chain rejected
- **WHEN** any receipt is modified or removed
- **THEN** chain verification fails at that position.
