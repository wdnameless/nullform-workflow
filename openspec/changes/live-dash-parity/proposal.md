# live-dash-parity — autopilot-like live dashboard + bug fixes

## Why
Users want the autopilot dashboard experience (hero, waves, verbatim
requirements, live clocks) over our T0–T3 engine, plus a hunt that already
surfaced 10 confirmed bugs in dashboard/workflow/doctor.

## What changes
- Full redesign of the run view in `tools/dashboard-ui.mjs` to the
  autopilot layout (hero, 8-stage track, waves matrix, verbatim R## with
  type badges, G1–G4, timing, feed, pending-question hero state).
- Polling 1–3s configurable (default 2s); 1s client clock tick; frozen
  snapshot performs zero network/timer activity.
- 10 bug fixes + 2 cycle breaks with regression tests.

## Non-goals
- SSE push (user chose polling); new workflow semantics; touching
  autopilot's own mechanisms beyond display parity.
