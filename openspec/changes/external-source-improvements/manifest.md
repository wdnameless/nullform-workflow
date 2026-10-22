# External-source improvements requirements

User approval: «Давай все брать» accepts all eight recommendations from `.tmp/external-sources-analysis.md` (cross-model blind review, arbitration gate, budget ledger, tool gatekeeper, state manifests + wait barrier, triage automation, behavioral evals, tool fallback + token budget/compaction).

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «Давай все брать» + «Cross-model blind review (видео R1): Oracle на независимом семействе моделей.» | Oracle resolution proves checker model family differs from the builder model family on a fixture; same-family selection is rejected with a named reason. No paid dispatch in tests. | open |
| R02 | «Давай все брать» + «Arbitration gate (видео R3): оркестратор валидирует замечания vs acceptance criteria.» | Reviewer findings are accepted only when each maps to an acceptance criterion; non-mapped findings are dropped with a machine-readable reason. Demonstrated by a unit/e2e check. | open |
| R03 | «Давай все брать» + «Budget ledger (paperclip R1): транзакционный учёт затрат с отсечкой по лимитам T1–T3.» | A durable ledger records usage receipts idempotently (restart-safe) and enforces tier ceilings by refusing over-limit admission. Proven by a restart/receipt test. | open |
| R04 | «Давай все брать» + «Tool gatekeeper (paperclip R2): pre-call guard перед небезопасными MCP.» | A pre-call guard validates tool arguments and blocks dangerous calls before execution; allow/deny is logged with the rule name. Proven by a guard unit test. | open |
| R05 | «Давай все брать» + «State manifests + wait barrier (herdr R3/R4): TOML-детект состояний, push-ожидание.» | Agent state is classified working\|blocked\|idle from declarative rules; completion is awaited via an event barrier with timeout instead of polling. Proven by a barrier test. | open |
| R06 | «Давай все брать» + «Triage automation (PDF #89): авто-расчёт T0–T3 по blast-radius.» | `suggest` derives T0–T3 from a measured blast-radius (files, spread, keywords) with a printed rationale; fixture cases map to the expected lanes. | open |
| R07 | «Давай все брать» + «Behavioral evals (paperclip/promptfoo): регрессия контрактов оркестратора.» | Declarative eval cases cover the orchestrator return contract (lane header, acceptance criteria, handoff fields); eval runner reports pass/fail per case. | open |
| R08 | «Давай все брать» + «Tool fallback + token budget/compaction (PDF #57/#50/#51): failover MCP, авто-compact.» | Fallback chain switches tools on failure with logged order; token budget triggers compaction before overflow. Proven by fallback and budget unit tests. | open |
