# Dashboard static privacy and diff resource usage

## ADDED Requirements

### Requirement: Static dashboard shares HTTP privacy policy

Generated `dashboard.html`, including the snapshot created before `--serve`, MUST use the same sanitized data projection as `/api/state` and `/`; arbitrary task text, oracle details, event bodies and patch contents MUST not be embedded. The standalone page MUST still render the structural metrics.

#### Scenario: Private task in static export
- **WHEN** a disposable project has a distinctive task marker and the CLI generates HTML
- **THEN** the file contains no marker, while its status, tier and progress data remain renderable.

### Requirement: Untracked diff metadata is bounded in memory

`/api/diff?file=...` MUST count line breaks in an untracked file with bounded per-request buffering, preserve its current line-count convention, and respond with metadata only. Tracked diffs and missing files keep their existing responses.

#### Scenario: Large untracked file
- **WHEN** an untracked file contains megabytes without a newline and the endpoint receives its exact path
- **THEN** it reports one added line without building an in-memory copy proportional to the file or emitting file contents.

### Requirement: Keep one registered CRO skill entry

The byte-identical nested `skills/cro/cro/SKILL.md` MUST be removed; `skills/cro/SKILL.md` remains the registered skill and non-identical resources are preserved.

#### Scenario: Skill registry scan
- **WHEN** the installed skills doctor lists top-level skills
- **THEN** `cro` remains available from its canonical top-level entry without a redundant nested SKILL.
