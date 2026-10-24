# Requirements Manifest — live-dash-parity

User brief (verbatim): "Я хочу такой же дешборд как у них и чтобы он
обновлялся в livetime и юзер мог взять оттуда всю инфу, так же
проанализируй наши слабые места и поищи баги".

Wave 0 locked: full redesign of tools/dashboard.mjs, polling 1–3s.

| ID | Verbatim user quote | Acceptance | Status |
|----|---------------------|------------|--------|
| R01 | "такой же дешборд как у них" | Run-view: hero (blue/orange/green/red + WIP badge + 1-line summary), 8-stage track (Preflight→Manifest→Briefing→Spec→Plan→Dev→Review→Accept), waves task matrix (lanes, green/orange/purple/cyan/white states, repair counters), verbatim manifest list with R/Ri/G/A/D badges + status filters, G1–G4 grid, event feed | done |
| R02 | "обновлялся в livetime" | Polling 1–3s (configurable, default 2s) + 1s client tick for active/wait clocks; full re-render on rev change; freeze mode performs zero fetches and zero timer drift | done |
| R03 | "юзер мог взять оттуда всю инфу" | Single run view exposes: summary, stages, waves/tasks, requirements, gates, timing (active = beats ≤45m minus waits), feed, pending human question in orange hero; no info requires chat/CLI | done |
| R04 | "проанализируй наши слабые места и поищи баги" | All 10 confirmed findings fixed with regression tests: XSS title (ui:24), esc quote (ui:441), snapshot contract (STATE vs NF_SNAPSHOT), freeze polling (ui:1267), freeze timers (ui:1175,1180), ensureDashboard race, force-close event (workflow:1580), artifact openspec content check, doctor-lite silent abort, configs false PASS | done |
| R05 | "проанализируй наши слабые места" (cycles) | doctor↔doctor-checks and workflow↔workflow-ci cycles broken (shared leaf module); `node --check` + import smoke pass | done |

Out of scope (rejected claims, documented): esc single-quote attr breakout
(no single-quoted attr sinks found — esc covers all used sinks); pid-less
lock 5s freeze (1s unparsable-cleanup covers it); renameSync EBUSY crash
(no evidence — Windows concurrent read does not throw on rename target).
