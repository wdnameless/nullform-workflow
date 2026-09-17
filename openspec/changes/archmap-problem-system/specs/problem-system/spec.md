# Problem system

## ADDED Requirements
### Requirement: Categorized prioritized Russian problems
The scanner SHALL emit problems tagged with category (structure/optimization/security/reliability/maintainability) and severity (critical/high/medium/low), all text in Russian, sorted critical first, honestly marked heuristic.
#### Scenario: Cycle + secret
- **WHEN** a project has a dependency cycle and a hardcoded API key literal
- **THEN** the key is critical+security, the cycle is high+structure, both with Russian title/why/fix

### Requirement: One-click AI prompt
Each problem SHALL carry a ready Russian prompt with file+lines, rationale, suggested fix and bounded code excerpt with secrets redacted.
#### Scenario: Copy for AI
- **WHEN** user clicks copy in the report
- **THEN** clipboard receives a prompt an AI can act on without extra context

### Requirement: Per-file local graph
The report SHALL show, for any selected file, a local graph of its imports, importers and its own function call edges, with a way back to the full map.
#### Scenario: Drill into a file
- **WHEN** user opens a file view
- **THEN** only that file neighborhood is rendered, no console errors, and «К карте» restores the full clustered view

### Requirement: Folder clusters
On projects with many files the module view SHALL group files by folder, expandable, with all files reachable.
#### Scenario: Large repo
- **WHEN** scanning a 100+ file project
- **THEN** initial view shows folder groups and every file is reachable within two clicks
