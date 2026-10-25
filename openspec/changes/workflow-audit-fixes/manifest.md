# Requirements — workflow audit fixes

User: «Поищи проблемы в нашем воркфлоу» → затем «Все по очереди» (fix every finding, in order).

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Rename cannot launder a COCO ceiling | `baseline` carries an unmatched entry forward and reports it; `--prune` drops it explicitly. Mutation: removing the carry fails the test | done |
| R02 | A check that decides nothing is not a pass | `executeCheck` returns `UNVERIFIED` for `{}`/`{ok: undefined}`; `verify.mjs` counts it red and exits 1. Mutation: old default fails 2/4 cases | done |
| R03 | Worktree sprawl visible and removable | `tools/worktree-doctor.mjs` lists branch/dirt/age/merge; `--prune` removes only merged+clean; main and dirty always refused. Mutation: marking all prunable fails 2/5 | done |
| R04 | Quality gate works at any tree size | File list batched (no `ENAMETOOLONG` at 226 files); `bench/runs`, `_archive`, `migration-backup` excluded | done |
| R05 | Main checkout on master | Checkout moved from `feat/refactor-w4`@`d8ccafb` to `master`@`35acc94`; sibling uncommitted work preserved in a stash, not discarded | done |

## Findings reported but not fixed (recorded, out of this batch)

- `prompt-lint` baseline drift (33 CHANGED surfaces) is machine-local: `.prompt-lint/` is
  gitignored, so it cannot be committed and is not a repo defect.
- `.workflow/metrics.jsonl` and `events.jsonl` grow without rotation (86 and 375 lines today).
  Not yet a problem; no consumer reads them whole.
- 735 tracked files also match `.gitignore` patterns (all under `skills/**/references/`).
  Tracked files win over ignore rules, so nothing is lost today; a future `git add -A` after
  a clean would still keep them. Left alone: changing ignore rules could hide real files.
- `verify --profile verify` still reports 5 failures on this machine (missing node 20,
  uninstalled skills, prompt drift). All are install-state, not code.

## Non-goals

- No threshold change, no baseline re-seed, no change to what counts as an offender.
- No worktree is removed without its branch merged and its directory clean.
- No new runtime dependency.
