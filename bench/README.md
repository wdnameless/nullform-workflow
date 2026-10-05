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

No fresh inference, tests or setup verification was executed by the builder. Parent checks:

```bash
node tools/test-lens.mjs run -- node --test tools/tests/skill-benefit-eval.test.mjs tools/tests/benchmark.test.mjs
node tools/test-lens.mjs run -- bun test tools/tests/bench-session-runner.test.ts
node tools/code-size.mjs check
node tools/prompt-lint.mjs sizes --check
```

Unit native messages/transports are deterministic validation seams, never production execution evidence or a benefit claim.

The native offline test runs the actual installed SDK/agent/tools with fabricated SSE HTTP responses and a deny-all real-network sentinel. It must observe a genuine native implementation write, refusal of an attempted frozen-test write with unchanged test bytes, two guarded requests, normally stopped final assistant and matching durable settlements; it is a regression seam, not comparative API evidence. After those checks, resume only the missing pair with `node tools/run-skill-benefit-eval.mjs --yes --root . --model nullform-gateway/gemini-3.8-flash-high --ceiling 1 --task eval-workflow-execution-outcome`; preserve the six prior review sessions and cumulative ledger.
