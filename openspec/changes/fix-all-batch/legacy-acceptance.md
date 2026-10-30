# Acceptance basis (no native review-evidence run)

One verified block remains (checked, not assumed):

1. **No model-spending credential.** `NULLFORM_GATEWAY_API_KEY` and
   `OPENAI_API_KEY` both absent (`env` grep 0 matches), so no
   `review-run` dispatch is possible from this tree.

The second historical block is **fixed by this change**: R05 compacted
`.git/nullform-review-budget.json` from 1.58MB to 346B (below the 1MiB
bound), and `review-run --dry-run` passes admission.

## What this change does provide, all executed on this tree

- `oracle.md` — blind ACCEPT: R01–R08 proven with receipts.
- Executed acceptance, quoted raw:
  - `node --test review-budget + task-claim + u-quality` → `tests 99 / pass 99 / fail 0`
  - `pytest test_session_cost.py` → `15 passed`
  - python COCO (pylint 4.1.3 venv): `pass (42 functions), ratchet clean`
  - node COCO: `pass (231 functions)`; code-size PASS; clone PASS; eslint exit 0
  - `review-run --dry-run` → ok:true, no ledger-refuse
  - `openspec validate fix-all-batch --strict` → valid
  - M2: win-24 certify cell success on rerun; CI job-log endpoint verified

## What would retire this marker

A model-spending credential, then `review-run` for this change.
Operator action; not available here.
