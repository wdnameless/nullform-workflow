# Interfaces — live-dash-parity

## Ownership (disjoint zones)
- D01 designer: `tools/dashboard-ui.mjs` (render only), `tools/dashboard.mjs`
  (POLL_MS + `generateDashboardHtml` wiring only). No collector changes.
- F01 fixer: bug sites only — `dashboard-ui.mjs:24,441` (esc/title),
  `dashboard.mjs:773` (snapshot contract), `dashboard.mjs:675-730`
  (ensure race), `workflow.mjs:1580,929-948` (close event, artifact check),
  `doctor-lite.mjs:89-106` (abort accounting), `doctor-checks.mjs:628`
  (configs PASS). Freeze poll/timer sites owned by D01 (same redesign).
- F02 fixer: new `tools/doctor-shared.mjs`, `tools/workflow-shared.mjs`
  leaf modules + import rewiring only. No behavior changes.

## Contracts (seams on consumer side)
- `generateDashboardHtml(data, opts)` — data shape unchanged; `opts.pollMs`
  (1000–3000, default 2000), `opts.frozen` silences all timers/fetches.
- `/api/state` payload keys unchanged; `run.rev` drives re-render.
- `embedSnapshot(html, state)` writes `window.NF_SNAPSHOT` (matches UI).
- `doctorLite(root)` returns `{ok, warns, ms}`; syntax abort adds a warn
  naming skipped files (never silent ok).
- `checkConfigs(ctx)` returns `skip` (not pass) when zero configs present.
- `cmdArtifact` openspec kind requires non-empty `proposal.md` + `specs/`.
- Shared leaves export only moved symbols; `node --check` on all four
  modules + dynamic import smoke must pass.

## Built (Wave 3 returns)
- `generateDashboardHtml(data, {frozen, pollMs})` — pollMs 1000–3000
  default 2000; frozen silences fetches/timers.
- `startLiveServer(root, port, {maxAttempts, session, pollMs})`.
- `parseArgs` — `--poll`/`--poll-ms` with range errors.
- `esc(s)` exported from dashboard-ui.mjs.
- `ensureDashboard` single-flight via module Map + `_ensureDashboardImpl`.
- `embedSnapshot` writes NF_SNAPSHOT + legacy STATE alias.
- `doctor-shared.mjs` / `workflow-shared.mjs` leaf modules (DAG, no cycles).
