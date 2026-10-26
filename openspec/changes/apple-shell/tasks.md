# Tasks — apple-shell

- [ ] P01 Waiting producer: `workflow ask <kind> --note`, `workflow answered` in tools/workflow.mjs under the state lock; kinds validated; same-kind idempotent; close into `state.waits`. Acceptance: temp-project round trip — waiting set, waits entry appended, `activeMs < wall clock`.
- [ ] P02 Collectors: `collectNeeded`, `collectBlind`, `checksAge` in tools/dashboard-collectors.mjs; names-only env parsing, capped placeholders, oracle-verdict counts. Acceptance: unit tests on fixtures for all three, plus null when no oracle file.
- [ ] P03 Presentation: tools/dashboard-shell-client.mjs — SHELL_CSS (materials, size-specific tracking, compositor-only motion, three a11y queries) and SHELL_CLIENT_JS (needed, blind, checks badge). Acceptance: CSS assertions for all three media queries + no layout animation; client functions render from DATA only.
- [ ] P04 Wiring + proof: inject into tools/dashboard-ui.mjs, live browser smoke (waiting state turns the hero orange and freezes the work clock; needed/blind cards appear), tests green, code-size/quality unchanged or better.
