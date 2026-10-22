# Dashboard run view (autopilot parity)

## ADDED Requirements

### Requirement: Run hero with state color

The dashboard SHALL show a run hero block when a workflow run is open:
blue = working, orange = waiting for human, green = closed, red = failed.
Below it SHALL be one plain sentence (stages done, requirements done) and
a stage track lane → recon → manifest → openspec → interfaces → oracle.

#### Scenario: Open T2 run
- **WHEN** `.workflow/state.json` has status open and tier T2
- **THEN** the hero is blue, current stage is highlighted, sentence shows counts

#### Scenario: Closed run
- **WHEN** status is closed
- **THEN** the hero is green with delivery summary (oracle verdict, debts)

### Requirement: Requirements in user words

The run view SHALL list every R## row from the change manifest.md verbatim
(truncated to 200 chars) with status, plus a status filter.

#### Scenario: Manifest present
- **WHEN** manifest.md contains R## rows
- **THEN** each appears quoted with done/open derived from state coverage

### Requirement: Gates G1-G4 visible

The run view SHALL show four gates derived from artifacts:
G1 manifest recorded, G2 openspec present, G3 interfaces recorded,
G4 oracle ACCEPT. Each SHALL be pass/open/fail, never invented.

#### Scenario: Partial run
- **WHEN** only manifest is recorded
- **THEN** G1 pass, G2–G4 open

### Requirement: Work clock excludes waits

The run view SHALL count activeMs excluding wait intervals and tick live
every second without reload. Poll of `/api/state` stays at 3s; render on rev.

#### Scenario: Waiting interval
- **WHEN** state contains a wait span
- **THEN** activeMs excludes it and waitMs shows it separately

### Requirement: Frozen offline snapshot

`dashboard.mjs --freeze` SHALL emit HTML carrying the state snapshot that
renders by double-click without a server, with an offline badge.

#### Scenario: No server
- **WHEN** frozen HTML opens with `/api/state` unreachable
- **THEN** it renders from the snapshot and shows the offline badge
