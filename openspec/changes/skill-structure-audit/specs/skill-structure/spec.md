# Skill structure

## ADDED Requirements

### Requirement: Audit loaded bodies separately from metadata
The existing prompt-lint CLI SHALL expose structural skill audit findings without treating discovery metadata size as body size.

#### Scenario: Large body with small description
- **WHEN** a SKILL body exceeds500lines while its metadata fits discovery budgets
- **THEN** structural audit reports the body recommendation independently of the metadata result

### Requirement: Verify discoverable supporting references
The audit SHALL check concrete local reference destinations and navigation of long references without confusing fenced examples or external links with file requirements.

#### Scenario: Missing supporting file
- **WHEN** an actual local Markdown link points to an unavailable file
- **THEN** structural --check fails and names the source and missing target

#### Scenario: Preserved restructuring
- **WHEN** optional detail is moved out of an oversized skill
- **THEN** the entrypoint directly links the preserved detail, preserves triggers and remains within the recommended body size
