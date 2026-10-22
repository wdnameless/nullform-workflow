# Edit safety

## ADDED Requirements

### Requirement: Edits MUST prove fact-forcing reads first

`assertFactForcing(target, evidence)` MUST throw unless `evidence.reads`
lists prior reads of the target's callers/consumers. The error MUST name the
missing evidence.

#### Scenario: Edit without reads refused
- **WHEN** an edit arrives with no caller/consumer reads
- **THEN** the guard throws naming the missing evidence.

### Requirement: Destructive edits MUST run in two phases

`planDestructive(edit)` MUST return a `planToken` binding the edit hash;
`executeDestructive(planToken, edit)` MUST refuse unknown or mismatched tokens
and execute only verified plans.

#### Scenario: Token mismatch refused
- **WHEN** execution presents an unknown or mismatched token
- **THEN** it is refused and nothing executes.

### Requirement: Trajectories MUST trip on loops and step limits

`observeTrajectory(events, { maxSteps, loopWindow })` MUST flag repeated
identical tool calls within `loopWindow` as a loop and throw when `maxSteps`
is exceeded.

#### Scenario: Looping subagent flagged
- **WHEN** identical calls repeat inside the window or steps exceed the limit
- **THEN** the monitor reports the loop or throws on the limit.
