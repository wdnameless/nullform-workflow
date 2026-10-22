# Autopilot parity requirements

User approval: «я хочу чтобы у нас был весь их фунцкионал и мы были лучше этого
фреймворка по все параметрам» accepts the full gap registry from
`.tmp/autopilot-gap-registry.md` (P0/P1 mechanisms), keeping our superior frozen
tests, worktree isolation, evidence protocol and zero-dep architecture.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «весь их фунцкионал» + «Mode/depth dials: --mode/--depth в start.» | `start` accepts and persists mode/depth; invalid values are rejected with the allowed set named. Proven by a CLI test. | verified |
| R02 | «весь их фунцкионал» + «Неизменяемый бриф + redaction gate.» | Brief is frozen to a dated file; secrets are redacted before disk write; oracle input resolves to brief-only. Proven by freeze/redact tests. | verified |
| R03 | «весь их фунцкионал» + «G3 check-plan: трассировка, волны, зоны.» | Plan validator enforces R↔ticket coverage, wave topology and disjoint wave zones; violations name the ticket/requirement. Proven by validator tests. | verified |
| R04 | «весь их фунцкионал» + «REDPROOF + лимит 25 строк в контракте воркера.» | Worker return contract requires a REDPROOF line and ≤25 lines; validation rejects missing/oversize reports. Proven by contract tests. | verified |
| R05 | «весь их фунцкионал» + «Типы и статусы требований + авто-recount.» | Requirement rows carry type (R/Ri/G/A/D) and lifecycle status; recount derives counts mechanically. Proven by parse/recount tests. | verified |
| R06 | «лучше по все параметрам» + «G2 coverage check слепым субагентом.» | Coverage check compares spec vs brief without the manifest and records found/fixed/deferred; gate fails on uncovered gaps. Proven by a gate test. | verified |
| R07 | «лучше по все параметрам» + «G4 в чистом клоне, только бриф.» | Blind acceptance runs in an isolated temp clone from the brief only; spec/manifest/tickets are unreachable. Proven by an isolation test. | verified |
| R08 | «лучше по все параметрам» + «8 измерений глубины + 7 вопросов adversarial.» | Spec checklist covers the 8 depth dimensions; Wave 0 runs the 7 adversarial questions; missing items are reported. Proven by checklist tests. | verified |
| R09 | «лучше по все параметрам» + «Трёхосевое ревью + F1 + лимиты ремонта.» | Review scores Manifest/Spec/Craft independently, consolidates branch blockers into F1, enforces ≤2 repairs/retries + 1 re-review. Proven by review tests. | verified |
| R10 | «лучше по все параметрам» + «Beats + ask/answered + commits check + трейлеры.» | Event beats compute honest work time minus waits; commits check verifies ancestors; commit trailers recorded. Proven by journal tests. | verified |
| R11 | «лучше по все параметрам» + «Carried.md + норм. стоимость + skills-lock.» | Debts carry across runs; normalized cost with role split and cache-churn tripwire; skills-lock verifies hashes. Proven by carry/cost/lock tests. | verified |
| R12 | «лучше по все параметрам» + «Zero-build snapshot + graceful shutdown + collision detect.» | Dashboard embeds a file:// snapshot; server shutdown is graceful with foreign-process protection; parallel sessions collide-detect. Proven by snapshot/server tests. | verified |
| R13 | «улучшим наш дешборд чтобы он был так же функционален как и в autopilot» | Dashboard run view: hero-статус цветом, трек стадий, R## «твои слова», гейты G1–G4, лента, часы active/wait с тиком 1с, --freeze offline-снапшот. Proven by dashboard.test.mjs + live /api/state smoke. | verified |
