# Make product quality checks honest and reusable

This living plan tracks the approved change from design through executed verification. The base is ae97261 in D:/ohmypi/workflow-repo/.tmp/worktrees/product-quality; the preceding release candidate remains untouched in oss-product-integration. Instructions below are self-contained; no external service or model authorization is needed for deterministic validation.

## Purpose / Big Picture

A user should not receive a product-quality PASS when their declared build fails or no product check ran. The existing auto-review CLI will run installed project commands, show which evidence is missing and never install a checker silently. Existing planning documents will describe measurable performance, usability and architecture outcomes rather than grow a second framework. Designer guidance will use existing project design, with extra research/motion only when needed. A consumer benchmark will test behavior independently, not assume an agent's DONE proves quality.

## Progress

- [x] Recon identified auto-review, tests, verifier probe, dashboard JSON consumer, both CI callers, canonical core/roles and existing benchmark task/check mechanism.
- [x] Read-only audit previously reproduced syntax-invalid application build exit1 with auto-review exit0; new change/spec/interfaces written and strict OpenSpec validation passed.
- [ ] Independent brief/spec coverage and reconciliation before code.
- [ ] A: regression tests first, parent red run, then runner and actual consumers.
- [ ] B: approved policy/conditional UI and consumer evaluation task/check.
- [ ] Parent: integrate, docs/glossary, runtime proof and full relevant checks.
- [ ] Review/simplification with frozen passing tests; fresh recorded acceptance if available without paid dispatch, otherwise explicit blocker only.

## Surprises & Discoveries

Local semantic find returned JEV402/no charge; use literal grep and direct reads instead. Hindsight recall timed out once; no retry. JavaScript LSP references unavailable, so exhaustive literal runAutoReview/auto-review search mapped consumers. Historical archmap-removal declared type/lint report-only; this approved task deliberately supersedes that behavior without editing historical evidence. The repository has no npm test script, while CI explicitly runs tools/tests once. Keep that full run and supply an explicit meaningful native consumer command to the auto-review step rather than recursively running itself or duplicating the whole suite.

## Decision Log

Decision: keep tools/auto-review.mjs as the existing command, adding repeatable --require SCRIPT and --check JSON_ARGV with structured check statuses. Rationale: package scripts plus explicit native argv cover existing stacks without config registries, shell parsing or plugin infrastructure.

Decision: no applicable product check means unverified/exit1; debt-ledger alone is not product verification. Missing mandatory checks are distinct from failed actual checks and optional absent categories. Rationale: remove ambiguous green rather than manufacture compliance.

Decision: preserve useful information-hiding or test boundaries with one implementation; line count remains advisory. Rationale: maintainability is localization of change, not minimum characters.

Decision: retain source-bound release acceptance and no-paid-call constraints. Rationale: deterministic task checks and route-advertised-free advisory are not substitute release receipts.

## Outcomes & Retrospective

Implementation and after-proof are pending. No code-quality gain, performance gain or visual success is claimed from the approved plan itself. This section must be updated from executed results, including failures.

## Context and Orientation

Tools/auto-review.mjs exports runAutoReview(opts) and emits a JSON envelope consumed by dashboard.mjs. It currently executes npx type/lint in report-only mode, npm test conditionally and debt-ledger as a gate, skipping build. Tools/tests/auto-review.test.mjs covers clean/debt/CLI behavior; tools/verify.mjs uses disposable clean/debt roots. CI callers are .github/workflows/repo-gate.yml and templates/ci/workflow-gate.yml. The latter should verify a consumer's native project, not assume its tests live in tools/tests.

Core/PORTABLE.md is canonical process guidance; agent/agents files contain specialized role guidance, and skills/nullform-workflow-full/SKILL.md points to the core. Bench/tasks.json defines setup/check commands; bench/fixtures and bench/checks hold actual consumer examples. Reuse these; do not add a benchmark service. CONTEXT.md defines public vocabulary and README.md explains user commands.

## Plan of Work

Create two disjoint isolated writer trees from the committed spec. A owns runner/test/verifier/CI files listed in interfaces.md, first tests only; parent exercises new tests against baseline, then A implements. B owns canonical policies, design template and benchmark task/check/doc files. Both skip all suite/build/lint/formatters while writing; parent owns verification. Parent integrates their explicit source changes, updates glossary/public documentation and records evidence. No global/native human file is a destination.

Runner statuses are pass/fail/not-applicable/unverified; CLI exit2 is malformed input, exit1 means failure or missing evidence. Found project scripts are required; --require additionally demands an arbitrary named script, and --check adds explicit argv for non-npm, product smoke, performance or accessibility. A configured TS/ESLint check can use a local installed binary, never npx download. Existing Windows-safe npm resolver/process helper must be reused. Preserve the JSON envelope while adding checks/status. Root/config errors must not turn into an absent check. Structured commands are operator-authorized execution, not a sandbox for untrusted projects.

B adds a substantive small consumer task whose checker validates actual output and boundary/error behavior. The checker must discriminate independently seeded broken/valid controls and record its measurement limits. Maintainability follow-up and UI evidence use a short evaluation protocol; deterministic controls do not demonstrate model superiority or UI beauty. Do not run any historical benchmark command that dispatches a model.

## Concrete Steps

All commands below use cwd D:/ohmypi/workflow-repo/.tmp/worktrees/product-quality unless explicitly stated. Run openspec validate product-quality-contract --strict after spec changes. Parent runs node --test tools/tests/auto-review.test.mjs after frozen new tests arrive, before and after implementation. Run the added consumer check/control regression by its returned path, and actual auto-review --json on disposable broken-build, passing native-command and missing-required-script roots. Keep exact counts/exit codes in openspec/changes/product-quality-contract/verification.md.

After integration run node --test --test-concurrency=2 tools/tests/*.test.mjs, code-size check, and isolated-home prompt scan/skills structural check. Run actual public --help and installed/archive smoke where changed packaging warrants it. Never call auto-review without care if a consumer script recursively calls auto-review. Inspect the final diff for obsolete wording/default pins rather than repinning them.

## Validation and Acceptance

Broken build with green tests must return fail/nonzero. Missing --require check:perf must report unverified without network/tool installation. A non-npm project given a passing explicit Node command must pass while absent unrelated categories show not-applicable. Configured failed lint/type commands must fail. Unknown flags, invalid JSON argv and positional arguments must refuse before command side effects. No available product checks must return unverified rather than global PASS. Valid consumer business/boundary behavior passes, deliberately broken behavior fails. Policy proof is exact file citations and absence of conflicting prescribed rules, not a test matching prose. Full acceptance additionally requires original user requirements and independent running-product evidence; unavailable paid acceptance stays named, not forged.

## Idempotence and Recovery

No schema migration or live-user configuration change. Work in dedicated branches; parent is the integration owner. Keep pre-existing receipts and spend ledgers intact. Re-run deterministic commands against fresh temp roots; remove only owned disposable fixtures after evidence. Never reset another worktree or automatically accept Git conflicts.

## Artifacts and Notes

Approved verbatim requirements and observable criteria are manifest.md in this change. Complete API choices and writer zones are interfaces.md; strict scenarios live under specs/product-quality-contract/spec.md. The final verification record must distinguish frozen tests, actual consumer commands, static policy inspection and any unavailable independent acceptance.

## Interfaces and Dependencies

No new dependency. Keep runAutoReview export and existing CLI entrypoint; add only its requiredChecks/commands options and checks/status results. Use existing installation/state.mjs process helpers and standard Node filesystem/process APIs. Do not create interfaces, factories or adapters just to wrap one call; preserve a seam only when it hides meaningful execution/validation complexity.
