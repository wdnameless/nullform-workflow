# Round2 resilience requirements

User approval: «Давай это интегрируем» accepts all twelve recommendations from
`.tmp/external-sources-analysis-round2.md` (diversity gate, usage normalization,
fact-forcing, oracle isolation, two-phase edits, cost snapshots, circuit breaker,
checkpointing, trajectory eval, capsule receipts, HUD spec, LOC tripwire),
plus outperforming `nick-vels/skills` on frozen tests, worktree isolation and evidence.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Давай это интегрируем» + «Model Diversity Gate: reviewer/oracle на другом семействе моделей, чем writer.» | Reviewer/oracle assignment proves checker family differs from writer family; same-family assignment is refused with a named reason. Proven by a unit check, no paid dispatch. | verified |
| R02 | «Давай это интегрируем» + «Provider usage normalization: починить задвоение OpenAI / занижение Anthropic.» | Normalizer derives provider-correct totals (Anthropic additive cache, OpenAI subset cache); unreported fields are UNKNOWN, never 0. Proven by fixture cases for both providers. | verified |
| R03 | «Давай это интегрируем» + «GateGuard fact-forcing: pre-edit хук требует чтения consumers/callers.» | Pre-edit check refuses edits without prior reads of callers/consumers; refusal names the missing evidence. Proven by a guard unit test. | verified |
| R04 | «Давай это интегрируем» + «Oracle asset isolation: хэши + exclude-маски тестов в Stage-B/оракуле.» | Frozen test assets carry hashes and exclude-masks; mutated or agent-patched assets fail validation. Proven by an isolation test. | verified |
| R05 | «Давай это интегрируем» + «Two-phase destructive edits: dry_run → plan_token → execution.» | Destructive edits require a dry-run plan token verified before execution; execution without a valid token is refused. Proven by a two-phase test. | verified |
| R06 | «Давай это интегрируем» + «Cost snapshots + tiered alerts: O(1) снепшот, notice/warning/critical.» | Cost snapshot writes atomically in O(1); tiered alerts fire once per tier with dedup. Proven by snapshot/alert tests. | verified |
| R07 | «Давай это интегрируем» + «Circuit breaker + model failback: авто-ретрай и fallback при 429/503.» | Breaker opens after N consecutive retryable failures and fails back to the reserve model; recovery is proven by a breaker test. | verified |
| R08 | «Давай это интегрируем» + «Durable checkpointing: рестарт волн с упавшего шага.» | Wave progress checkpoints durably; resume continues from the failed step without rerunning completed steps. Proven by a checkpoint/resume test. | verified |
| R09 | «Давай это интегрируем» + «Trajectory evaluator: детект циклов субагентов, лимит шагов.» | Trajectory monitor flags repeated identical tool calls as a loop and enforces a per-task step limit. Proven by loop/limit tests. | verified |
| R10 | «Давай это интегрируем» + «EvalCapsule receipts: NDJSON + SHA-256 цепочка, классы эффектов.» | Receipts append as NDJSON with a SHA-256 hash chain and effect classes; broken chain fails verification. Proven by a chain test. | verified |
| R11 | «Давай это интегрируем» + «HUD status spec: унификация дашборда/статуса сессий.» | Session status emits a versioned schema (working\|blocked\|idle + waits + costs); dashboard consumes the same schema. Proven by a schema test. | verified |
| R12 | «Давай это интегрируем» + «LOC tripwire + declarative fixtures: жёсткий лимит диффа, golden YAML.» | Diff over the tier LOC ceiling trips a blocking failure; golden fixtures declare input/output contracts. Proven by tripwire/fixture tests. | verified |
