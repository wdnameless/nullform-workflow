# Acceptance basis (no native review-evidence run)

One verified block (checked, not assumed):

1. **No model-spending credential.** `NULLFORM_GATEWAY_API_KEY` and
   `OPENAI_API_KEY` both absent (`env` grep 0 matches, 2026-11-05), so no
   `review-run` dispatch is possible from this tree. Per B3 norm
   (PORTABLE §5): blind-oracle-only is the standard for T2/T3; keyed runs
   are releases/money-paths only.

The ledger block is gone: `.git/nullform-review-budget.json` is 346 bytes
(compacted, never refilled — program spend $0.00).

## What this change does provide, all executed on this tree

- `oracle.md` — integration blind ACCEPT: R01–R06 proven with receipts.
- Slice oracles: S1/S2/S3/S4 ACCEPT, S5 DONE (evidence in slice changes).
- Executed acceptance, quoted raw:
  - `node --test tools/tests/*.test.mjs` → `pass 1434 / fail 19` (19 = known
    concurrency flaps: controlled-http ETIMEDOUT + timing; isolated green)
  - `node --test` isolated: quality/sync/usage 50/50, dashboard 86/86,
    wf-gate 48/48, staleness 16/16, install 15/15, verify-matrix 11/11
  - `node tools/quality.mjs check` → `node pass (225 functions)`
  - `node tools/code-size.mjs check` → PASS (2 exempt, 287 files, 2068 fn)
  - `openspec validate refactor-program --strict` → valid
  - live CLI: `verify --harness claude|codex|opencode` resolves;
    OUT-harness → exit 2; `bin/nullform --help` exit 0

## What would retire this marker

A model-spending credential, then `review-run` for this change.
Operator action; not available here.
