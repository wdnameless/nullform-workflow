# Isolated worktree evidence

The implementation wave was launched as ONE `task()` batch from the Git checkout on branch `fix/audit-boundaries-and-intent-review`; all three fixer writers were spawned with `isolated: true`. The tool used separate temporary Git worktrees and returned patches to the integration checkout. It auto-applied two initial patches; the corrected dashboard patch required explicit parent `git apply`. Exact temporary paths were not exposed in the result, so this file records the observed spawn configuration and disjoint ownership without inventing them.

| Isolated worktree job | Exclusive source/test ownership | Requirement |
|---|---|---|
| `SyncVerifyFix` | `tools/sync.mjs`, `tools/verify.mjs`, `tools/tests/sync.test.mjs`, `tools/tests/install-harness.test.mjs` | R01–R03 |
| `WorkflowGateFix` | `tools/workflow.mjs`, `tools/tests/workflow-gate.test.mjs`, `tools/tests/workflow-suggest.test.mjs` | R04–R05 |
| `DashboardPrivacyFix` | `tools/dashboard.mjs`, `tools/tests/dashboard.test.mjs`, exact duplicate `skills/cro/cro/SKILL.md` deletion | R06–R08 |

After initial writers completed, `SyncFixCorrection`, `GateTestCorrection`, `DashboardTestCorrection` and `AssertionCorrection` each ran with `isolated: true` on their bounded remediation scope. The later test-only assertion pass occurred after the source owners finished; no concurrent file ownership overlapped.

No writer owned OpenSpec documents, code-size baseline, git integration, user-owned `backups/`, or the optional video recommendation. Parent reconciled each returned patch and exercised the CLI/HTTP behavior before acceptance.
