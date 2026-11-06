# p1p2-adoption — interfaces

## T1 (R01) requirements/manifest — owner @fixer
`parseRequirement(row)` keeps returning `{id,type,status}` but MUST also expose
`verify` when a manifest header names a `verify` column.
`splitRow` already handles «», backticks and quotes; no signature change.
New: `validateManifestVerify(header, rows)` → `null | string` in
`tools/requirements.mjs`, called from `validateManifestRows`.
Rule: only enforced when the header row contains a `verify` cell.

## T2 (R02) reviewer modes — owner @fixer
`review-run --mode default|adversarial`. Mode is recorded in evidence.
`agent/agents/reviewer.md`: adversarial section requires ≥3 falsification
scenarios, each with evidence path or explicit UNVERIFIED.
No new role, no new agent.

## T2 (R04) perf check — owner @fixer
Hot-path predicate `isHotPath(file)` exported from existing review seam:
`dashboard*.mjs`, `*http*`, `*collector*`. When any changed file matches, the
review must carry `perf: <measurement>` or `perf: n/a — <reason>`.
Docs-only diffs are unaffected.

## T3 (R03) lane cost — owner @fixer
`loadSoftBudgets(root, tier)` gains `maxCostUsd` (global or `tiers[tier]`).
`buildMetricRecord(st)` gains `costUsd` and `costBudgetUsd`.
`status` / `check-budget` print `cost spent/limit` and mark `unverified` when
tariffs are unavailable. Never converts cost into a test-skipping permission.

## T4 (R05) cross-model — owner @fixer
`review-run --role oracle --cross-model '<provider/model>'`.
Second pass uses the admitted transport only; without flag or provider the mode
is inactive. Verdict comparison: equal → single verdict; different → escalate
with both verdicts recorded.

## Shared contracts
- Prompt-surface edits need explicit user approval (C6) — parent will confirm.
- Zones above are exclusive per task; shared files are sequenced, not parallel.
