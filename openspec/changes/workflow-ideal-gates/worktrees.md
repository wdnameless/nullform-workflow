# Isolated worktree evidence

Wave 3 launched as ONE `task()` batch from branch `fix/workflow-ideal-gates`; all three writers spawned with `isolated: true` (separate temp Git worktrees, patches applied back). Exact temp paths tool-managed; ownership disjoint.

| Job | Exclusive paths | Requirements |
|---|---|---|
| `PruneContainFix` | `tools/sync-prune.mjs`, `tools/sync.mjs`, `tools/tests/sync-prune.test.mjs`, `tools/tests/sync.test.mjs` | R01–R02 |
| `GateIntegrityFix` | `tools/workflow.mjs`, `tools/tests/workflow-gate.test.mjs`, `tools/tests/workflow-suggest.test.mjs` | R03–R05, R07 |
| `InstallGuardFix` | `install.ps1`, installer guard test (existing portability suite or new) | R06 |

Parent owns OpenSpec, integration, git; `backups/` untouched.
