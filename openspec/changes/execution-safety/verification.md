# Executed verification

This file records observations, not model acceptance. No paid review-run, OpenRouter/nullform-gateway execution, paid A/B or npm publication was performed for this change. Initial direct Codex workers reached their account limit; replacements are explicitly pinned to the currently advertised catalogue-free OpenCode LongCat route after unavailable/missing free models were rejected. Worker summaries are not acceptance receipts, and SDK tariffs are not independently verified invoices.

## Claims failing before implementation

Command in isolated ClaimsOwner worktree on original production source:
`node --test tools/tests/task-claim.test.mjs tools/tests/task-claim-cli.test.mjs`

Observed: exit 1; 72 counted tests; 1 passed, 71 failed, 0 skipped; 3089 ms. Full retained parent output: artifact://6532. Intended failures included token disclosure, replacement fencing, overlapping files, contracts, canonical links, CLI argument refusal and concrete context. No source fix was present for that run.

## Claims API after implementation

Command: `node --test tools/tests/task-claim.test.mjs` in the ClaimsOwner worktree.

Observed: exit 0; 55 passed, 0 failed, 0 skipped; 2531 ms. Subsequently the integrated claims API/CLI plus native-evidence/admission suites ran together: 134 passed, 0 failed, 0 skipped, 44451 ms (`node --test tools/tests/task-claim.test.mjs tools/tests/task-claim-cli.test.mjs tools/tests/review-evidence.test.mjs tools/tests/review-integrity.test.mjs`). That includes real separate-process CLI races and the dispatcher cutover, but is not final M02/H01 integration verification.

The actual integrated public `bin/nullform.mjs workflow` additionally exercised acquire A, competing B refusal without token, release response without token, reacquire B generation 2, stale A token refusal and a context packet containing the exact contract argv without release authority. This particular throwaway probe used Eval's process.execPath (Bun), whereas the regression commands above used actual Node. Temporary fixture was removed; `.tmp/claims-cli-smoke.json` records this observation, not model execution.

## Model admission/recovery failing before implementation

Command in ModelOwner worktree on original production source:
`node --test tools/tests/review-evidence.test.mjs tools/tests/review-integrity.test.mjs`

Observed: exit 1; 62 counted tests; 40 passed, 22 failed, 0 skipped; 36686 ms. Full retained parent output: artifact://6534. The harmless native child actually dispatched despite missing/disallowed authority; dry-run did not expose unsupported transport; zero tariff was rejected; a completed transcript disappeared before receipt publication; resume repeated the child. All dispatch fixtures were harmless local executables/synthetic transcript fixtures, not provider model requests.

## Actual native clients, isolated and without inference

- Installed `hermes.exe --version`: exit 0; Hermes 0.19.0 (2026.7.20), Python 3.12.9, pip installation under the existing isolated project venv.
- Installed `hermes.exe config path` with explicit isolated HERMES_HOME: exit 0, returned that exact sandbox config path.
- Real installed `cli.HermesCLI` constructor read `agent.system_prompt` from fresh sandbox YAML and returned the exact human prefix + probe marker + human suffix. All socket connect calls were guarded to fail; observed network attempts were empty. No chat/agent model turn was called. `.tmp/hermes-native-consumer-before.json` retains stdout/stderr/exit. This establishes native field consumption, not the final installer or answer quality.
- Real installed OMP CLI via Bun with no extensions/skills/rules and `--version`: exit 0, version 18.11.3. `.tmp/omp-native-version.json` retains result. This is startup proof, not model-task acceptance.
- Removed Codex client was not reinstalled. Previously unauthenticated Claude is not represented as a live-client success. No personal home/configuration/credential content was read or modified.

## Installation failures retained, not hidden

A first source-init sandbox nested beneath the source root was correctly refused by the existing recursion guard. Moving the fixture to OS temporary storage passed that prerequisite but both fresh Hermes and OMP CLI init calls exceeded 180000 ms. These probes used Eval's process.execPath, which is Bun, not Node; they must not be called failed Node installation tests. Human identity files remained byte-identical; Hermes journal had finished 743 writes through native config. A subsequent harmless sentinel proved the relevant runtime defect: `node --check probe.mjs` exits 0 without executing it, but `bun --check probe.mjs` exits 0 AND executes it. Doctor incorrectly used its caller's execPath for Node syntax checks, allowing tool execution under Bun. `.tmp/syntax-runtime-difference.json` retains that proof. No owned descendants from the interrupted install remained in the process check. No timeout increase, lock eviction or fake success was used. Final smoke must use actual Node and separately verify the corrected Bun doctor boundary.

## H01 initial correction rejected

New native-policy regression before implementation: 8 tests, 0 passed, 8 failed, exit 1, 397 ms. After the initial H01 delta, full adaptive/profile/install tests returned 55 counted, 36 passed, 14 failed, 5 skipped, exit 1, 221414 ms (artifact://6549). Actual Node `.tmp/hermes-ownership-smoke.mjs` independently showed malformed generated YAML from a nested multiline scalar splice. The invalid correction is not accepted; JSON scalar serialization, ownership upgrade/removal and Bun syntax safety fixes are required.

## M02/H01f integrated verification (parent-executed, real Node 24.17.0)

All four M02 patches applied byte-identically (SHA-verified): M02-minus-budget + budget399 (eb42d8b8, R1 commondir-verified) + transport-fix D1-D4 (b0521f1f) + fixture-branches (62195c9b) + test-assertions T1/T2 (257d0d32) + D5 gate-provenance (d9d8b6ee). H01f focused native patch applied (H01f-incremental, hermes-policy91 + npm-smoke-harness154, sync-manifest + package.files reconciled).

- M02 suites: `node --test tools/tests/review-budget.test.mjs tools/tests/review-controlled-http.test.mjs tools/tests/worktree-snapshot.test.mjs` → exit 0; 56 counted, 56 passed, 0 failed, 0 skipped; 48s (`.tmp/parent-m02-final.log`). Covers full-window reservation, exact settlement, held-unknown-spend admission block, competing-process races, shared Git-common ledger across linked worktrees, no-retry/redirect, trickle-deadline cutoff, single product execution, forged-executor ineligibility, tamper integrity errors, fixture-gate rejection.
- C01/M01 suites post-integration: 134/134 green (`.tmp/parent-c01m01.log`). Native H01f suites: 92 counted, 87 passed, 0 failed, 5 skipped (`.tmp/parent-native3.log`); install-harness full 14/14 green after worktree `node_modules` provisioning from root-pinned parsers (`.tmp/parent-install-harness2.log`).
- Recovery suites: 11/11 HTTP/native resume tests + 11/11 deployment-journal/portable-runtime restore tests pass. Resume requires explicit `--resume-session`, never `--redo`; retained transcript + record hashes re-validated; adverse stays REJECT.
- Public CLI smoke (throwaway git probe, removed after): `review-run --dry-run` returns reserve58060800/ceiling1000000000/kind git-common with empty prerequisites; non-dry without key refuses exit 1; `--dryrun` typo refused with allowed-flags list; zero files created.
- Hermes final smoke (OS-temp sandbox, removed after): init exit 0 ok:true status warn; `config.yaml` parses, `agent.system_prompt` carries exactly 1 managed block, no skills dir; doctor exit 0 (5 pass / 3 warn / 2 skip); reapply idempotent. Evidence: `.tmp/hermes-final-init.json`, `.tmp/hermes-final-doctor.json`, `.tmp/hermes-final-reapply.json`, `.tmp/hermes-final-config.yaml`.
- Live-provider boundary probe: real `api.openai.com` reached with dummy key, honest HTTP 401, no credential leak. No paid request authorized or executed.
- code-size: PASS, 190 files, 1394 functions, 5 pre-existing exempts.

## Pending

- Candidate source freeze.
- Independent source-bound native acceptance and original release prerequisites; never satisfied by this Markdown file alone.
- General quality advantage and universal harness readiness remain not proven.

## Final full suite (parent-executed, real Node 24.17.0)

Command: `node --test "tools/tests/*.test.mjs"` on the fully integrated root (C01+M01+H01f+M02+J01+docs).

Observed run 1: exit 1; 1007 counted; 999 passed, 3 failed, 5 skipped. All 3 were stale pre-M02 assertions, not source defects: two pinned `automatedReview.supportedHarnesses === ["omp"]` + `requiresBun === true` (M02 truthfully reports all 9 harnesses + `node_only`); one expected M01 dry-run exit-0 tolerance for an invalid policy (M02 fails closed). Parent migrated all 3 with behavior-preserving semantics and solo-verified each green.

Observed run 2: exit 0; 1007 counted; 1002 passed, 0 failed, 5 skipped; 413s. Full retained parent output: `.tmp/parent-full-suite2.log`. The 5 skips are pre-existing conditional probes (Bun/native-version-mismatch rows), not new.
