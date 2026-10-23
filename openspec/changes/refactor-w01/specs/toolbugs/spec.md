# Tool bugfixes

## ADDED Requirements

### Requirement: Template-aware size scanning

maskJsCode SHALL track `${}` interpolation with push/pop stack
discipline and SHALL NOT inject fake braces into masked output.

#### Scenario: No phantom functions
- **WHEN** code-size scans tools/dashboard.mjs
- **THEN** no `esc()` phantom appears and generateDashboardHtml is found

### Requirement: Esc allow removed

The `code-size:allow` on UI-template `esc()` SHALL be removed once
the scanner is fixed; `code-size check` SHALL PASS.

#### Scenario: Check green
- **WHEN** `node tools/code-size.mjs check` runs
- **THEN** exit 0 with no esc entry

### Requirement: Live ledger drift tolerated

quality-evidence SHALL treat live spend-ledger count drift as WARN/skip
(env dirt), not FAIL; the historical snapshot SHALL still validate.

#### Scenario: Green on drifted env
- **WHEN** bench/runs/spend-ledger.json has 35 settled
- **THEN** the test passes with a drift note
