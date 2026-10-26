# Acceptance basis (no native review-evidence run)

This change cannot carry `review-evidence.json`. Two independent blocks in this
environment, both verified by running the tool, not assumed:

1. **No model-spending credential.** `review-run` requires an admitted route;
   `NULLFORM_GATEWAY_API_KEY` is absent from the environment and `OPENAI_API_KEY`
   is absent (`env` greps return 0 matches for both).
2. **The repo's own review ledger is over its documented bound.** Even with a
   credential, the controlled transport refuses before parsing:

   ```
   node tools/workflow.mjs review-run --change arch-drilldown-sketch \
     --role reviewer --model nullform-gateway/gemini-3.8-flash-high \
     --base-ref HEAD --admission-policy .tmp/probe-policy.json --dry-run
   → Budget ledger '...\.git\nullform-review-budget.json' is 1586483 bytes,
     exceeding the 1048576-byte bound; refusing to parse
   ```

   `.git/nullform-review-budget.json` holds 3321 reservations in 1 586 483 bytes
   against `MAX_LEDGER_BYTES = 1 MiB` (`tools/review/budget.mjs:249`). That is a
   pre-existing repository condition, not a property of this change; it blocks every
   T2/T3 acceptance in this clone until the ledger is compacted or archived.

A native record describes an actual execution and cannot be synthesised. Writing one
here would be exactly the dishonesty the gate exists to prevent, so this file states
the exemption explicitly instead.

## What this change does provide, all executed on this tree

- `oracle.md` — a blind verdict against the manifest's verbatim quotes with each R##
  mapped to what was observed, plus three named residual risks.
- Executed acceptance, quoted raw:
  - `node --test tools/tests/dashboard-sketch.test.mjs` → `tests 13 / pass 13 / fail 0`
  - `node --test tools/tests/dashboard.test.mjs` → `tests 53 / pass 53 / fail 0`
  - `node tools/code-size.mjs check` → `PASS — нарушений нет (3 exempt). Проверено 264 файлов, 1793 функций.`
  - `node tools/quality.mjs check` → 4 violations, all in files this change does not
    touch (`trajectoryOf`, `runReviewRecord`, `validateOpenspecArtifact`,
    `validatePlanCoverage`).
  - Browser smoke on the live dashboard: project (11 boxes) → `tools` (13, 12 file
    nodes) → `dashboard.mjs` (41, symbol nodes) → `Esc` ×2 back to project, modal
    untouched, `0` page errors.
  - `curl /api/arch.excalidraw?module=tools&file=tools%2Fdashboard.mjs` → `HTTP 200`,
    `Content-Disposition: attachment`, envelope with 62 elements, 0 missing core
    fields, 0 orphan text, 0 duplicate ids, every text container-bound, no `label:`
    shorthand.

## What would retire this marker

Compacting `.git/nullform-review-budget.json` below 1 MiB (or supplying the documented
archive) **and** providing a credential, then running `review-run` for this change. Both
are operator actions; neither was available here.
