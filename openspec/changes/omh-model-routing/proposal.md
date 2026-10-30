# omh-model-routing — proposal

## Why
OMH-карта (T1 recon): у нас 1 дефолтная модель на всё, статусы бинарны
(reported неотличим от verified), память без обоснований решений.
Пользователь: категории с выбором моделей юзером + кнопка «автоматически»
(скан провайдеров → назначение на роли). Wave 0: 4 категории, аппрув
обязателен, гейт жёсткий.

## What Changes
- **Categories (R01)**: models.yml секция `categories: {strict,builder,scout}`
  с `{chain: [<provider>/<model>...], effort}`; маппинг ролей на категории;
  резолв с правилом «недоступна = стоп-вопрос»; chain-перебор при отказе.
- **Autorouter (R02)**: `tools/model-router.mjs`: `--scan` (probeProvider по
  всем провайдерам models.yml), `--plan` (эвристика: reasoning→strict,
  context→builder, flash|mini|lite→scout), `--apply` только после явного
  аппрува (флаг `--yes` + показ плана); без аппрува — только печать.
- **Status (R03)**: run-state стадия получает `verified: bool`; оракул/гейты
  выставляют verified; `close` отказывает при reported-only стадиях без
  `--force --reason` (прецедент budget-гейта).
- **Memory (R04)**: memory-cadence decision-запись `{decision:
  keep|reject|defer, reason}` на retain; сессионный пакет учитывает решения.

## QA-план
Контракты: (1) `openspec validate omh-model-routing --strict` exit 0;
(2) новые CLI --help exit 0; (3) гейты зелёные.
Чёрный ящик: фикстурный models.yml + мок probe → plan печатается, без
--yes не пишется; close на reported-only падает; cadence пакет исключает
rejected.
Меняется в тестах: +model-router.test.mjs (фикстуры), +статус/гейт кейсы в
workflow-тестах, +cadence decision кейсы.
QA-check: команды A1–A4 дословно воспроизводятся.

## Non-Goals
- 18 категорий как у OMH (только 4).
- Тихая подмена моделей (запрещена Wave 0).
- Per-branch cost в TUI (отложено в T1-карте).
- Живые провайдер-вызовы в тестах (только фикстуры/моки).
