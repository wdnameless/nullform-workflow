# Bounded skill benefit comparisons

## Replayable commands

Requires installed OMP (the SDK exported by the CLI package) and Bun, with an already configured authenticated fixed-price model. No new package or credential setup is performed here.

```bash
node tools/benchmark.mjs list
node tools/run-skill-benefit-eval.mjs --dry-run --root . --model nullform-gateway/gemini-3.8-flash-high --ceiling 1
# Parent only, after integrating the source/checks into the benchmark clone's commit:
node tools/run-skill-benefit-eval.mjs --yes --root . --model nullform-gateway/gemini-3.8-flash-high --ceiling 1
node tools/benchmark.mjs compare --baseline baseline-noskill --candidate candidate-skill
```

`--dry-run` actually loads the installed SDK through its package exports, resolves the exact configured Model plus auth availability, verifies its catalog tariff/transport and creates/disposes a restricted native session. All HTTP is denied; it is setup evidence, not an inference result. Model lookup never defaults to another provider/model. `--task ID` selects one pair; the durable ceiling still spans invocations.

The direct adapter surface is `bun tools/bench-session-runner.ts --root ROOT --task ID --arm baseline-noskill|candidate-skill --prompt-file FILE --run-dir DIR --model PROVIDER/MODEL --ceiling 1 [--skill NAME]`; `--setup-only --root ROOT --model PROVIDER/MODEL` does no inference.

Installed harnesses deploy the runtime modules under `tools/`, including `bench-results.mjs`; they do not need a copied `bench/` tree to import the evaluator. Point `--root` at the committed source repository containing task fixtures/checks and keep its existing spend ledger. Sync manifest additions include the runtime helpers; never deploy generated runs.

## Cases and honest measurement

Four constructed code examples represent repository consumer-routing and frozen-test patterns; they are **not a production dataset**:

- `eval-review-positive`: new `pause` event is dropped at the unchanged receiving dispatcher; the custom pad helper can be simplified (and has empty/multicharacter-pad hazards).
- `eval-review-near-negative`: original hello/exit manifest plus a fixture execution captured by the adapter, for blind acceptance rather than patch review.
- `eval-review-defect-outcome`: new `ExportReport` command silently falls through at an unchanged router; JSON cloning loses values and has a native replacement.
- `eval-workflow-execution-outcome`: actual native file write implements multiply while preserving add and fixed tests; parent-owned checks execute those tests and independent edge cases, and validate the terminal return contract.

Baseline loads no skills. Candidate loads **only the exact selected SKILL body**, failing if unavailable. Model, sampling/effort, tools, task and full fixture input bytes are otherwise equal; hashes and distinct native session IDs bind each pair. Review input contains real fixture code, generated git patch, manifest where present, and observed product stdout/exit where applicable—not metadata claiming those files were loaded.

Activation scores measure **instruction adherence or correct nonactivation under explicit skill-body injection**. They do not claim automatic skill discovery or JEV selection. Review checks parse the last normally stopped assistant's typed JSON report, match findings at the actual consumer/helper scope, count missed consumer defects and unmatched false-positive findings, and never score raw logs, intermediate text or class-name echoes. Unexpected findings are counted conservatively; human review of retained findings is necessary before generalizing. Workflow checks measure the limited real read/write consumer, not a complete delegated four-wave project acceptance ceremony. The short fixture's tests are frozen before dispatch by a digest outside model-writable paths, not an editable in-repo digest or `HEAD~1` shortcut.

## Native caps and spending

Allowed selectors are `nullform-gateway/gemini-3.8-flash-high` and `nullform-gateway/gemini-3.7-flash-high`, only with the installed fixed catalog prices: input **$0.75/M**, output **$3.75/M**, cache read **$0.075/M**, no cache-write/server-tool/orchestration billing. This is **SDK fixed-tariff accounting, not independently confirmed provider billing**. Unknown/variable price, extra billed buckets, coerced counters, NaN, mismatched selectors and fallback models are ineligible.

- Closed review: actual `session.runEphemeralTurn({promptText, tools:false, maxTokens:4096, maxContextBytes:49152, dedupeReply:false})`; one dispatched request.
- Workflow: actual `session.prompt` with mutable native `Agent.streamFn`, enforcing provider-facing system/messages/tool descriptors <=49152 bytes, maxTokens=4096, reasoning off and at most six physical requests. Native tools retain session/executable fields, which are excluded from the context-size projection; the physical wire-body cap below remains authoritative. The in-memory SessionManager is bound to the fixture repo (the native tool cwd authority); only native read of calc/frozen tests and write of calc are exposed. Ordinary tool approval is explicit only for this restricted workflow session; frozen-test writes, other paths and bash/task/find/network escape remain forbidden.
- A physical fetch guard verifies the exact configured chat-completions endpoint/wire model and serialized HTTP body <=49152 bytes with an actual numeric output-limit field <=4096. It fsyncs an atomic durable reservation **before each HTTP dispatch**. It disallows any retry until the prior native result has settled, so hidden SDK/transport retries cannot multiply spending. Redirects and unreserved side calls are denied; advisor/compaction/title/warmer/recovery are disabled or cannot dispatch through the closed boundary.
- Each reservation conservatively covers <=51200 input/cache tokens (serialized bytes plus framing allowance, all charged at the higher input tariff) and <=4096 total output tokens: **$0.05376**. Six closed review sessions and two six-request workflow sessions reserve at most **18 requests × $0.05376 = $0.96768**, below one USD on an empty ledger. Actual native input/cache/output counters settle every request without rounding away spend. Legitimate cached-input zero is accepted.

`bench/runs/spend-ledger.json` version 2 persists cumulative settlements and pending reservations. Concurrent writers are excluded. Outstanding requests after a crash, missing/invalid native usage or `blocked_unknown_spend` prohibit subsequent calls; never delete/reset the ledger to hide spend. A legacy ledger requires an audit, not an automatic zero-spend migration. Near the ceiling the next request stops before dispatch. Known spent errors and unknown reservations are retained.

## Observed artifacts and checks

Each run retains `session/session.jsonl`, `input.json`, `score.json`, `result.json`, the benchmark process log, and a runner-owned frozen-test digest for workflow. `comparison-<cohort>.json` retains only that invocation's paired observed outputs/scores, native identity/usage, duration, known tariff spend and halt errors. Equal or unfavorable candidate outcomes remain intact. The general benchmark compare command aggregates historical arms; use the cohort report for a specific fresh comparison.
Failures also retain `failure.json`: redacted native terminal errors, stream/context/request counters and whether the native terminal message was captured. Every session retains `tool-results.json` with actual native tool results/errors and resolved write paths, independent of the assistant's claimed DONE. Synthetic zero-usage native errors are diagnostic, not proof that no inference was billed; a ledger without a row does not establish provider zero spend.
`bench/.gitignore` uses the existing benchmark `runs/` convention: the durable ledger, raw transcripts, process logs and generated cohort reports stay local and are not staged. Publish only deliberately selected, sanitized evidence; ignoring generated artifacts never permits resetting spending.

`readRunOutcome(result, selector, ledger)` validates every retained native assistant and matches every request's exact selector, stop reason, complete usage/cost object and settled tariff. Fully accounted cap exhaustion or other bounded execution failure is an observed **failed** outcome: retain actual usage, native termination, failure artifact, checks/errors and paired input/session binding, with `requirementsSatisfied:false` and `finalText:null` when no final report completed. Such cohorts finish `completed-with-failures`; they do not halt merely because the candidate performed badly. Strict `readSession` remains the scoring default; its explicit `{requireCompletion:false}` mode is only for outcome accounting. Unknown/pending spend, missing dispatch evidence, malformed native usage or ledger/model/input mismatch still halt fail-closed. Never increase a cap or retry a failed arm to manufacture success.

No fresh inference, tests or setup verification was executed by the builder. Parent checks:

```bash
node tools/test-lens.mjs run -- node --test tools/tests/skill-benefit-eval.test.mjs tools/tests/benchmark.test.mjs
node tools/test-lens.mjs run -- bun test tools/tests/bench-session-runner.test.ts
# This explicit Bun/installed-SDK test is not part of the current Node-only CI suite.
node tools/code-size.mjs check
node tools/prompt-lint.mjs sizes --check
```

Unit native messages/transports are deterministic validation seams, never production execution evidence or a benefit claim.

The native offline test runs the actual installed SDK/agent/tools in a private Bun child with temporary home/agent directories and native-shaped `models.yml` containing only the exact fixed selector, known fixture tariffs, `offline.invalid` endpoint and a nonsecret dummy credential. Runtime-only environment inheritance and a temporary cwd prevent operator dotenv/auth-file reads; parent environment and SDK caches remain untouched, and argv/fetch are restored in the child's finally block. Real network is denied; only fabricated SSE responses are served. The test requires a genuine implementation write, refusal of a frozen-test write with unchanged bytes, two guarded requests, normally stopped final assistant and matching durable settlements. Bun and the installed OMP SDK are explicit prerequisites; only their absence justifies omitting/skipping this command, never missing operator authentication. This regression seam is not comparative API evidence or a claim of Node-only CI coverage. Parent smoke commands already executed include `bun test tools/tests/bench-session-runner.test.ts` (4 pass, 0 fail) and strict cassette replay verifying 1 POST 200 with exact body 200, unrecorded 501, and 0 upstream requests recorded in `native-network-replay.json`. Parent structural audit reflects 70 skills, 0 errors, and 130 warnings.

Parent observed all four planned cases across two cohorts: eight completed/failed sessions (six review sessions plus the workflow pair), with selected evidence retained in `openspec/changes/skill-benefit-evaluation/evidence/` (`observed-eight-sessions.json`, `native-workflow-attempt.json`, `native-attempt-1.json`, `native-network-proof.cassette.json`, and `native-network-replay.json`).

Across the three review tasks (`eval-review-positive`, `eval-review-near-negative`, `eval-review-defect-outcome`), both baseline and candidate satisfied all requirements (3/3 review requirements satisfied), identifying consumer defects and simplifications with 0 misses and 0 false positives each. Review spending totaled **$0.0033195 USD** for baseline vs **$0.00665775 USD** for candidate. Quality gain is not proven: candidate findings matched baseline accuracy while roughly doubling observed tariff spend; observed latency differences are single ordered observations and not causal. Activation scores measure instruction adherence or correct nonactivation under explicit skill-body injection, not automatic skill discovery or JEV selection. The short fixtures remain constructed representative patterns, not a production dataset.

In the workflow pair (`eval-workflow-execution-outcome`), baseline completed in one physical request ($0.0051855 USD), implemented multiply, preserved add and frozen tests, and passed runtime checks. Candidate used six physical requests / six recorded assistant turns ($0.01945125 USD), then its seventh stream attempt was refused by the existing six-request cap without a final report. Candidate retained abnormal termination with `stopReason: "toolUse"` and no final report (`finalText: null`, `requirementsSatisfied: false`). There is no claim of a completed full-workflow candidate.

Raw original cohort comparison reports (`comparison-0659d78e-578c-4abc-a21d-fc00130c5218.json` and `comparison-0ff011bd-f249-47d5-b586-6ab20c82af58.json`) retain their original status `halted` without modifying or rewriting historical cohort reports. Current outcome consumers using `readRunOutcome` accurately classify this fully accounted bounded execution failure as an observed failed outcome (`evaluationStatus: "failed"`, cohort `completed-with-failures`).

Final ledger `bench/runs/spend-ledger.json` records 18 total settled requests, 0 unsettled, status `ok` under the $1.00 USD ceiling, with cumulative known SDK fixed tariff **$0.0362235 USD** (17 comparison/attempt requests totaling $0.034614 USD plus one genuine one-request network proof smoke totaling $0.0016095 USD). This represents installed SDK fixed-tariff catalog accounting, not independently confirmed provider billing (actual API provider invoice is unknown). Synthetic zero-usage native errors and unrecorded failures are diagnostic and do not prove zero provider spend.
