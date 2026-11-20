# Interfaces — boundaries, signatures, owners

| module | public surface | owner |
|---|---|---|
| `tools/workflow/settle.mjs` | `cmdSettle`, `confirmSettle`, `resolveSettleTargets`, `resolveSettleDocTargets`, `resolveSettleGitTargets`, `removeSettleWorktrees`, `removeSettleBranches`, `isProtectedRefName`, `getCurrentBranch`, `isRefMatchingCurrentBranch`, `getLocalBranches`, `PROTECTED_BRANCH_RE` | settle lifecycle |
| `tools/workflow-ci.mjs` | re-exports the settle surface unchanged; keeps CI gates (`cmdCheckCi`, `cmdReviewRun`, `cmdStageB`) | CI gates |
| `tools/tests/review-controlled-http.test.mjs` | fixture `gate()` — throws on probe crash; tamper test asserts the integrity error text | review tests |

Boundary that did not move: `tools/workflow.mjs` still imports the settle names from
`./workflow-ci.mjs`; tests still import them from `../workflow.mjs`.
