# Workflow audit fixes

## Why

Four defects found by auditing this repository's own gates against a full checkout rather
than a small worktree. Each was measured, not inferred:

1. **The COP ratchet could be laundered by a rename.** `applyRatchet` keys on
   `file:function`, so renaming a function stops it matching its baseline entry. `check`
   reported the rename correctly as growth, but `baseline` rebuilt its map from current rows
   only and silently dropped the old entry — rename + `baseline` erased a ceiling and
   re-recorded today's number. Reproduced: baseline `a.mjs:f=40`, rename to `g` → the entry
   vanished. On this repo the new report immediately named **3** such orphaned entries left
   by earlier renames.
2. **`executeCheck` defaulted to PASS.** `status = res.ok === false ? "FAIL" : (res.status ||
   "PASS")` made `{}` and `{ok: undefined}` count as a pass, and the reporter counted only
   `FAIL` toward failure, so an `UNVERIFIED` row vanished from the tally while the run still
   exited 0. A verification runner whose default is success verifies nothing.
3. **Nothing reported worktree sprawl.** 23 worktrees, 21 dirty, 185 uncommitted files,
   566 MB — and `git branch -d` refuses while a merged branch is checked out, so dead
   branches accumulate silently.
4. **The quality gate broke at tree scale.** `{files...}` expanded to all 226 sources in one
   argv, exceeding the Windows command-line limit (`ENAMETOOLONG`), and on a machine that had
   run benchmarks it graded `bench/runs/<run>/repo/` copies (**2646** findings from archived
   code nobody can act on).

## What changes

- `mergeBaselineEntries` carries an unmatched baseline entry forward and reports it;
  `baseline --prune` is the explicit way to drop one.
- `classifyResult` makes `UNVERIFIED` the default; `verify.mjs` counts it as red and exits 1.
- `tools/worktree-doctor.mjs`: audits every worktree with branch, dirt, age, merge state;
  `--prune` acts only on merged-and-clean ones; `--dry-run` previews.
- `batchArgv` splits the file list to fit the platform command line; `runs`, `_archive` and
  `migration-backup` join the exclusion list.

## Validation

- Rename guard proven by mutation: removing the orphan carry makes the test fail, restoring
  it passes.
- `executeCheck` proven by mutation: restoring the old default fails 2 of 4 cases.
- Dirty-worktree refusal proven by mutation: marking everything prunable fails 2 of 5.
- The gate caught this change's own code four times (`worktree-doctor` 18/23,
  `executeCheck` 16, `verify main` 18) and each was decomposed, not re-seeded.
- On the merged tree: `quality check` → 237 functions, clean; `lint` 0; `code-size` PASS;
  `worktree-doctor` found and pruned the three clean merged worktrees from this session and
  refused the 21 dirty ones.

## Scope

No change to the COCO thresholds, to what counts as an offender, or to any existing
baseline value. No new runtime dependency. No worktree is removed without its branch being
merged and its directory clean.
