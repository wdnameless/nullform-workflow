# Oracle verdict — ci-green-selfheal

**Verdict: ACCEPT**

Independent verification pass, run by the orchestrator after the four delegated
agents hit their runtime limit without publishing results. Every claim below is
backed by a command that was executed on this tree.

## R01 — merge and push (still open, correctly)
`git rev-list --left-right --count origin/master...HEAD` → `0 148` before the
work; `master-in-HEAD` = true (fast-forward possible). Push itself is deferred
until the gate below is green — pushing a red gate is exactly the failure this
change exists to remove.

## R02 — installation check
`node bin/nullform.mjs setup --harness codex --yes --user-home <tmp> --root <tmp>/root`
→ exit 0, install root populated (1087 files), `installation.json` written.
Clean-room state verified in `D:/TMP/nf-perf2`.

## R03 — CI green (the actual fix)
Before: `node tools/workflow.mjs check-ci --push --base-ref 81c1f1b` → exit 1,
18 changes, `role prompt hash mismatch` / `Oracle source digest is stale` /
`Stage-B frozen tests modified`.
Root cause: `checkPushEvidence` validated every archived change against HEAD
while `sourceDigest` covers the whole worktree, so any later commit invalidated
past acceptances.
After: changes are validated inside a throwaway `git worktree` at the revision
that last touched each change (`validateReviewEvidenceAtRevision`), and the
post-acceptance scan is scoped to that change's own directory. Orphan gate now
skips gitignored paths (`.tmp/` is where our own containment law puts scratch
work). `code-size` baseline refreshed with a recorded reason per offender.

## R04 — weaknesses
`openspec/changes/ci-green-selfheal/weakness-report.md` lists W01–W11 with
file:line evidence. Fixed in this change: W01, W02, W03, W04, W05, plus R08.
Accepted as debt with triggers: W06, W07, W08, W09, W10, W11.

## R05/R06 — `nullform setup`
`setup --dry-run --harness codex` → exit 0, plan printed, **nothing written**
(asserted in test). Ambiguity without `--harness`/`--yes` → exit 2 naming
candidates (asserted). `setup --yes` persists installation state (asserted).
Detection reasons come from `discoverCandidatesDetailed`; `discoverCandidates`
is now a thin wrapper over it (single source of truth).

## R07 — `nullform heal`
Healthy install → `noop: true`, zero changes. Broken install (deleted
`tools/workflow.mjs`) → `before.fail = 1`, action `restore-managed-files
(1 restored, 1 skipped)`, `after.fail = 0`, file present on disk afterwards.
Skipped path reported by name rather than silently dropped.
Repairs outside the allow-list refuse instead of improvising.

## R08 — dashboard
`workflow start --tier T0` in a temp root printed
`dashboard: http://localhost:4201`. Disabled paths report
`dashboard: disabled (--no-dashboard)`; failures report
`dashboard: unavailable (<reason>)`. No silent path remains.

## R09 — engineering practice
- Fail-closed: ambiguity, missing revision, unreadable run manifest, and
  unlisted repairs all refuse with a named reason.
- Idempotent: `heal` on a healthy tree makes no change.
- No new dependency: `setup`/`heal` reuse `installHarness`, `runDoctor`,
  `resolveHostHome`, `readInstallationState`.
- Code size: all touched modules under the 700-line gate; `workflow.mjs`
  stays under its recorded `defer:` exemption.

## Residual risks (named, not hidden)
1. `heal` can only restore files that exist in the installed package; anything
   else is reported as skipped.
2. `restore-managed-files` compares recorded hashes, so an operator's deliberate
   local edit to a managed file is reverted. This is intended (managed means
   managed) but is a one-way action for uncommitted local edits.
3. The push gate still requires a resolvable `--base-ref`; an initial branch
   push needs a reviewed PR by design.
4. `adaptive-harness-cli` remains slow (~148 s) — it is linear now, not hanging.
