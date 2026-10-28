# Acceptance basis (no native review-evidence run)

This change cannot carry `review-evidence.json`. Two independent blocks in this
environment, both verified by running the tool, not assumed:

1. **No model-spending credential.** `review-run` requires an admitted route;
   `NULLFORM_GATEWAY_API_KEY` and `OPENAI_API_KEY` are both absent from the
   environment (`env` grep returns 0 matches).
2. **The repo's own review ledger is over its documented bound.** Even with a
   credential, the controlled transport refuses before parsing: `.git/nullform-review-budget.json`
   is 1586483 bytes against `MAX_LEDGER_BYTES = 1 MiB` (`tools/review/budget.mjs:249`).
   Pre-existing repository condition (dated Oct 24, before this change), not a
   property of this change; it blocks every T2/T3 acceptance in this clone until
   the ledger is compacted or archived.

A native record describes an actual execution and cannot be synthesised. Writing one
here would be exactly the dishonesty the gate exists to prevent, so this file states
the exemption explicitly instead.

## What this change does provide, all executed on this tree

- `oracle.md` — blind ACCEPT: R01–R08 proven with command receipts, R09 partial
  (final user answer, parent-owned).
- Executed acceptance, quoted raw:
  - `node --test lead-time + cfr-report + coverage-changed + changed-scope + sync-manifest-coverage` → `tests 33 / pass 33 / fail 0`
  - `node tools/mutation-changed.mjs --base master` → `Passed files: 5/5` (90/80/100/90/100%)
  - `node tools/coverage-changed.mjs --base master` → `Passed files: 5/5` (63/88/55/95% + 1 n/a)
  - `node tools/code-size.mjs check` → `PASS (3 exempt), 281 files`
  - `node tools/clone-coverage.mjs check` → `PASS (1 exempt)`
  - `npm run lint` → exit 0
  - `npm audit --audit-level=high` → `found 0 vulnerabilities`
  - `openspec validate workflow-growth-batch --strict` → valid
  - live `workflow start` → `dashboard: http://localhost:4203`, http 200

## What would retire this marker

Compacting `.git/nullform-review-budget.json` below 1 MiB (or supplying the documented
archive) **and** providing a credential, then running `review-run` for this change. Both
are operator actions; neither was available here.
