# video-rules-adoption — proposal

## Why
Разбор видео RUSslI9Ahl4 показал 7 переносимых правил, которых нет в
харнесе: мутационный гейт в CI, QA-план до нарезки, enrich-дамп,
критичность в manifest, reviewer против БЗ, SAST в CI, аппрув дизайна.
Плюс R08: `workflow start` роняет дашборд (brief.mjs не в sync-manifest).
Пользователь приказал: "Делай и чини все".

## What Changes
- **Mutation CI (R01)**: шаг в job `gate` repo-gate.yml — мутационный прогон
  по изменённым JS-файлам (wrapper-цикл поверх single-target CLI), бюджет
  мутантов, `--check` с threshold.
- **QA-план (R02)**: новая обязательная секция `## QA-план` в proposal.md
  для T2 (контракты + чёрный ящик + что меняется в тестах); правило в
  PORTABLE.md Wave 2 + orchestrator.md + skill. Этот proposal — первый
  носитель секции.
- **Enrich-дамп (R03)**: новый шаг Wave 1 — инженер выгружает контекст из
  головы (подводные камни, как бы реализовал) ДО research; правило в
  PORTABLE.md + orchestrator.md; дамп фиксируется в manifest ченджа.
- **Criticality (R04)**: поле `criticality: core|supporting|generic` в
  manifest (вне R##-таблицы, парсер не трогаем); калибровка строгости
  oracle (core = полный прогон + запуск продукта, supporting = выборочно,
  generic = быстрый просмотр при зелёных гейтах); правило в oracle.md.
- **Reviewer KB (R05)**: границы reviewer.md требуют проверки против
  CONTEXT.md + interfaces.md ченджа (+ docs/adr/ когда заведём);
  вердикт без ссылок на БЗ недействителен.
- **SAST (R06)**: шаг `npm audit --audit-level=high` (+ osv-scanner, если
  дёшево) в repo-gate.yml; semgrep только если zero-config на JS;
  `--no-audit` в install-шагах остаётся (скорость), но аудит покрывается
  отдельным шагом.
- **Design gate (R07)**: `design` в WAIT_KINDS workflow.mjs + протокол:
  перед Wave 3 оркестратор ставит `workflow ask design` и задаёт
  подтверждение через ask-виджет; фан-аут только после `answered`.
- **Dashboard (R08)**: `tools/brief.mjs` в sync-manifest.json (+ тест, что
  каждый импорт dashboard.mjs резолвится из манифеста).

## QA-план
Контракты: (1) `openspec validate video-rules-adoption --strict` exit 0;
(2) `workflow artifact --kind openspec --path openspec/changes/video-rules-adoption`
принимает чендж; (3) существующие гейты (code-size, clone, eslint,
quality) остаются зелёными. Чёрный ящик: свежий клон + `npm ci` → каждый
новый CI-шаг запускается локально той же командой и даёт тот же вердикт.
Меняется в тестах: +тесты sync-manifest покрытия импортов dashboard;
мутационный CLI покрыт существующими тестами; парсер manifest не
меняется (тесты не трогаем). QA-check после имплементации: сверить
фактические команды CI с задокументированными.

## Non-Goals
- CRAP-метрика (нет coverage-инфры; COCO-гейт остаётся).
- Прод-метрики CFR/MTTR и DAST (прод-сервиса нет).
- Multi-target в mutation-test.mjs (только wrapper-цикл).
- Новые транспорты/маршруты review-run, переписывание workflow.mjs.
