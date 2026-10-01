# Isolated implementation worktrees

One `task()` batch spawned three writers with `isolated:true` from the Git feature branch `feat/jev-automatic-assistance` after G2 reviews. Temporary worktree paths are tool-managed and not invented here; returned patch artifacts and applied scopes will be reconciled before acceptance.

| Job | Exclusive ownership | Requirements |
|---|---|---|
| CoreRuntimeJev | tools/jev-assist.mjs, tools/tests/jev-assist.test.mjs | R01,R03,R04,R06,R07 |
| NativeJevIntegration | native extension, Node/PowerShell installers, sync manifest, .gitignore, extension/install tests | R01,R02,R04,R07,R08 |
| JevBenefitEvaluation | evaluator/control CLI, calibration/heldout/outcome fixtures, evaluation tests, docs/README/env example/glossary | R05,R06 |

Parent owns only OpenSpec/evidence/integration/git/baseline and real live credential/API execution. User-provided jev/ is reference-only and never included by blanket staging. No credential has been passed to any writer. Tests/build/lint/format execute at parent integration after writers finish.
