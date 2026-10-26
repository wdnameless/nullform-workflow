# arch-drilldown-sketch — proposal

## Why
The Architecture tab renders three flat views of one level: a directory tree, a
module-level dependency graph, and a table. A user who wants to know *what is inside*
`tools/` has to leave the dashboard. The user asked for a live architecture view drawn
in an Excalidraw-like hand-drawn style that starts high and lets them descend level by
level, and referenced a dashboard whose selling point is that you never have to go
looking for anything.

## What Changes
- New collector `collectSymbolInventory` (tools/dashboard-collectors.mjs): per-file
  symbols with line ranges, reused from `scanFile` in `tools/code-size.mjs`, capped and
  sanitized; a module → file → symbol tree (`collectArchDrill`).
- New module `tools/dashboard-sketch.mjs`: a pure sketch-geometry generator — seeded
  jitter so the drawing is stable across refreshes, rounded boxes, double-stroked
  edges — plus `.excalidraw` serialization of the same graph.
- Architecture tab gains a fourth mode «Эскиз» (sketch): project → modules → files →
  symbols, breadcrumbs, Esc/back, and a download button for `.excalidraw`.
- `/api/state` carries the drill tree; a new endpoint `/api/arch.excalidraw` serves the
  file for the current drill path.

## Impact
Three files touched, one added: `dashboard-collectors.mjs`, `dashboard.mjs` (sanitize +
route), `dashboard-ui.mjs` (mode + renderer), new `dashboard-sketch.mjs`. Existing
modes and tests keep working; the sketch mode is reachable only from the tab. No new
npm dependency.
