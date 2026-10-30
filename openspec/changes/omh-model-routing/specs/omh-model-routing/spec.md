# OMH model routing

## ADDED Requirements

### Requirement: Role model categories
Models.yml SHALL define strict/builder/scout categories with ordered
chains + effort; resolution SHALL stop-ask on unavailable models, never
silently substitute.

#### Scenario: Empty chain
- **WHEN** every model in the chain is unavailable
- **THEN** resolution throws MODEL_STOP_QUESTION instead of picking another

### Requirement: Auto-router with approval
`model-router --scan/--plan` SHALL propose assignments from probed
providers; `--apply` SHALL write only with explicit approval.

#### Scenario: No approval, no write
- **WHEN** `--apply` runs without `--yes`
- **THEN** it refuses and models.yml is byte-identical

### Requirement: Reported vs verified status
Run stages SHALL carry verified flags; `close` SHALL refuse reported-only
work without --force --reason.

#### Scenario: Unverified close
- **WHEN** a stage is done but not verified
- **THEN** close fails naming reported-but-unverified stages

### Requirement: Memory decisions with reasons
Memory cadence SHALL store keep/reject/defer with written reasons and
exclude rejected from session packs.

#### Scenario: Rejected memory
- **WHEN** a memory is rejected with a reason
- **THEN** session packs omit it while keeping the decision on record
