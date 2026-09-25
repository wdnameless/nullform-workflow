# Interfaces — post-remediation audit

The audit identified defects; this change also implements their fixes. No new public
module signatures were introduced. The command-line contracts below are retained.

## Module boundaries audited

| Module | Owner today | Audit outcome |
|---|---|---|
| `tools/sync.mjs` | fixer (SyncUnify wrote it) | 6 defects confirmed (S1–S6), of which S1 is blocking |
| `tools/code-size.mjs` | fixer (SizeGate wrote it) | 3 defects confirmed (C1–C3) |
| `tools/workflow.mjs` | author (Phase 1) | 1 defect (E1), partially upheld |
| `tools/sync-prune.mjs` | author (Phase 5) | 1 defect (E2) |
| `agent/agents/orchestrator.md` | author | 1 defect (E3), a prompt drift |
| `agent/agents/oracle.md` | author | 1 defect (E4), a phantom command |

## Module contracts after the fix

| Module | Owned behavior | Stable consumer contract |
|---|---|---|
| `tools/sync.mjs` | preflight all promote candidates, read manifest, deploy, prune, OMP law parity | `--promote/--deploy/--check/--json/--repo`; exit 2 on invalid root or refused promote, JSON alone on stdout |
| `tools/code-size.mjs` | measure source and maintain deterministic baseline | `check/baseline/scan` and `scanFunctions`; exit 1 for violations |
| `tools/workflow.mjs` | workflow state and dashboard start | `start` prints a dashboard URL only after `dashboard.mjs --ensure` confirms HTTP health |
| `tools/sync-prune.mjs` | candidate discovery and guarded deletion | host-owned configuration excluded only under `agent/` |
| `tools/doctor.mjs` | installation health | requires the sync engine, manifest and size gate alongside the shims |

The caller does not import another tool: `workflow.mjs` invokes the dashboard's existing CLI.
Prompt surfaces retain their role contracts and point to runnable commands.
