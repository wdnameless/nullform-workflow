# Legacy acceptance — s1-workflow-split

`review-evidence.json` (native `workflow review-run` transport) does not exist for this
change. That is a deliberate, recorded exemption, not an oversight.

Reason: the acceptance audit for this slice ran as an independent read-only oracle pass
under constraint C5 ($0 spend through ledger, zero model calls for slice S1), not through
the paid HTTP review pipeline. The verdict is preserved verbatim in `oracle.md`. The
manifest's acceptance criteria are all locally executable (`code-size check`, `quality check`,
`bin/nullform.mjs` passthrough, frozen test suites) and have been verified live.

Nothing here claims native review coverage. When this change next needs a reviewed diff, use
`workflow review-run` and delete this file so the exemption does not quietly outlive its reason.
