# Dashboard split

## ADDED Requirements

### Requirement: Layers extracted

Collectors (scan/collect/parse/compute/session/events/arch) SHALL live in
tools/dashboard-collectors.mjs; generateDashboardHtml in tools/dashboard-ui.mjs;
tools/dashboard.mjs SHALL be server/CLI (~1050 lines) re-exporting all 28
test-consumed symbols.

#### Scenario: Facade complete
- **WHEN** every import in the 3 test files resolves from dashboard.mjs
- **THEN** no import errors

### Requirement: Dashboard behavior invariant

/api/state, /api/health, /api/diff, freeze snapshot, CLI flags SHALL behave
identically; dashboard.test + autoreview + u-waves green; live smoke passes.

#### Scenario: Live smoke
- **WHEN** the server starts and /api/state is fetched
- **THEN** run/stages/requirements/gates/waves present as before
