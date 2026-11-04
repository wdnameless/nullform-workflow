# refactor-program — worktrees

Integration HEAD: b35e76d (зафиксировать перед аллокацией; общие
prerequisites коммитятся до `workspace --feature`).

| Slice | Slug | Path | Branch | Writer |
|---|---|---|---|---|
| S1 workflow-split | s1-workflow-split | .tmp/worktrees/feature-s1-workflow-split | feat/s1-workflow-split | @fixer |
| S2 dashboard-family | s2-dashboard | .tmp/worktrees/feature-s2-dashboard | feat/s2-dashboard | @fixer |
| S3 gates-coco-prune | s3-gates | .tmp/worktrees/feature-s3-gates | feat/s3-gates | @fixer |
| S4 proof-matrix | s4-matrix | .tmp/worktrees/feature-s4-matrix | feat/s4-matrix | @fixer |
| S5 behavior-deltas | s5-deltas | .tmp/worktrees/feature-s5-deltas | feat/s5-deltas | @sonic |

Allocation: `nullform workflow workspace --feature <slug>` от integration HEAD;
ровно один пишущий на worktree; повторная аллокация отказывает.
Integration: только parent через `nullform workflow integrate --feature <slug>`
на чистой ветке; конфликты — ручное разрешение, без reset/ours/theirs.
