# Acceptance basis (no native review-evidence run)

This change cannot carry `review-evidence.json`: the mechanism requires a live
model dispatch (`NULLFORM_GATEWAY_API_KEY` or an admitted `openai` route), and
this environment has **no credentials**
(verified: `NULLFORM_GATEWAY_API_KEY` absent, `OPENAI_API_KEY` absent,
`gh secret list` empty). A native record describes an actual execution and
cannot be synthesised — fabricating one would be exactly the dishonesty the
gate exists to prevent.

What this change *does* provide instead, all executed on this tree:

- `oracle-verdict.md` — explicit ACCEPT with R01–R09 mapped to the commands
  that were run, plus four named residual risks.
- `weakness-report.md` — W01–W11 with file:line evidence.
- Real regression tests: `tools/tests/setup-heal.test.mjs` (5 tests, green),
  plus updated `doctor.test.mjs` / `code-size.test.mjs` / `u-waves.test.mjs`.
- Executed verification: `setup`/`heal` end-to-end in a temp home, dashboard
  liveness probe, push gate, lint, code-size, full suite.

**Follow-up required:** before this marker is reused for any later change, run
`workflow review-run --role reviewer|oracle` with credentials provisioned, so a
native record exists for that change. This marker is a statement of a real
limitation, not a bypass for convenience.
