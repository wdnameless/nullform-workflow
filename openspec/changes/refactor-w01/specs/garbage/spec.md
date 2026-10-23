# Garbage removal

## ADDED Requirements

### Requirement: Dead skill removed

skills/biblicism-extractor SHALL NOT exist; skills-doctor SHALL NOT
report it; no live references SHALL remain.

#### Scenario: Doctor clean
- **WHEN** skills-doctor runs against repo skills
- **THEN** biblicism-extractor appears in neither errors nor orphans

### Requirement: Skill names match directories

Skill directories SHALL match their declared `name:` frontmatter.
frontend-design-anthropic → frontend-design,
industrial-brutalist → industrial-brutalist-ui.

#### Scenario: Names clean
- **WHEN** skills-doctor runs
- **THEN** no name-mismatch notes for these two

### Requirement: Dead exports removed

Functions with zero production callers SHALL lose `export`
(benchmark 22, oracle-model duplicate+6, usage-audit facade,
return-contract duplicate constants); tests SHALL pass
via CLI or public facade.

#### Scenario: Suite green
- **WHEN** the full tools/tests suite runs
- **THEN** all pass with no import of removed symbols

### Requirement: Merged worktrees pruned

15 worktrees of branches merged into HEAD with zero dirty files
SHALL be removed via `git worktree remove --force`; dirty ones stay.

#### Scenario: List clean
- **WHEN** `git worktree list` runs
- **THEN** none of the 15 merged-clean entries remain
