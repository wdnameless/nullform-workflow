# repair-red-findings — spec deltas

## ADDED Requirements

### Requirement: Broken tests pass or skip explicitly
Previously red tests SHALL pass; environment-dependent tests SHALL skip with a reason.

#### Scenario: Delete-guard suite loads
- **WHEN** running node --test tools/tests/delete-guard.test.mjs
- **THEN** exit is 0 and all tests pass.

#### Scenario: JEV suite skips without bun
- **WHEN** bun is absent from PATH
- **THEN** JEV tests report SKIP (bun not in PATH), not FAIL.

#### Scenario: Paseo install compares canonical paths
- **WHEN** tmpdir contains 8.3 short names on Windows
- **THEN** the .harness-root comparison passes.

### Requirement: Every CLI answers --help safely
Every tools/*.mjs CLI SHALL print usage and exit 0 on --help without side effects;
no CLI SHALL hang on empty stdin.

#### Scenario: Help is safe
- **WHEN** running any of the 6 CLIs with --help
- **THEN** exit is 0 with usage text and no live execution.

### Requirement: No archmap remnants or hardcoded paths
No archmap references SHALL remain; no machine-specific absolute paths in shipped files.

#### Scenario: Grep is clean
- **WHEN** grepping archmap and D:/ paths in repo
- **THEN** no matches in shipped files (history/transcripts excluded).

### Requirement: Skills fit budgets with direct links
Skill bodies SHALL fit 500 lines; references SHALL use direct markdown links.

#### Scenario: Audit warnings clear
- **WHEN** running skill-audit on the three skills
- **THEN** no body-size errors and no resource-discovery warnings for fixed files.
