# Shared layer

## ADDED Requirements

### Requirement: The standard library is used before any helper

A capability the Node runtime provides SHALL be used directly at its call site. A helper
SHALL NOT be introduced for a capability the runtime reaches, even when many call sites
would share it.

#### Scenario: Many call sites, runtime capability available

- **WHEN** the same capability is hand-rolled in many files and the runtime provides it
- **THEN** the hand-rolled copies are deleted and the runtime is called at each site, rather than a shared helper being introduced.

#### Scenario: Runtime capability is partial

- **WHEN** the runtime provides part of a capability with a measured, negligible gap
- **THEN** the call sites absorb the gap locally instead of a helper being introduced.

#### Scenario: A helper is proposed anyway

- **WHEN** a shared helper is proposed
- **THEN** it states the measured gap the runtime leaves, and is rejected when that gap is milliseconds of work or a single type conversion.

### Requirement: No tool imports another tool

A tool SHALL depend only on Node built-ins. Shared behaviour is either deleted or inlined.

#### Scenario: Tool imports tool

- **WHEN** one tool imports another tool
- **THEN** the shared behaviour is deleted or inlined rather than moved into a new module.

### Requirement: Replacing a caller preserves its published behaviour

Replacing a hand-rolled implementation SHALL NOT change the tool's command-line contract: the
same flags parse, unknown flags still produce the same outcome, and numeric flags keep their
type.

#### Scenario: Numeric flag keeps its type

- **WHEN** a tool that parses a numeric flag adopts the runtime parser
- **THEN** the flag is still a number after parsing, as its test asserts.

#### Scenario: Unknown flag outcome is unchanged

- **WHEN** a tool whose tests expect a nonzero exit on an unknown flag adopts the runtime parser
- **THEN** the outcome is unchanged.

#### Scenario: Behaviour the runtime cannot express

- **WHEN** a tool's parsing has behaviour the runtime does not cover and a test asserts it
- **THEN** the tool keeps its parser and is recorded as a deliberate exception.

### Requirement: The change does not grow the codebase

The work SHALL NOT increase the total line count.

#### Scenario: Measuring a migration batch

- **WHEN** a batch of call sites has been migrated
- **THEN** the batch's net line change is zero or negative.

#### Scenario: A migration that grows the code

- **WHEN** a migration batch reports a positive net line change
- **THEN** it is reverted rather than accepted.
