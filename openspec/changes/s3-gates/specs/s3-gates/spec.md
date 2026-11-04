# S3 Gates COCO Prune

## ADDED Requirements

### Requirement: Quality gate and hotspots within ceilings with margin
`tools/quality.mjs` SHALL sit at or under its 700-line ceiling with ≥5% margin by splitting CLI and engine. `sync.mjs:main` and `usage-audit.mjs:auditUsage` SHALL each sit at or under their 200-line COCO ceilings without upwards baseline re-seeds.

#### Scenario: Quality gate and functions within limits
- **WHEN** `node tools/code-size.mjs check --root .` runs
- **THEN** `tools/quality.mjs` is ≤ 700 lines with margin, and `sync.mjs:main` and `usage-audit.mjs:auditUsage` are ≤ 200 lines

### Requirement: Unwired dead modules pruned
The 9 unwired modules (`asset-freeze.mjs`, `blind-accept.mjs`, `capsule.mjs`, `checkpoints.mjs`, `coverage-check.mjs`, `fallback.mjs`, `supervision.mjs`, `two-phase.mjs`, `usage-normalize.mjs`) and their tests SHALL be pruned from the repository with zero production callers.

#### Scenario: Unwired modules removed cleanly
- **WHEN** the 9 unwired modules are deleted
- **THEN** all production callers are confirmed zero, indices and CODEMAPs are cleaned, and all remaining tests pass green
