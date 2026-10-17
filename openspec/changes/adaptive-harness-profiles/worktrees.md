# Worktrees — adaptive-harness-profiles

Isolated git worktrees used for this change (all under .tmp/worktrees/, project-contained):

| Worktree | Branch | Purpose |
|---|---|---|
| .tmp/worktrees/review | feat/adaptive-harness-integration → feat/task-claim-context | Parent integration, verification, review evidence |
| .tmp/worktrees/adaptive-profile-core | feat/adaptive-profile-core (removed after integration) | ProfileCore: harness-profiles.mjs, manifest validation |
| .tmp/worktrees/adaptive-profile-install | feat/adaptive-profile-install (removed after integration) | InstallerOwner: CLI, adapters, journal, state |
| .tmp/worktrees/adaptive-profile-evidence | feat/adaptive-profile-evidence (removed after integration) | EvidenceOwner: docs, consumer CLI regressions |

Worker worktrees were removed after their deltas were integrated into the review worktree
(commits ceb0b35, 1c43180) and verified by the parent. No worker wrote outside its root.
