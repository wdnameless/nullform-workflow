# Requirements — post-remediation audit

> **Recovered record.** This file was overwritten by the fix manifest (`manifest.md`) during
> the fix lane, before it was ever committed. The audit content is restored here so the two
> lanes keep their own records; `recon.md` holds the same findings in full detail.

User request (verbatim, in full):

> «Проведи полный аудит нашего воркфлоу, выдели ошибки, баги и слабые места»

This is the second audit of the same tree. The first (`harness-simplification`) closed 27
defects and merged them. This audit covers what has **changed since then** — the four commits
on master — rather than re-reading the whole tree.

## Scope (what changed since the last audit)

| File | Origin | Audit risk |
|---|---|---|
| `tools/sync.mjs` (453 lines) | subagent (SyncUnify) | **highest** — the deploy/promote/delete path, written by an agent, reviewed only at reconciliation |
| `tools/code-size.mjs` (695 lines) | subagent (SizeGate) | **high** — a CI gate; a wrong answer blocks good work or lets bad growth through |
| `tools/sync-manifest.json` | subagent | one wrong entry breaks propagation |
| `tools/workflow.mjs` (+88) | author | dashboard liveness fix, verdict gate, lane TTL |
| `tools/verify.mjs` (+96) | author | checks 4, 9b, 28; audit 5, 10 |
| `tools/sync-prune.mjs` (+77) | author | allow-list, HOST_CONFIG, RUNTIME_NAMES |
| `tools/tests/test-helpers.mjs` | subagent (DeadCodeDocs) | shared helper; 9 copies were hoisted into it |
| `tools/tests/code-size.test.mjs` | subagent (SizeGate) | the gate's own tests |

## Requirements

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Проведи полный аудит нашего воркфлоу» | Every file changed since `d9d4c7f` is read line-by-line by an independent reviewer; a claim is not evidence until the command that produced it is quoted. | done |
| R02 | «выдели ошибки, баги и слабые места» | Every finding cites file:line and a failure scenario, or is marked `[NOT CHECKED]`. Refuted claims are recorded, not dropped. | done |
| R03 | «полный аудит» | The two subagent-written modules get a sandboxed behavioural test, not only a read: check, deploy, promote, promote-newer-refusal, prune dry-run and --confirm, and the OMP law-copy parity path. | done |
| R04 | «полный аудит» | The audit must not confirm the past. It must find what is STILL wrong: the fixes hold, but new code has its own defects. | done — 13 defects confirmed, 1 refuted |

## Deferred

- Re-reading files untouched since the last audit — they were already covered; re-reading
  them is waste, not completeness.
- The 6 already-deferred items (split dashboard/doctor, skills payload, vendored typescript)
  — they were measured and recorded as non-actions; they do not need re-measuring.

## Non-actions

- Nothing was fixed in this lane — it was an audit. The defects it found are fixed in
  `manifest.md` (R30–R42), a separate lane.
