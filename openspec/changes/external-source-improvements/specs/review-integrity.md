# review-integrity spec

## Cross-family oracle
- `resolveOracleModel({ builderFamily, candidates })` returns a candidate whose
  family differs from `builderFamily`, or throws naming the conflict.
- Family derivation is deterministic from the model id string (no network).

## Arbitration
- `arbitrate(findings, criteria)` returns `{ accepted, dropped }`.
- A finding is accepted only when it references a criterion id present in
  `criteria`; otherwise it is dropped with `reason: "no-criterion-match"`.
