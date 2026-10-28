# Acceptance basis (no native review-evidence run)

Same two verified blocks as workflow-growth-batch (checked again, not assumed):

1. **No model-spending credential.** `NULLFORM_GATEWAY_API_KEY` and
   `OPENAI_API_KEY` both absent (`env` grep 0 matches).
2. **Review ledger over bound.** `.git/nullform-review-budget.json` is
   1586483 bytes vs `MAX_LEDGER_BYTES = 1 MiB`. Pre-existing condition.

## What this change does provide, all executed on this tree

- `oracle.md` — blind ACCEPT: R01–R06 proven with receipts.
- Executed acceptance, quoted raw:
  - `node --test init-wizard + changed-scope + coverage-changed + nullform-cli` → `tests 37 / pass 37 / fail 0`
  - foreign-tree gates: mutation 1/1, coverage 1/1, clone PASS (1 file), code-size via quality CLI PASS
  - `nullform init --dry-run` codex/hermes/openhuman: harness-native roots, no install-path OMP refs
  - `node tools/quality.mjs check` → `node pass (231 functions)`
  - code-size PASS (4 exempt), clone PASS, eslint exit 0
  - `openspec validate universal-slices-wizard --strict` → valid

## What would retire this marker

Ledger compaction below 1 MiB + credential, then `review-run` for this
change. Both operator actions; neither available here.
