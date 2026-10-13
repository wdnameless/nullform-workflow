# Isolated implementation worktrees

This slice is part of the T3 portable-product-release integration PR. Both writers used separate real Git worktrees under the project root, with independent indexes and an explicit parent integration owner; initial committed base a5bf423.

| Owner | Worktree | HEAD at dispatch | Exclusive scope |
|---|---|---|---|
| WorkspaceOwner | .tmp/worktrees/workspace-control | detached a5bf423 | workflow-workspaces.mjs, workflow dispatcher/help/doctor inventory and real Git regressions |
| GuardOwner | .tmp/worktrees/checkout-guard | detached a5bf423 | Existing destructive guard, project guidance, README/CONTEXT, sync/legacy delivery, related tests and retained MIT attribution |

The parent integrated only reported owned file deltas into feat/portable-release-integration. The user's unrelated eval-metrics manifest and video transcript were never included. Actual public-CLI and installed-candidate scenarios verified independent indexes, preserved human staged/unstaged state, clean-target refusal, two committed feature merges and retained native conflicts. This record describes real local isolation; CI does not assume these workstation paths exist on its runner. Native current-source review/acceptance remains a separate requirement, not established by this file.
