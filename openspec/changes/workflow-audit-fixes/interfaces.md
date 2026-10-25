# Interfaces — workflow audit fixes

## Public signatures

- `mergeBaselineEntries(previous, rows, { prune }) -> { functions, lowered, orphans, pruned }` — tools/quality.mjs
- `batchArgv(argv, files, limit) -> string[][]` — tools/quality.mjs
- `classifyResult(res) -> { status, detail }` — tools/verify-shared.mjs
- `auditWorktrees(root, { base }) -> { ok, entries, stale, total }` — tools/worktree-doctor.mjs
- `pruneWorktrees(root, { base, dryRun, audit }) -> { removed, refused }` — tools/worktree-doctor.mjs
- `reportResults(results, opts, ctx) -> exitCode` — tools/verify.mjs (internal)

## Ownership

- `tools/quality.mjs`, `tools/verify-shared.mjs`, `tools/verify.mjs`: shared, changed in place, no exported symbol removed.
- `tools/worktree-doctor.mjs`: new file, sole owner this change.
- `tools/sync-manifest.json`: one entry appended.

## Invariants

1. `baseline` never raises a recorded value and never silently drops one.
2. `UNVERIFIED` is always red; `PASS` requires an explicit verdict.
3. `--prune` never removes a worktree with local work or an unmerged branch.
4. The gate never grades a directory, only an explicit file list.
