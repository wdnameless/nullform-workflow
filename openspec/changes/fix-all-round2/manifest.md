# Manifest — чиню D1→B4 пачкой (fix-all-round2)

Source: user "Проанализируй наши текущие проблемы воркфлоу относительно
современных подходов" (2026-11-01) + user "чини по порядку" (2026-11-03)
+ Wave 0 picks + T1 recon `.tmp/recon-workflow-problems.md` + T2 recon
`.tmp/recon-fix-all-t2.md`.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | CFR честен: нормализация интервала + fail-loud, дефолт воспроизводим | "чини по порядку" | in-spec |
| R02 | Дашборд открывается из Paseo-браузера | "чини по порядку" | in-spec |
| R03 | Lifecycle-evals ядра процесса (минимум) в CI | Wave 0: "Минимум: lifecycle-ядро" | in-spec |
| R04 | Execution-lock + settlement с подтверждением | Wave 0: "Лок + settlement с подтверждением" | in-spec |
| R05 | Skill parity: источник правды решён и задокументирован, без чистки | Wave 0: "Только parity, без чистки" | in-spec |
| R06 | Локальный JSONL-счётчик гейтов/ролей, без сети и PII | Wave 0: "Локальный счётчик" | in-spec |
| R07 | B1: workflow.mjs у потолка 2388/2500 — план сплита или снижение | "чини по порядку" | in-spec |
| R08 | B2: правило сплит-vs-ресид в доке | "чини по порядку" | in-spec |
| R09 | B3: blind-oracle-only узаконен нормой для обычных T2 | Wave 0: "Узаконить blind-only" | in-spec |
| R10 | B4: install reuse prepared storage | "чини по порядку" | in-spec |

## Constraints (Wave 0 + recon facts)

- C1: A4 (память/Hindsight) — ВНЕ скоупа ("Оставить как есть").
- C2: A1 — только lifecycle-ядро, без promptfoo-паритета.
- C3: A2 settlement — только с явным подтверждением, никакой авто-уборки.
- C4: A3 — без prune/lazy-каталога, только parity-решение.
- C5: C7-прецедент: openspec validate требует proposal.md + tasks.md + непустой specs/.
- C6: Оркестратор на T2+ код проекта не пишет.
- C7: Hindsight down — 1 попытка, дальше локалка.
- C8: D2: curl 200 за 7.56s; bind 127.0.0.1 — два кандидата корня.

## Acceptance (observable)

- A1: `cfr-report --since 7d` == `--since 7.days.ago` (8 fix/10 feat на 11-01);
  пустой лог при непустом репо → nonzero exit + stderr (тест).
- A2: дашборд открывается из Paseo (browser_new_tab без timeout) ИЛИ доказан
  внешний корень с обходным путём для юзера.
- A3: `lifecycle-evals` зелён в CI; кейсы pickup→409→approval→deny детерминированы.
- A4: двойной claim одной таски → 409; `settle` без confirm отказывает, с — убирает.
- A5: sync parity: источник правды назван в доке; `sync --check` интерпретируем.
- A6: гейт-прогон инкрементит локальный JSONL; сети нет (тест).
- A7: workflow.mjs ≤2500 с планом сплита (тикет #16 обновлён) или ниже 2388.
- A8: GATES.md содержит правило сплит-vs-ресид.
- A9: PORTABLE §5 или enterprise-directives: blind-only — норма, маркер не нужен.
- A10: повторный install переиспользует prepared storage (тест или замер времени).
