# apple-shell — proposal

## Why
The dashboard is a single opaque dark sheet: one flat background, one border colour, and
type that never changes shape with size. It reads as a terminal, not as an instrument
panel. The user asked for Apple-grade styling and, separately, named the panels our
dashboard is missing compared with the reference project (waiting-for-you, what's needed
from you, blind acceptance, stale checks).

Two of those four are not "missing UI" but **dead wiring**: `state.waiting` is read by
`collectors` and never written by any command, so the orange state and the working-time
subtraction are unreachable. The checks tile reports green from a 32-day-old cache.

## What Changes
- **Materials.** Translucent sticky header and rail (`backdrop-filter: blur+saturate`,
  bright top edge), content scrolling beneath; material weight encodes hierarchy
  (rail heavier than header, cards lightest). Dim-to-focus scrim only for the modal.
- **Type.** One scale with size-specific tracking: display sizes get negative tracking
  and tight leading, body near zero, micro-labels positive. System font first, spacing
  in `rem` so a larger user font does not break layout.
- **Motion.** Enter/exit on `transform` + `opacity` with mirrored easing; press feedback
  on `pointer-down`; nothing animates layout. Springs approximated with
  `cubic-bezier(.32,.72,0,1)` on the compositor only.
- **Accessibility.** `prefers-reduced-motion` → cross-fade, `prefers-reduced-transparency`
  → solid, `prefers-contrast: more` → defined borders.
- **`workflow ask|answered`.** A real producer for `state.waiting`, closing into
  `state.waits`; the dashboard then shows waiting and stops counting working time.
- **«Понадобится от тебя»** — keys from `.env.example`, placeholders, assumptions.
- **Blind-acceptance card** — `matched / checked` plus disagreements from `oracle.md`.
- **Stale checks** — age of `dashboard-checks.json` shown; older than a day is amber.

## Impact
`tools/workflow.mjs` (two commands), `tools/dashboard-collectors.mjs` (waiting, needed,
blind, checks age), `tools/dashboard-ui.mjs` (CSS + three cards), and one new client
module for the presentation of those cards. Existing tabs, the sketch mode, and every
current gate stay; no new dependency.
