# Supervision

## ADDED Requirements

### Requirement: Agent state MUST classify from declarative manifests

A manifest MUST be a list of `{ id, state, pattern }` rules; states are exactly
`working | blocked | idle`. `classify(manifest, tail)` MUST return the first
matching rule's state, else `idle`.

#### Scenario: First match wins
- **WHEN** several rules match the tail
- **THEN** the classifier returns the first matching rule's state.

### Requirement: Completion MUST await via an event barrier with timeout

`waitForState(classifier, want, { timeoutMs })` MUST resolve when the classifier
reports a wanted state and reject with `timeout` after `timeoutMs`. Consumers
MUST NOT run their own polling loops; the barrier owns the wait.

#### Scenario: Barrier timeout
- **WHEN** no wanted state arrives within `timeoutMs`
- **THEN** the barrier rejects with a `timeout` error.
