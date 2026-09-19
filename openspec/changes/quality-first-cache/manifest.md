# Requirements — quality-first neural prompt cache

User: «Давай это сделаем, но учти я не хочу чтобы пострадало качество выдачи или кода. На первом месте качество, на второй экономия».
Approved: «Безопасные гейты»; model routing: «Никогда».

| ID | Verbatim / decision | Acceptance | Status |
|---|---|---|---|
| R01 | «На первом месте качество» | No tool may truncate context, compact history, change model, skip verification, or auto-edit code. Any cache policy breach that might affect quality is advisory, not blocking | in-spec |
| R02 | «на второй экономия» | Report actual cacheRead/cacheWrite/input per model/session; cache-read share is computed, but never called universal provider hit-rate | in-spec |
| R03 | Earlier approved cache report | session_cost.py --cache-report outputs cold/warm turns, cache-read share, model switches and zero-usage errors; JSON mode included | in-spec |
| R04 | Earlier approved Cache Doctor | cache-doctor.mjs explains observable miss causes: model change/fallback, zero cacheRead after warm turn, compaction/summary events when recorded, prompt fingerprint changes when supplied; unknown stays unknown | in-spec |
| R05 | Earlier approved fingerprints | prompt-lint fingerprint emits deterministic layered hashes: base instructions, agent roles, rules, skills, combined; all discovery sorted; baseline/check existing behavior retained | in-spec |
| R06 | «Безопасные гейты» | cache-policy validator blocks only volatile static prompt literals, nondeterministic fingerprint generation and invalid return-contract shape; output/context/model limits stay advisory | in-spec |
| R07 | «Никогда» менять модель | Cache tools do not edit config.yml/models.yml/modelRoles and never recommend automatic model substitution | in-spec |
| R08 | Return contract | validator enforces required sections, line cap, TESTS counts, FILES path-only; accepts artifact/local URIs and returns actionable RU errors | in-spec |
| R09 | Backwards compatibility | Existing prompt-lint scan/baseline/check, session_cost aggregation, workflow gates, 33 tests, verify 24/24, audit 9/9 remain green | in-spec |

Non-goals: provider native cache-control (OMP runtime responsibility), automatic compaction, model routing, output truncation, fabricated savings estimates.