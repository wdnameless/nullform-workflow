# Apple-grade shell and the missing panels

## ADDED Requirements

### Requirement: Translucent materials
Chrome that floats above content SHALL be a translucent material rather than an opaque
bar: a blurred, saturated backdrop with a bright top edge, and content visible beneath it.

#### Scenario: Header material
- **WHEN** the page is generated
- **THEN** the header rule carries `backdrop-filter` with both blur and saturate, its
  background is translucent, and it stays `sticky`

#### Scenario: Material weight
- **WHEN** the rail and the header are compared
- **THEN** the rail reads as the heavier surface (stronger tint) than the header, and
  both are heavier than a card

### Requirement: Size-specific typography
Tracking and leading SHALL change with size: display text with negative tracking and
tight leading, body text near zero, micro-labels with slightly positive tracking.

#### Scenario: No global tracking
- **WHEN** the stylesheet is inspected
- **THEN** no single `letter-spacing` is applied to every element, and the display rule
  uses `clamp()` with a negative tracking value

### Requirement: Interruptible motion
Motion SHALL be compositor-only and never block input: transitions on `transform` and
`opacity`, no layout-affecting animation, press feedback on pointer-down.

#### Scenario: No layout animation
- **WHEN** the stylesheet is inspected
- **THEN** no `animation` targets width/height/margin/padding, and interactive elements
  transition `transform`, `opacity` or `background`

### Requirement: Accessibility signals
The shell SHALL honour three independent user preferences.

#### Scenario: All three media queries exist
- **WHEN** the stylesheet is inspected
- **THEN** `prefers-reduced-motion: reduce`, `prefers-reduced-transparency: reduce`, and
  `prefers-contrast: more` each have a rule

### Requirement: Waiting for the user is a real state
A run that waits for the human SHALL record it, and the waiting time SHALL NOT count as
working time.

#### Scenario: ask then answered
- **WHEN** `workflow ask briefing --note "…"` runs and later `workflow answered` runs
- **THEN** `state.waiting` exists between the two calls, is cleared after, and an entry
  appears in `state.waits` with a positive duration

#### Scenario: Working clock stops
- **WHEN** a run is in `waiting`
- **THEN** the collector reports `status: "waiting"`, `waitMs` greater than zero, and
  `activeMs` smaller than wall-clock elapsed

### Requirement: Needed from you
The dashboard SHALL list what the human still has to supply: environment variable names
without values, placeholders standing in for real data, and assumptions made for them.

#### Scenario: Three kinds collected
- **WHEN** a project has an `.env.example` with `A=`, a file containing `PLACEHOLDER`, and
  a manifest row marked as an assumption
- **THEN** the collector reports each in its own list

#### Scenario: Empty is a state, not an error
- **WHEN** nothing is outstanding
- **THEN** the collector returns empty lists and the panel says so

### Requirement: Blind acceptance card
The dashboard SHALL show how many requirements blind acceptance confirmed and name the
disagreements.

#### Scenario: Counts from the oracle verdict
- **WHEN** `oracle.md` marks rows proven, partial and missing
- **THEN** `matched` counts the proven rows, `checked` counts all judged rows, and the
  partial/missing rows appear as disagreements

### Requirement: Stale checks are visible
A cached automated-check result older than a day SHALL be reported as stale rather than
as a pass.

#### Scenario: Old cache
- **WHEN** `dashboard-checks.json` has `generatedAt` 32 days ago
- **THEN** the collector reports `stale: true` with the age in days
