# Proposal — close audit gaps without another mandatory intake step

The previous audit reproduced cases where synchronization can write through a junction, review gates can overlook a rejection, guarded automation can skip its limits, verification can check the wrong home, and the dashboard can expose or unnecessarily load local data. The installed suite is green because these boundaries were not exercised.

Repair the existing sync, workflow, verifier and dashboard paths. Preserve their ordinary CLI and HTTP behavior, add one focused regression per broken boundary, and remove the exact duplicate nested CRO skill entry. Review the linked `intent.md` video against our existing Wave 0, verbatim manifest and OpenSpec flow; propose optional intake for asynchronous ideas only if it removes a real handoff, rather than inserting another mandatory artifact into every task.

No new runtime dependency, framework, or parallel alternative workflow is needed. Delivery requires isolated worktree slices, executed boundary checks, full regression verification and blind acceptance before a PR.
