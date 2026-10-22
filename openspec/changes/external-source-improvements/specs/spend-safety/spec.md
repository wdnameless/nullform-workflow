# Spend safety

## ADDED Requirements

### Requirement: Usage ledger MUST be idempotent and enforce tier ceilings

`recordReceipt(ledger, receipt)` MUST be idempotent on `receipt.id`.
`admit(ledger, tier, cost)` MUST throw when `used[tier] + cost > ceiling[tier]`.
The ledger MUST persist to disk; reload after restart preserves used/receipts.

#### Scenario: Restart-safe receipts
- **WHEN** the same receipt is recorded twice across a restart
- **THEN** usage is counted once and the ceiling state is unchanged.

### Requirement: Dangerous tools MUST pass a pre-call gatekeeper

`authorize(tool, args)` MUST return `{ ok: true }` or `{ ok: false, rule }`.
Exec/write/network tools REQUIRE an explicit allow rule; default is deny.
Every decision MUST be appended to an audit log with tool, rule and timestamp.

#### Scenario: Denied call logged
- **WHEN** a dangerous tool has no allow rule
- **THEN** it is denied and the denial is logged with the rule name.
