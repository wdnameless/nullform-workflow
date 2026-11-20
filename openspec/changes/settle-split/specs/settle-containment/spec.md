# Settle containment

## ADDED Requirements

### Requirement: Settle target collection resolves real paths

Every path collected as a settle target MUST pass the real-path containment check,
not only the lexical one, because collection ends in recursive deletion.

#### Scenario: Junction planted in the worktree base

- **WHEN** `.tmp/worktrees/featureevil` is a junction to a directory outside the project
- **THEN** `resolveSettleTargets` does not include it and `removeSettleWorktrees` leaves the outside directory intact

### Requirement: A crashed gate probe fails loudly

The fixture `gate()` helper MUST throw when its probe process crashes instead of
returning the rejection shape that tamper tests assert.

#### Scenario: Probe exits non-zero

- **WHEN** the gate probe process exits with a non-zero status
- **THEN** the helper throws an error naming the crash, and no rejection assertion can pass on it
