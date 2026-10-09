# Parent reconciliation: implementation not yet accepted

## Verified and integrated R03

- Structural worktree tests: `node --test tools/tests/skill-audit.test.mjs tools/tests/prompt-cache.test.mjs` -> tests25/pass25/fail0.
- Actual audit of69skills: zero structural errors,130 advisory warnings (not silently suppressed).
- Existing sizes, code-size and prompt scan passed. Four long skills split with original metadata intact and content retained in direct resources; parent restored a missing conditional theme-toggle instruction.
- Structural commit51ba61e integrated as58caefa on feat/review-skill-evidence.

## R02 native proof: rejected implementation

Observed focused gate test failures are preserved at artifact://3870; existing stale/fresh/credential/cache/identical-content semantics must be retained, not re-pinned to a broken implementation. One concrete fixture error is missing existsSync import. Source-backed issues:

1. Source digest hashes HEAD/tree and dirty status/path, not dirty bytes. A second edit at the same dirty path is invisible; acceptance-only commits cause unrelated invalidation. Reuse/share existing workflow content-snapshot logic, with consistent generated/credential/containment policy.
2. `workflow artifact --kind oracle` currently rewrites native receipts/digests/timestamps without execution. Remove that laundering behavior; registering an artifact must never refresh its proof.
3. Native projection is optional and disconnected from the record verdict/model/usage. Require retained allowlisted native events/report, integrity and deterministic re-projection consistency. No ACCEPT-only legacy shortcut.
4. Require exact effective model/provider, safe integer native counters (nonnegative; cached input0 can be legitimate), finite known tariff costs, actual final completed assistant and native timestamp/session identity. No substring/default/earlier text or invented completion.
5. Bind reviewer source A -> actual StageB A/B -> oracle B=current and frozen StageA test set throughout; support real simplification, not tautological copied before fields. Runtime read-only/source mutation checks apply.
6. Operator commands must actually send role instructions, full relevant source/diff plus manifest, and provide real read-only tools to exercise product. No bare request/no-tools fake review. Native process spawning and file/session paths must be safe and portable.

## R04/R05 benchmark: rejected implementation

Actual safe preflight `omp models find gemini --json --no-extensions --config bench/models-eval-overlay.yml` still returned maxTokens65536/contextWindow1048576. The YAML models overlay and invented max-tokens/max-turns CLI flags do not enforce a cap. Parent has dispatched no paid comparative calls.

Verified configured fixed catalog tariffs: nullform-gateway/gemini-3.8-flash-high and3.7-flash-high: input0.75/output3.75/cacheRead0.075 USD per1M. This is native fixed-tariff accounting, not independently confirmed provider billing; label it honestly. Unknown-pricing Ollama model is ineligible for zero-cost claims.

Installed OMP18.6.1 source exists under D:/npm-global/node_modules/@oh-my-pi/pi-coding-agent/src; SDK examples under examples/sdk. Real single-request API: runEphemeralTurn({promptText,tools:false,maxTokens,maxContextBytes,dedupeReply:false}) -> {replyText,assistantMessage}. It does not execute tools, persist history or magically include file/diff context. Full workflow needs verified bounded request/stream control, not ordinary uncapped session.prompt.

Additional concrete defects: benchmark check child lacked BENCH_RUN_DIR env; native content discriminator is toolCall; raw/intermediate text must not become final score; arbitrary/malformed model usage cannot pass; immutable test digest rather than HEAD~1 prevents edit/commit laundering; source-string class-name and command-format tests are invalid incidental coverage. Candidate must genuinely load only the selected skill and fail if missing; baseline inputs/model/settings equal. Closed-input review needs real source bytes. Workflow outcome requires real changed code passing fixed tests. Durable pre-dispatch reserve covers every bounded model request/retry and blocks further calls after unknown spend; the user ceiling is one additional USD.

## Remaining boundary

These local records are auditable execution provenance, not cryptographic attestation against a malicious machine owner fabricating all local files. No new external dependencies, no baseline inflation, no unrelated user CODEMAP edits, no paid builder probes. Parent owns checks and final live execution.
