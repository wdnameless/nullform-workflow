# Arch drill-down sketch

## ADDED Requirements

### Requirement: Symbol inventory
The dashboard SHALL expose, per file, the symbols the file declares — name, kind,
start and end line — sourced from the same scanner the size gate uses, so the map and
the gate never disagree about what a function is.

#### Scenario: Python file
- **WHEN** `collectSymbolInventory` reads a `.py` file with `def handle(...)`
- **THEN** the rows include `{ name: "handle", kind: "function" }` with real line numbers.

#### Scenario: Unreadable file
- **WHEN** the file cannot be read or parsed
- **THEN** the collector returns empty `symbols` and does not throw.

### Requirement: Drill levels
The architecture tab SHALL begin at the project level and descend module → file →
symbol on click, with a breadcrumb and a back action.

#### Scenario: High level first
- **WHEN** the sketch mode is opened
- **THEN** only project and module nodes are drawn; no file or symbol is visible.

#### Scenario: Descend and return
- **WHEN** a module is clicked, then a file, then `Esc`
- **THEN** the view shows files, then symbols, then returns to the previous level.

### Requirement: Hand-drawn rendering
The diagram SHALL be drawn without external libraries in a hand-drawn style that is
stable across refreshes: identical input produces identical geometry.

#### Scenario: Stable refresh
- **WHEN** the same state is rendered twice
- **THEN** every generated path string is byte-identical.

### Requirement: Excalidraw export
The dashboard SHALL offer the current view as a `.excalidraw` file that excalidraw.com
opens without repair.

#### Scenario: Envelope validity
- **WHEN** `/api/arch.excalidraw` is fetched
- **THEN** the body parses as JSON with `type: "excalidraw"`, `version: 2`, and a
  non-empty `elements` array whose every entry has an `id`, `type`, `x`, `y`, `width`.
