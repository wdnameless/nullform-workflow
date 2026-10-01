# Skills-only contracts and ownership

User explicitly selected «Только подсказки навыков», additional API budget «До $1.00», and activation in «Текущий профиль OMP». Model routing is removed, not left dormant. Historical v1 reports remain negative experiment evidence and cannot activate v2.

## Core and evidence

`tools/jev-assist.mjs` has no import-time actions. Keep `readCredential()`, `loadSkillCatalog({cwd,home,roots?,effectiveSkills?})`, `screenTask(text)`, `decide(...)`, `readPolicy(...)`, and `appendEvent(...)`.

- `readCredential()` uses caller environment or Bun OS secrets (`nullform-workflow` / `openrouter-api-key`), never config/log/report/child prompts.
- Native `pi.getCommands()` entries with `source:'skill'` are authoritative, including namespaces/disabled/provider precedence. Filesystem discovery is a standalone fallback. Current normal registry has 89 skills; only metadata is sent, never skill bodies.
- `decide({task,skills,apiKey,fetchImpl?,signal?,timeoutMs?,model?})` asks ONE typed skill-choice question at `POST https://openrouter.ai/api/alpha/decisions`, decision model `typesafe/jev-1.13`. Return `{status:'ok'|'fallback',reason,skill:string|null,confidence:number,model:string|null,usage:{inputTokens,outputTokens,costUsd,costKnown}}`. Remove `route`, `archetype`, `eligibleScore`, `skillConfidence` aliases, routing questions and constants. Confidence must be validated, not inferred from status. Valid high-confidence `none` is an attempted classifier decision; low-confidence output is abstention.
- Shared screening blocks real credential/PII/code-dump/context-only/risky inputs, including short JWT claim segments and explicit short/Unicode/quoted/opaque credential assignments. Semantic discussion without a value stays allowed. Unknown charged usage is reserved and cannot produce clean proof.

`tools/jev-evidence.mjs` provides coherent v2 evidence functions:

- `policyFingerprint({catalogFingerprint,baselineModel,decisionModel})` hashes only the active skills-only identity.
- `loadEvaluationDatasetContext({root?})` explicitly loads canonical `calibration.json` / `heldout.json`, computes SHA-256 hashes, and has no import-time I/O.
- `evaluateReport(report,{datasetContext})` is pure and returns `{skillPassed:boolean}`. Trusted context is required. Validate exact canonical IDs/gold/canary flags, 64-hex hashes, disjoint 12+ calibration and 40+ held-out rows, all request/cost/count consistency, errors 0, unknownSpend 0, complete live evidence. Quality/decision-cost summaries use held-out rows only; safety/errors/global spend include calibration too. `dryRun`/simulated/v1 evidence never passes.
- Remove outcome/routing matchers, routing statistics, candidate execution-model identity and compatibility re-exports.

Report v2: `{version:2,createdAt,catalogFingerprint,catalogSource,baselineModel,decisionModel,fingerprint,datasetHashes:{calibration,heldout},decisionSnapshots,calibration:{total,hash},heldout:{total,hash},skills:{total,eligible,safetyTotal,safetyMisses,baseline:{attempted,correct,falsePositives,costUsd},candidate:{attempted,correct,falsePositives,criticalMisses,costUsd},cases},requests,errors,spendUsd,unknownSpendUsd,maxCostUsd,completed}`. `candidate` is the JEV classifier, not a child execution model. Raw rows retain actual outbound flags and receipt/error information.

Policy v2: `{version:2,enabled:true,expiresAt,catalogFingerprint,baselineModel,decisionModel,fingerprint,reportSha256,decisionSnapshots}`. Recompute positive quality/cost flags from the bound canonical v2 report. Native caller checks current catalog identity; stale/missing/failed/old evidence preserves baseline.

## Native runtime and installation

`agent/extensions/nullform-jev.ts` exports the default native extension plus a natural test factory `createJevExtension(options?)` and native metadata helper. Runtime only handles eligible main-session `before_agent_start`: append bounded skill ID context at confidence >=0.80 with valid policy/snapshot, without changing system/catalog prefix or model. Subagents, secrets, context-only turns, errors, opt-out and no credential retain baseline. No provider registration, task cache/generation, `tool_call`/`before_subagent_spawn`, model selector, protected-role lists or model override remains.

Installers/sync install this one extension and core/evidence scripts idempotently without touching unrelated profile files or canonical human prompts. Current-profile files outside the repo are explicitly user-approved; credential remains in the OS store. A running process may require native reload; do not kill/restart the user's daemon.

## Evaluation and control

`tools/jev-evaluate.mjs` / necessary deep case helper execute paired skill selection ONLY: pinned baseline `google/gemini-3.8-flash` chooses one skill/none from the same native catalog, JEV is the candidate classifier. Keep the original 14 calibration / 44 held-out corpus unchanged. Remove active `outcomes.json`, route loops, cheap-model CLI/options/rates and obsolete tests. Historical negative routing reports are preserved as evidence, not supported schemas.

Activation: no safety/critical miss, >=70% attempted coverage, >=95% attempted precision, no worse than baseline precision, and lower actual decision cost or demonstrated quality improvement. Never tune on held-out outputs or discard API failures. Finite nonnegative spend cap is checked before network; fixture/dry-run is zero-network plan-only. Checkpoint incomplete evidence; all failed attempts remain documented.

`jev-control.mjs status|enable|disable --home ... --report ... --root ... --catalog ...` validates canonical v2 proof and native snapshot before writing report/policy, never a key. Missing/malformed supplied catalog fails closed. No network on import.

## Delivery gates

One core owner, one native owner, one evaluator owner; separate project-contained worktrees. Every caller/test/doc migrates, no deprecated aliases or shims. Source files <=700 lines and functions <=120 without baseline exceptions. Writers skip builds/tests/lint/API mid-flight; parent verifies integrated source and real native runtime.

Parent records actual API spending from the current observed base $0.864415202; additional spending ceiling $1.00. Keep all earlier failed reports. Fresh error-free v2 live proof, raw redacted cassette + strict replay, actual OMP automatic turn/opt-out/error/secret smoke, then double blind acceptance (current Oracle is flash-class). Activate current profile only after positive evidence.
