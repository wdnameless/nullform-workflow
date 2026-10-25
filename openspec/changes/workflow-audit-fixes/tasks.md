# Tasks — workflow audit fixes

- [x] 1.1 Reproduce the rename hole: baseline entry vanishes after rename
- [x] 1.2 Carry unmatched baseline entries forward; add --prune; mutation-prove the guard
- [x] 2.1 Reproduce executeCheck defaulting to PASS for {} and {ok: undefined}
- [x] 2.2 Default to UNVERIFIED; count it as red in verify.mjs; mutation-prove
- [x] 3.1 Audit 23 worktrees: 21 dirty, 185 uncommitted files, 566 MB, nothing reported
- [x] 3.2 Implement tools/worktree-doctor.mjs with --prune and --dry-run; mutation-prove dirty refusal
- [x] 4.1 Reproduce ENAMETOOLONG on the full checkout (226 files)
- [x] 4.2 Batch the file list; exclude bench/runs archived repo copies (2646 findings)
- [x] 4.3 Decompose the four functions my own gate flagged instead of re-seeding
- [x] 5.1 Verify merged tree: quality clean (237), lint 0, code-size PASS, worktree-doctor prunes 3
