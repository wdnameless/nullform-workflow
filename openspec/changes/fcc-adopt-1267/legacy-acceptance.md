# Acceptance basis (no native review-evidence run)

Same two verified blocks (checked again, not assumed):

1. **No model-spending credential.** `NULLFORM_GATEWAY_API_KEY` and
   `OPENAI_API_KEY` both absent (`env` grep 0 matches).
2. **Review ledger over bound.** `.git/nullform-review-budget.json` is
   1586483 bytes vs `MAX_LEDGER_BYTES = 1 MiB`. Pre-existing condition.

## What this change does provide, all executed on this tree

- `oracle.md` — blind ACCEPT round 2: R01 activation gap from round 1
  closed (matrix+probe+live activated:true, 10/10), R02–R04 proven.
- Executed acceptance, quoted raw:
  - `node --test harness-probe + init-wizard + nullform-cli` → `tests 27 / pass 27 / fail 0`
  - `nullform doctor --report` → valid JSON, 8 probes (hermes 0.22.5 activated:true), 0 secret refs
  - `node tools/quality.mjs check` → `node pass (231 functions)`
  - code-size PASS (4 exempt), clone PASS, eslint exit 0
  - `openspec validate fcc-adopt-1267 --strict` → valid

## What would retire this marker

Ledger compaction below 1 MiB + credential, then `review-run` for this
change. Both operator actions; neither available here.
