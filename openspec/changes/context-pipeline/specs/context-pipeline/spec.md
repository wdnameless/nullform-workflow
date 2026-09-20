# Context pipeline

## ADDED Requirements
### Requirement: Context requests are first-class
Agents SHALL record missing-context requests in context/REQUESTS.md via context-inbox and name the drop path; tasks SHALL proceed with stated assumptions instead of blocking.
#### Scenario: Missing brand kit
- **WHEN** a design task lacks brand assets
- **THEN** a request row appears (category design) and the user is told the drop path

### Requirement: Bounded domain context
domain-context SHALL produce a bounded summary from repo, git and (when available) gh issues, degrading gracefully.
#### Scenario: No gh installed
- **WHEN** gh is missing
- **THEN** output notes the limitation and still lists files and commits

### Requirement: Strongest available oracle
oracle-model SHALL resolve the first priority match among available models and write it to the oracle roles, falling back to the configured fallback entry, never printing secrets.
#### Scenario: Only fallback available
- **WHEN** no priority match is available
- **THEN** oracle resolves to gemini-3.8-flash-high and apply reports it

### Requirement: Human-readable plan
T2 proposal SHALL stay free of implementation details.
#### Scenario: Wave 2 plan
- **WHEN** proposal.md is written
- **THEN** it reads as a human plan; details live in interfaces.md/tasks.md
