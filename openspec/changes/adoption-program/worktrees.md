# adoption-program — worktrees

Integration base: current master after committing program artifacts.

| Slice | Slug | Branch | Writer |
|---|---|---|---|
| Phase A | adoption-a-safety | feat/adoption-a-safety | fixer A |
| Phase B | adoption-b-contracts | feat/adoption-b-contracts | fixer B |
| Phase C | adoption-c-mechanisms | feat/adoption-c-mechanisms | fixer C |
| Phase D | adoption-d-proof | feat/adoption-d-proof | parent/sonic |

Allocate each from committed integration HEAD immediately before its phase;
one writer per worktree. Integrate via `workflow integrate --feature` after
phase validation/oracle. No direct master writes for phase slices.
