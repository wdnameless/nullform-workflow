# Acceptance basis (no native review-evidence run)

One verified block:

1. **No model-spending credential in this environment.** `NULLFORM_GATEWAY_API_KEY`
   and `OPENAI_API_KEY` were absent in the acceptance environment, so no
   `review-run` dispatch was possible from this tree. Blind-oracle-only per
   PORTABLE §5/B3 applies to this ordinary T3 program; keyed runs are for
   releases/money paths.

## Executed evidence on this tree

- `openspec/changes/adoption-program/oracle.md`: blind ACCEPT R01–R12.
- Focused suite: **351 pass / 0 fail**.
- Quality: `node pass (223 functions)`.
- Code-size: `PASS (294 files, 2166 functions, 4 exempt)`.
- Full suite: 1512 pass / 8 fail. Residual controlled-http ETIMEDOUT under
  load; isolated controlled-http **32/32 pass**.
- Real isolated install smoke: **1/1** across claude/codex/opencode.
- Additional spend: **$0.00**; optimizer additional ceiling **$10.00**.

## Limitations

- Python pylint unavailable locally (`No module named pylint`).
- Live model execution and live provider quality are **UNVERIFIED**, not
  simulated. Optimizer is candidate-only; no prompt changes applied.

## What would retire this marker

A model-spending credential and an admitted `review-run` for this change.
Operator action; unavailable here.
