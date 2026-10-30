# Acceptance basis (no native review-evidence run)

One verified block (checked, not assumed):

1. **No model-spending credential.** `NULLFORM_GATEWAY_API_KEY` and
   `OPENAI_API_KEY` both absent (`env` grep 0 matches), so no
   `review-run` dispatch is possible from this tree.

The ledger block is gone: `.git/nullform-review-budget.json` is 346 bytes
after the fix-all compaction (was 1.58MB).

## What this change does provide, all executed on this tree

- `oracle.md` — blind ACCEPT: R01–R04 proven with receipts.
- Executed acceptance, quoted raw:
  - `node --test model-router + memory-cadence + workflow-gate` → `tests 74 / pass 74 / fail 0`
  - `node tools/quality.mjs check` → `node pass (230 functions)`
  - code-size PASS (4 exempt), clone PASS, eslint exit 0
  - `openspec validate omh-model-routing --strict` → valid
  - live CLI: `--apply` without --yes refuses, file byte-identical

## What would retire this marker

A model-spending credential, then `review-run` for this change.
Operator action; not available here.
