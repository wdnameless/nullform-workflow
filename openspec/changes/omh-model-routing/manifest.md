# Manifest — OMH model routing + verified status + memory reasons

Source: user "Бери, но модели должен выбирать юзер в настройках. Так же
должен быть умный распределятор моделей, чтобы если юзер не понимат он бы
мог нажать автоматически, агент бы просканировал доступные юзеру провайдеры
и назначит модели на роли сам" (2026-10-30) + Wave 0 picks + T1 recon
.tmp/recon-omh-video.md.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | 4 категории моделей под роли (strict/builder/scout + fallback-chain), модели выбирает юзер в настройках | "модели должен выбирать юзер в настройках" | in-spec |
| R02 | Автороутер: по кнопке сканирует провайдеры юзера и назначает модели на роли сам, план только с аппрувом | "агент бы просканировал доступные юзеру провайдеры и назначит модели на роли сам" | in-spec |
| R03 | Двучастный статус reported/verified + жёсткий гейт на close | T1 recon rule 5 (Wave 0: с гейтом) | in-spec |
| R04 | Память: keep/reject/defer с письменным обоснованием | T1 recon rule 4 | in-spec |

## Constraints (recon facts)

- C1: Wave 0: 4 категории; аппрув обязателен; гейт жёсткий.
- C2: models.yml map-form обязателен (list-form ломает селекторы).
- C3: Автороутер поверх probeProvider (oracle-model.mjs:239), не дублировать.
- C4: Effort канон: minimal|low|medium|high|xhigh|max (OMP schema:132).
- C5: Close-гейт по прецеденту budget-гейта (force+reason hatch).
- C6: Опыт: Hindsight down (1 attempt), Windows paths quoted.
- C7: openspec validate требует proposal.md + tasks.md + непустой specs/.
- C8: Оркестратор на T2+ код проекта не пишет.

## Acceptance (observable)

- A1: models.yml поддерживает categories{strict,builder,scout + chain,effort};
  недоступная модель = стоп-вопрос, не подмена (тест).
- A2: `model-router --scan` находит провайдеры; `--plan` печатает назначения;
  без аппрува ничего не пишется; с аппрувом — пишется (тест на фикстурах).
- A3: run-state показывает reported vs verified; close при reported-only
  отказывает без --force --reason (тест).
- A4: memory-cadence хранит decision+reason на retain; пакет на сессию
  собирается с учётом решений (тест).
