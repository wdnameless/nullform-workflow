# Stack-aware quality gate

## ADDED Requirements

### Requirement: Analyzer selection is data, not code
The system SHALL describe every supported stack in `tools/quality/stacks.json`
(`markers`, `coco`, `metric`, `threshold`, `run.argv`, `run.parser`, `install`,
`configs`, `verifiedOn`) and `tools/quality.mjs` SHALL contain no per-language branch.

#### Scenario: Adding a language
- **WHEN** a new row is appended to `stacks.json` with known markers and a known parser
- **THEN** `detect`, `plan`, `install` and `check` handle it without changing any `.mjs` file
- **AND** an unknown parser name fails `loadStacks` with the offending stack id

#### Scenario: Detection evidence
- **WHEN** `detect` runs on a project containing `package.json` and a stray `.py` file
- **THEN** the node stack reports `package.json` as proof, not the extension match

### Requirement: The gate refuses to pass an analyzer it did not run
`check` SHALL exit non-zero when a detected stack's analyzer is absent, crashed, or
produced no parseable report, and SHALL distinguish `missing-tool`, `tool-error`,
`unparsable` and `unseeded` from `pass`.

#### Scenario: Missing toolchain
- **WHEN** `check --stack rust` runs on a host without `cargo`
- **THEN** the stack reports `missing-tool` and the command exits 1
- **AND** no line of output claims the tree is clean

#### Scenario: Unseeded baseline
- **WHEN** a baseline exists with `seeded: false`
- **THEN** `check` reports one `unseeded` line naming the `baseline` command to run
- **AND** it does not report every legacy offender as `new`

### Requirement: Cognitive complexity only ratchets down
`check` SHALL fail a function whose cognitive complexity exceeds its stack threshold and is
absent from the baseline (`new`), and any function exceeding its recorded value (`growth`).
`baseline` SHALL store `min(recorded, measured)` so re-seeding can lower a ceiling and never
raise it.

#### Scenario: Growth inside a baselined file
- **WHEN** a baselined function goes from 106 to 117
- **THEN** `check` exits 1 and names the function, both numbers and the file

#### Scenario: Legacy tree on day one
- **WHEN** `install` runs on a tree with 242 functions above 15
- **THEN** it seeds all 242 and the immediately following `check` exits 0

#### Scenario: Refactor lowers the ceiling
- **WHEN** `baseline` re-runs after a function drops below its recorded value
- **THEN** the stored value decreases and the report counts the decrease as `lowered`

### Requirement: Proxy metrics are labelled, never equated
A stack whose analyzer does not compute Sonar-style cognitive complexity SHALL declare
`coco: "proxy"` and a `metric` string naming the metric it actually measures.

#### Scenario: Ruby and Swift
- **WHEN** `detect` prints the ruby stack
- **THEN** its metric names RuboCop `PerceivedComplexity` and states it is not Sonar COCO

### Requirement: Installation is explicit and reversible
`install` SHALL write only harness-owned files under `.quality/<stack>/`, SHALL leave the
project's own analyzer configuration untouched, SHALL NOT install anything for a stack that
was not detected, and SHALL support `--dry-run` that writes nothing.

#### Scenario: Sidecar composition
- **WHEN** `install --stack node` runs in a project with its own `eslint.config.mjs`
- **THEN** `.quality/node/eslint.config.mjs` is created and the project file is byte-identical
- **AND** the analyzer argv passes the sidecar explicitly via `-c`

#### Scenario: Dry run
- **WHEN** `install --dry-run` runs
- **THEN** neither `.quality/**` nor `.quality-baseline.json` exists afterwards

### Requirement: One surface, two entrypoints
`nullform quality <command>` and `node tools/quality.mjs <command>` SHALL execute the same
implementation with the same exit codes (0 clean, 1 violation or unverified, 2 cannot run).

#### Scenario: npm CLI forwards argv unchanged
- **WHEN** `nullform quality check --stack node --changed` runs
- **THEN** the gate receives exactly those flags

### Requirement: The gate runs in CI without failing un-opted projects
Both CI templates SHALL run the gate only when `.quality-baseline.json` exists.

#### Scenario: Consumer project without a baseline
- **WHEN** the workflow template runs in a project that never ran `install`
- **THEN** the step prints an opt-in hint and does not fail the build
