# Interfaces — boundaries, signatures, owners

| module | public surface | owner |
|---|---|---|
| `tools/workflow-core.mjs` | `stateCorruption(root): string|null`, `refuseOnCorruptState(root): boolean`, `changeScopeProblem(root, st, kind, fullPath): string|null`, `declaresSkipSpecs(changeDir): boolean`, `load(root)` (unchanged contract) | state machine |
| `tools/workflow/artifact.mjs` | `cmdArtifact(root, flags, deps)` — every dependency injected, so it is testable without a live root | CLI commands |
| `tools/review/budget.mjs` | `releaseHeldReservation({root, reservationId, settledNanoUsd, reason, policy})` — the only audited exit from `held` | budget authority |
| `tools/review/redact.mjs` | `redactSecret(text, secret)`, `redactPolicySecrets(text, policy, env)` — re-exported from `budget.mjs` so existing imports keep working | credentials |
| `tools/review/evidence.mjs` | `validateReviewEvidence({root, changeId, tier, baseRef})` — now refuses an unknown tier instead of returning ok | review gate |
| `tools/workflow.mjs` | `runWorkflowCli` gains `budget-release --reservation --nano-usd --reason` | CLI entry |

Boundaries that did not move: the ledger still owns money under a cross-process lock;
`validateArtifacts` still owns tier completeness; the recorder delegates both.
