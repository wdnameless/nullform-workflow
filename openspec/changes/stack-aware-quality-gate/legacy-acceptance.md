# Legacy acceptance — stack-aware quality gate

`review-evidence.json` (native `workflow review-run` transport) does not exist for this
change. That is a deliberate, recorded exemption, not an oversight.

Reason: the acceptance audit for this slice ran as a **read-only oracle subagent**
(`QualityGateAudit`, transcript `history://QualityGateAudit`), not through the paid HTTP
review pipeline. The verdict is preserved verbatim in `oracle.md`. Running the native
review-run transport would have produced a second, unrelated model's opinion about the same
tree at real cost, and the manifest's acceptance criteria are all locally executable
(`detect`, `install`, `check`, `baseline`) — the audit exercised each of them by running the
artifact, which is the property the manifest asks for.

Nothing here claims native review coverage. When this change next needs a reviewed diff, use
`workflow review-run` and delete this file so the exemption does not quietly outlive its reason.
