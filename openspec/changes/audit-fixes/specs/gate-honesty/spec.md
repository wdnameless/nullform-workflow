# Gate honesty

## ADDED Requirements

### Requirement: A gate never certifies input it did not understand

A validator MUST reject an unreadable or unknown input rather than returning success.
Silence is not consent: a misspelled tier, a zero-byte exemption marker, or a truncated
state file MUST produce a refusal that names the problem.

#### Scenario: Unknown tier

- **WHEN** `validateReviewEvidence` receives a tier that is not T0, T1, T2 or T3
- **THEN** it returns `ok: false` with the received value in the message, and T0/T1 remain exempt because their gates are artifacts, not evidence

#### Scenario: Empty legacy marker

- **WHEN** a change carries `legacy-acceptance.md` but the file states no reason
- **THEN** the gate refuses and asks for the reason, because the marker's only value is the statement it carries

### Requirement: Recording predicts validation

A command that records evidence MUST reject exactly what the validator would reject, at
the moment of recording, with the same reason.

#### Scenario: Artifact outside its change directory

- **WHEN** `artifact --kind manifest --path foo.md` is run before `foo.md` lives inside the recorded change directory
- **THEN** the recorder refuses immediately and names the required location, instead of accepting it and failing later at `check`
