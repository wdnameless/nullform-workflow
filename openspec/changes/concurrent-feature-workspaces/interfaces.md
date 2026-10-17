# Interfaces and ownership

## Public control surface

`nullform workflow workspace --feature <slug> [--root <project>]` allocates a new private detached Git worktree under the project .tmp/worktrees. Duplicate allocation refuses: existing cwd is never authorization for another writer to reuse it. Explicit handoff is outside this allocator; no automatic reuse/reset. The committed base is resolved once from the integration checkout HEAD. Return machine-readable JSON including feature identifier, absolute worktree cwd, base commit and integration branch. Feature slug is a bounded simple identifier, never a path or revision. No agent-generated shell interpolation.

`nullform workflow integrate --feature <slug> [--root <project>]` integrates committed work from that registered worktree into its recorded integration branch. It refuses wrong repository/branch, dirty integration files/index including untracked user data, dirty feature source, foreign/tampered registration and an active Git operation. A common-repository lock serializes integration; a live or uncertain owner is never reclaimed by age. Reuse native Git merge of the recorded feature HEAD. A conflict remains an explicit native Git conflict for the integrator to resolve; no auto-reset/abort/stash/ours/theirs. Preserve the feature worktree and its commits. No merge conflict is reported as success.

Workspace registration lives in each allocated worktree's .workflow data and binds repository, base, path and integration branch. Canonical path and Git common-directory checks reject junction/foreign-root escape. Concurrent requests for one slug cannot replace each other; independent slugs have independent indexes and workflow state. Reuse existing path validation and native argv execution.

## Ownership

WorkspaceOwner: minimum new workspace module; workflow.mjs dispatch, harness-capabilities.mjs help, doctor.mjs required-module inventory, corresponding workspace tests. No installation-state/review-native/evidence/deployment code, sync manifest, README/CONTEXT/role/guard edits. Whole tools-directory installation and npm wildcard already package the module; GuardOwner owns the one sync-manifest row.

GuardOwner: agent/extensions/nullform-delete-guard.ts, existing corresponding guard tests, project-owned root/orchestrator instructions and generated adapter guidance, README/CONTEXT concurrency documentation. Owns tools/sync-manifest.json for both the new workspace-module row and missing delete-guard destinations, plus legacy install.ps1 guard copy parity. No CLI/state/workspace implementation. Existing all-purpose headless permission semantics remain unchanged except identified destructive Git restoration cannot silently bypass confirmation; documented limitation: regex guards do not sandbox arbitrary shells or direct writes.

Parent owns manifest/proposal/interfaces/tasks/specs, integration Git and executed verification. Skip build/lint/tests/formatters while implementing; parent executes real before/after checks after integration. No new dependencies, baseline waivers, user-file staging or changes to personal/global prompt/configuration.
