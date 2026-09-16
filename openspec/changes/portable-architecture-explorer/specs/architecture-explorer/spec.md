# Architecture explorer

## ADDED Requirements
### Requirement: Offline Russian exploration
The report SHALL display a dark minimalist Russian interface with every indexed module reachable, expandable graph, search, fit/reset, zoom/pan and detail navigation.
#### Scenario: Open and explore
- **WHEN** a scanned report is opened with file:// and networking unavailable
- **THEN** users can find a module, inspect its symbols/dependencies and expand/reset the graph without console errors

### Requirement: Grounded calls
The scanner SHALL resolve JS/TS symbols and static calls using syntax and symbol identity rather than identifier string matching, while exposing unresolved/dynamic calls and other-language limitations.
#### Scenario: Aliases and methods
- **WHEN** source imports an alias through a re-export and calls a class method
- **THEN** the graph connects the actual project declarations and does not conflate shadowed identifiers
#### Scenario: Dynamic target
- **WHEN** a target cannot be resolved safely
- **THEN** the report labels that call unresolved instead of inventing an edge
