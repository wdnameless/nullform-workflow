# Contained implementation worktrees

All paths are inside D:/ohmypi/workflow-repo; initial base fbcead6e7ff5279e0b73b53156602e93a20aee61. No implementation checkout or backup was created outside the project by these contained writers.

| Owner | Git worktree | Branch | Exclusive scope |
|---|---|---|---|
| RuntimeContained | .tmp/worktrees/runtime | feat/portable-runtime | Public CLI, installer/state/recovery/update/doctor/capabilities, generated adapter instructions and runtime regressions |
| CertificationContained | .tmp/worktrees/certification | feat/portable-certification | npm metadata/archive/smoke/certification/publication, hosted workflows/templates and related package/shell regressions |
| EvidenceContained | .tmp/worktrees/evidence | feat/portable-evidence | Historical evidence validation/summary, replay provenance, README/CONTEXT/benchmark documentation and upstream license notice |
| RuntimeCommit | .tmp/worktrees/transaction-commit | fix/transaction-commit | Durable identity/commit/recovery journal and real filesystem-fault/parent-SIGKILL regressions; base2449bf8 |
| OutputPages | .tmp/worktrees/acceptance-pages | fix/acceptance-pages | Native product-output paging, complete execution packet and corresponding integrity regressions; base2449bf8 |
| WorkspaceOwner | .tmp/worktrees/workspace-control | detached a5bf423 | Git-backed feature workspace allocation/integration, existing dispatcher/help/doctor and behavioral regressions |
| GuardOwner | .tmp/worktrees/checkout-guard | detached a5bf423 | Existing destructive guard, project dispatch guidance, documentation and sync/legacy PowerShell delivery parity |

Parent integrates only reported owned paths into feat/portable-release-integration. User-owned openspec/changes/eval-metrics/manifest.md and context/product/video-agent-evals.srt are excluded. Source is frozen during verification; contained writers do not run builds/lint/tests/formatters mid-flight.

The detached .tmp/worktrees/review worktree is reserved for the committed integrated source, clean-tree package certification, native implementation review and frozen Stage-B evidence. Clean review isolation does not exclude user files from hashing in their original checkout or fabricate acceptance receipts.
