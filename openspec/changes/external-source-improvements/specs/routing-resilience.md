# routing-resilience spec

## Triage
- `suggestTier({ files, task })` returns `{ tier, rationale }`.
- Rationale names the measured signals: file count, directory spread, keywords.

## Behavioral evals
- Eval cases are declarative `{ id, input, expect }` records.
- `runEvals(cases, subject)` returns per-case `{ id, pass, detail }`; exit nonzero
  when any case fails.

## Fallback and budget
- `withFallback([toolA, toolB], args)` tries tools in order, returns the first
  success, logs the order; throws when all fail.
- Token budget: `checkBudget({ used, limit })` returns `ok | compact | refuse`;
  `compact` fires before `refuse` so consumers can shrink context first.
