# Interfaces — ci-green-selfheal

## I01 — Historical evidence binding (owner: @fixer, zone: `tools/workflow-ci.mjs`, `tools/review/evidence.mjs`)

```js
// NEW export in tools/review/evidence.mjs
export function validateReviewEvidenceAtRevision({
  root,          // project root
  changeId,
  tier,
  baseRef,       // merge-base of the push range
  revision,      // git rev: the commit that last touched this change dir
}): { ok: boolean, errors: string[] }
```

Invariant: evidence is validated against the tree **as of `revision`**, never
against the working tree. Current-tree validation stays the default for PR
gates (`validateReviewEvidence` unchanged).

Rationale: a later commit cannot retroactively invalidate an acceptance that
was true when it was recorded. Re-validating history against HEAD is what makes
push permanently red.

## I02 — `nullform setup` (owner: @fixer, zone: `bin/nullform.mjs`, `tools/install-harness.mjs`)

```
nullform setup [--harness <name>] [--yes] [--dry-run] [--json]
               [--root <dir>] [--project-root <dir>] [--user-home <dir>]
```

Contract:
- Prints a **plan**: detected harnesses with per-candidate reasons
  (`home`, `command-in-path`, `project-marker`, `saved-state`), chosen target,
  and the exact files/config blocks to be written.
- Requires confirmation before any write; `--yes` skips the prompt but the plan
  is still printed (so an agent's transcript contains it).
- `--dry-run` prints the plan and exits 0 without writes.
- Exit codes: `0` ok/already-installed, `1` cancelled or failed, `2` invalid
  usage (e.g. ambiguous without `--harness` and not `--yes`).
- `--json` emits `{ ok, detected[], chosen, plan{actions[]}, install{...} }`.
- Never writes outside installation root / project root / user home adapters.

## I03 — `nullform heal` (owner: @fixer, zone: `tools/heal.mjs` (new), `bin/nullform.mjs`)

```
nullform heal [--dry-run] [--json] [--root <dir>] [--max-attempts <n>]
```

Contract:
- Runs `runDoctor`; if `fail == 0` exits 0 with `noop: true`.
- Otherwise applies **only** minimal, idempotent repairs, in order:
  1. re-apply the saved installation (adapter re-write from saved state),
  2. restore missing/corrupt managed files from installation journal/backups,
  3. re-run doctor.
- `--dry-run` lists the repairs without executing.
- Never deletes user files; never touches files outside the installation root,
  saved `hostHome`, or `projectRoot` adapter paths.
- Returns `{ ok, before{fail,warn}, actions[], after{fail,warn} }`.
- Fail-closed: if a repair needs a destructive step not in the allow-list, stop
  and report rather than improvise.

## I04 — Dashboard guarantee (owner: @fixer, zone: `tools/dashboard.mjs`, `tools/workflow.mjs`)

`workflow start` guarantees one of:
- `dashboard: { url, live: true }` — liveness-probed URL, or
- `dashboard: { live: false, reason }` — explicit degradation with a printed
  warning naming the reason (port range exhausted, spawn failure, probe timeout).

Silent failure is a defect. `--no-dashboard`/`NF_NO_DASHBOARD=1` still skip it.

## I05 — Hanging test (owner: @fixer, zone: `tools/tests/adaptive-harness-cli.test.mjs` + its subject)

Root-cause the >120 s hang (likely an unref'd child or an interactive prompt in
a non-TTY path), then make the file finish deterministically. No `--test-timeout`
band-aid as the sole fix.

## Zones (disjoint, one writer each)

| Zone | Files | Owner |
| --- | --- | --- |
| Z1 evidence | `tools/workflow-ci.mjs`, `tools/review/evidence.mjs`, its tests | @fixer A |
| Z2 setup+heal | `bin/nullform.mjs`, `tools/install-harness.mjs`, `tools/heal.mjs`, README/SETUP | @fixer B |
| Z3 dashboard | `tools/dashboard.mjs`, `tools/workflow.mjs`, dashboard tests | @fixer C (after Z1 touches workflow-ci only) |
| Z4 hang | `tools/tests/adaptive-harness-cli.test.mjs` | @fixer D |

`tools/workflow.mjs` is owned by Z3 only; Z1 must not touch it.
