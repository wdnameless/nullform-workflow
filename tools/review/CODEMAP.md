# tools/review/

## Responsibility
Controlled review execution and its audit chain: authorize what an oracle/reviewer may touch, spend against one durable money ledger, execute exactly one verified provider route, and emit cryptographic evidence a later reader can re-validate. Splits into five roles — gatekeeper (authorization), budget (financial authority), executors (native in-process vs controlled HTTP), evidence projection, and arbitration. No layer trusts a claim from the layer above it; every fact is re-derived from raw artifacts.

## Design Patterns
- **Single Financial Authority (Ledger + Reservation)**: `budget.mjs` is the only place money is counted. One ledger per *project* (beside the verified Git common dir, never per worktree), integer nano-USD, discovery fails closed. `EXECUTOR`, `PINNED_PROVIDER` / `PINNED_MODEL` / `PINNED_ENDPOINT`, `PINNED_TARIFFS_USD_PER_MILLION` pin the route so a review cannot silently drift to a different model or price. Charges are consumed durably *before* the physical call.
- **Settle-Compaction (Rollup Invariant)**: `ledger-compact.mjs` folds settled rows into a rollup to keep the ledger under 1 MiB while preserving `ledger.settledNanoUsd == Σ settled charges in reservations` — `partitionReservations` → `foldSettledMetadata` → `buildRollupReservation` → `compactLedger`. Idempotent by construction: folding changes shape, never the sum.
- **Gatekeeper / Pre-Call Authorization**: `gatekeeper.mjs` classifies tools into EXEC / WRITE / NETWORK danger categories (`DANGEROUS_EXEC_TOOLS`, `DANGEROUS_WRITE_TOOLS`, `DANGEROUS_NETWORK_TOOLS`), and `authorize` / `assertFactForcing` deny un-approved calls, keeping an audit log (`getAuditLog`, `clearAuditLog`).
- **Two Executors behind One Contract**: `native-tools.mjs` runs in-process product inspection (`inspectProduct`, `executeProduct`, `readProductPage` + `assertProductExecutionInvariant`); `http-runtime.mjs` is a bounded stdlib-Node Chat Completions executor (`runHttpReview`, `sendOnce`, `createHttpExecutor`) — one route, no retries/redirects/fallback tiers — reached through the tiny stdio child `http-child.mjs` (one JSON invocation on stdin, one result envelope on stdout, argv ignored).
- **Re-Projection / Provenance Hash Chain**: `http-evidence.mjs` (`reprojectHttpExecution`, `projectHttpRecord`, `validateHttpRecord`, `extractVerdict`) rebuilds the record from the child's retained execution log plus raw provider response files, and captures immutable provenance in the child before the first wire call. `evidence.mjs` owns the hashes (`computeFileHash`, `computeSourceDigest`, `computeTestFilesHash`, `computeEventProjectionHash`, `computeManifestHash`, `computeRolePromptHash`) and the verdict regexes.
- **Historical Re-validation (as-of-revision)**: `evidence-history.mjs` — `validateReviewEvidenceAtRevision` — compares recorded hashes against the tree *at a revision*, because validating an archived change against HEAD fails on any later unrelated commit.
- **Arbitration / Scoring**: `arbitrate.mjs` (`arbitrate`, `scoreReview`, `consolidateF1`, `repairBudget`) turns findings into a verdict against acceptance criteria.

## Data & Control Flow
1. Caller (e.g. `tools/auto-review.mjs`) asks `gatekeeper.mjs` to `authorize` each tool the review will use; denials are audited.
2. `budget.mjs` reserves and durably consumes nano-USD before execution; `ledger-compact.mjs` compacts the ledger when it approaches the size ceiling.
3. Execution: native path via `native-tools.mjs`, or HTTP path via `http-runtime.mjs` spawning `http-child.mjs` with a sanitized env (`sanitizedChildEnv`), an exact credential env var (`credentialEnvForProvider`) and no hidden retry.
4. Evidence: `http-evidence.mjs` re-projects the record from raw artifacts; `evidence.mjs` writes/loads `review-evidence.json` and validates hashes; `evidence-history.mjs` re-validates it at a revision.
5. `arbitrate.mjs` produces the verdict; positive/negative verdict recognition uses `isPositiveOracleVerdict` / `isNegativeOracleVerdict` (marker `LEGACY_MARKER`, file `EVIDENCE_FILE`).

## Integration Points
- **Imports**: `../worktree-snapshot.mjs` (git-common discovery / repo boundary), `../installation/state.mjs` (path safety, identity), internals `budget.mjs`, `ledger-compact.mjs`, `gatekeeper.mjs`, `http-runtime.mjs`, `http-evidence.mjs`, `native-tools.mjs`.
- **Consumers**: `tools/auto-review.mjs`, `tools/oracle-model.mjs` (route selection), `tools/quality.mjs` / review gate wiring, and `tools/tests/` (`review-evidence`, `review-integrity`, `review-budget`, `review-boundaries`, `review-arbitration`, `review-controlled-http`, `review-execution` fixture).
- **Environment contracts**: `PROVIDER_CREDENTIAL_ENV`, `GATEWAY_CREDENTIAL_ENV` (via `credentialEnvForProvider`); `EXECUTION_FILE` holds the child's execution log consumed by re-projection; `EVIDENCE_FILE` names the durable evidence record.
- **State / artifacts**: project-level budget ledger (`BUDGET_LEDGER_FILE` under `BUDGET_LEDGER_DIR`, ≤ 1 MiB), review evidence JSON per change, child execution log + raw provider responses.
- **Boundary rule**: `http-child.mjs` accepts nothing from argv; `ledger-compact.mjs` has no imports — it is pure data-shape work, which is what keeps the invariant testable in isolation.
