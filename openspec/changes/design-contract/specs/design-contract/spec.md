# Design contract

## ADDED Requirements
### Requirement: Persistent design contract
refero-design SHALL read docs/DESIGN.md before research when it exists and merge updates after locking, without destroying untouched sections.
#### Scenario: Second session reuse
- **WHEN** a project has docs/DESIGN.md from a previous session
- **THEN** the skill starts from it instead of re-researching, and updates only changed sections

### Requirement: Examples as specification
The skill SHALL reference docs/examples/good and bad folders in research and QA when present; the approved lock overrides examples and conflicts are reported.
#### Scenario: Conflict
- **WHEN** an example contradicts the locked direction
- **THEN** lock wins and the conflict is named

### Requirement: Hard media rules
Skills generating bitmap media SHALL state the four hard rules as HARD, not advisory.
#### Scenario: Text in raster
- **WHEN** a generation prompt would place a wordmark in the raster
- **THEN** the rule forbids it; text is an overlay

### Requirement: Control-surface rule
AGENTS.md SHALL instruct proposing a control surface after a repeated manual edit.
#### Scenario: Third manual pass
- **WHEN** the same manual edit is requested a second time
- **THEN** the agent proposes a script/UI instead of a third pass
