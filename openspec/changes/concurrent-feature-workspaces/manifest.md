# Requirements manifest — concurrent feature workspaces

| ID | Verbatim user quote | Observable requirement | Status |
|---|---|---|---|
| R01 | «я работаю разными агентами в одном и том же реп и пилю разные фишки, и они конфликтуют друг с другом, затирают изменения друг друга» | Feature writers receive separate Git working directories and indexes. Allocation preserves existing dirty files, staged entries and other workflow state. | in-spec |
| R02 | «чтобы можно было в одном репозитории, в одной ветке делать много фич разными агентами, и оно не конфликтовало» | Multiple features converge on one integration branch through one serialized integration operation. Conflicting edits stop visibly; no silent overwrite or promise that semantic conflicts disappear. No shared-physical-checkout write-safety claim. | in-spec |
| R03 | «Если так работает, давай что-то с этим придумаем» | Provide a Node-native installed CLI control surface and update project-owned dispatch instructions; the screenshot's stash-file restoration is classified as destructive rather than harmless preservation. | in-spec |

## Interpretation and limits

One repository and one final branch are preserved. Writers use detached feature worktrees; a single branch cannot be safely checked out for concurrent writers in independent worktrees. Raw shell/filesystem access outside the managed CLI is not a cross-harness sandbox. Native Git three-way integration can detect textual conflicts but cannot certify semantic compatibility; integrated checks remain required.

## Existing evidence

User screenshot reports `git checkout stash@{0} -- src/App.tsx` replaced the whole file, losing both feature edits. Current workflow.mjs serializes one .workflow/state.json but does not allocate writer worktrees. The OMP delete guard does not classify stash/checkout/restore and skips headless commands. Existing user dirty manifest/transcript and staged recovery/paging edits remain out of scope.
