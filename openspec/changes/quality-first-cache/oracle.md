# Quality-First Neural Prompt Cache Acceptance Report

## Verdict: ACCEPT

Oracle returned executed evidence but did not persist the requested file; orchestrator records the returned payload verbatim in substance.

- R01 PROVEN: cache tools perform no context truncation, compaction, model switching, verification skipping, or auto-edits; quality-sensitive thresholds are advisory.
- R02 PROVEN: cacheRead/cacheWrite/input and cacheReadShare measured without claiming universal provider hit-rate.
- R03 PROVEN: real transcript reports warm/cold turns, shares, model switches and zero-usage turns.
- R04 PROVEN: Cache Doctor identifies only recorded model switch/fallback/compaction/fingerprint/zero-usage causes; otherwise UNKNOWN.
- R05 PROVEN: consecutive fingerprints have identical composite and layer hashes with sorted traversal.
- R06 PROVEN: policy exits zero on advisory thresholds and hard-fails only safe static invariants.
- R07 PROVEN: no model routing or writes to models.yml/config.yml/modelRoles.
- R08 PROVEN: valid return contract exits 0; malformed input exits 1 with Russian errors.
- R09 PROVEN: Node tests, Python tests, verify and audit pass.

Gates: deep module PASS; seams PASS; vocabulary PASS; quality-first PASS; regression PASS.
