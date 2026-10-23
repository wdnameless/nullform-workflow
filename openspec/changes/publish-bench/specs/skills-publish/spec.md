# Skills publish

## ADDED Requirements

### Requirement: Installable skills.sh package

The repo SHALL provide `skills/nullform/` installable via
`npx skills add wdnameless/nullform-workflow --skill nullform`:
SKILL.md with correct repo path, argument-hint, metadata.version,
disable-model-invocation; phases/briefing.md, phases/build.md,
phases/review.md with our commands; mirrors `.claude/skills/nullform/`
and `.agents/skills/nullform/`; skills-lock.json with SHA-256;
README install section + skills.sh badge.

#### Scenario: Install simulation
- **WHEN** the package is copied to a tmp agents-home per skills.sh layout
- **THEN** skills-doctor reports 0 problems and frontmatter parses

### Requirement: Version check on use

SKILL.md SHALL document a version check (`VERSION` vs repo) with the
update command, mirroring autopilot's update notice.

#### Scenario: Stale install
- **WHEN** installed version < repo VERSION
- **THEN** the documented command updates it
