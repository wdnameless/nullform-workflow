# Refactor wave 2 — requirements

User ask (verbatim): "делай" (волна 2 из REFACTOR-PLAN.md) +
"Я хочу красивый, рабочий код и удалить весь мусор".

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «красивый, рабочий код» — сплит verify | tools/verify.mjs ≤400 строк (фасад: parseArgs/resolveRoots/format/main + testTierGate); runVerifyProfile → tools/verify-profile.mjs, runAuditProfile → tools/audit-profile.mjs. CLI `verify.mjs --profile <verify\|audit>` и JSON инвариантны; workflow-gate.test.mjs (testTierGate) зелёный. | verified |
| R02 | «красивый, рабочий код» — сплит workflow-ci | tools/workflow.mjs: блок check-ci (~1670–2249: validateCheckCiOracleFiles, checkPushEvidence, checkQualityGates, cmdCheckCi) → tools/workflow-ci.mjs; cmdCheckCi — делегат. repo-gate.yml и workflow-gate.test.mjs зелёные; `workflow.mjs check-ci` поведение идентично. | verified |

Scope: волна 2. Out of scope: волны 3–4 (doctor, benchmark, dashboard), изменение поведения CLI.
