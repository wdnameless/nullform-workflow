# Interfaces — round2-resilience

Owner per slice; zones are disjoint. Parent owns `CONTEXT.md` glossary and integration.

## Slice A — Model routing (R01/R02/R07)

- `assignChecker({ writerFamily, candidates }) → candidate | throws`
  (extend `tools/oracle-model.mjs`, reuse round1 `deriveModelFamily`).
  Same-family assignment throws naming the conflict.
- `normalizeUsage(provider, raw) → { totals, unknown: string[] }`
  (new `tools/usage-normalize.mjs`). `provider` is `anthropic|openai`;
  totals follow each provider's cache semantics; unreported fields are the
  string `UNKNOWN` in place and listed in `unknown`.
- `withBreaker(primary, { reserve, threshold, isRetryable }) → result`
  (extend `tools/fallback.mjs`). Opens after `threshold` consecutive retryable
  failures, routes to `reserve` while open, closes after a successful probe.
  `isRetryable(err)` default matches 429/503-shaped errors.
- Tests: new `tools/tests/round2-routing.test.mjs`.

## Slice B — Edit safety (R03/R05/R09)

- `assertFactForcing(target, evidence)` (extend `tools/review/gatekeeper.mjs`).
  `evidence.reads` is string[] of read paths; throws naming missing evidence
  when the target's callers/consumers (passed as `evidence.required: string[]`)
  are not all covered.
- `planDestructive(edit) → { planToken, hash }`;
  `executeDestructive(planToken, edit, apply)` (new `tools/two-phase.mjs`).
  Token binds `hash(edit)`; unknown/mismatched token refuses; `apply` runs
  only on verified plans.
- `observeTrajectory(events, { maxSteps, loopWindow }) → { loops: string[] }`
  (new `tools/trajectory.mjs`). Events are `{ tool, args }`; identical
  consecutive calls within `loopWindow` are reported; exceeding `maxSteps` throws.
- Tests: new `tools/tests/round2-safety.test.mjs`.

## Slice C — Durable evidence (R04/R08/R10)

- `freezeAssets(files) → record`; `verifyAssets(record)` (new `tools/asset-freeze.mjs`).
  Record holds `{ path, sha256 }[]` plus `masks: string[]`; verification fails
  naming the asset on hash mismatch or mask hit.
- `checkpointWave(store, wave, state)`; `resumeWave(store) → { wave, state }`
  (new `tools/checkpoints.mjs`). Store is a directory path; JSON per wave,
  atomic writes; resume returns the first incomplete wave.
- `appendReceipt(logPath, entry)`; `verifyChain(logPath)` (new `tools/capsule.mjs`).
  NDJSON lines with `{ seq, prev, hash, effect, body }`, SHA-256 chain;
  effect in SE0–SE4; verification fails at the broken position.
- Tests: new `tools/tests/round2-evidence.test.mjs`.

## Slice D — Ops visibility (R06/R11/R12)

- `writeSnapshot(dir, costs)`; `checkAlerts(state, costs) → alert[]`
  (new `tools/cost-snapshot.mjs`). Atomic single-file write (O(1) vs history);
  alerts `notice|warning|critical` fire once per tier until cleared.
- `emitHudStatus(session) → { schema, state, waits, costs }`;
  `validateHudStatus(value)` (new `tools/hud-status.mjs`).
  Schema const `hud-status.v1`; state in `working|blocked|idle`.
- `checkTripwire(diffStat, tier)`; `verifyGolden(fixture, actual)`
  (new `tools/tripwire.mjs`). Ceilings `{ T0: 200, T1: 500, T2: 2000, T3: 8000 }`
  changed lines; golden compare is byte-exact on declared fields.
- Tests: new `tools/tests/round2-ops.test.mjs`.

## Shared non-goals

No network, no paid model calls, no provider probes, no new dependencies,
no edits outside the assigned zone, no `CONTEXT.md`/openspec/`.workflow/` edits.
