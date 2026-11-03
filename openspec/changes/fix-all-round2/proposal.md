# fix-all-round2 — proposal

## Why
T1-аудит (`.tmp/recon-workflow-problems.md`, 2026-11-01) нашёл 2 дефекта
и 9 отставаний с живыми измерениями: cfr-report врёт молча (дефолт 0/0
при истине 8/10), дашборд недоступен из Paseo (timeout при curl 200),
нет lifecycle-evals процесса, 409-локов, settlement, телеметрии; каталог
236 скиллов при 172 мёртвых; workflow.mjs 2388/2500. T2-перепроверка
(2026-11-03): CFR-истина 174.19% (30d), dash отвечает 7.56s, drift 80/131.
Пользователь: "чини по порядку". Wave 0 зафиксировал скоупы: evals-минимум,
settlement-с-подтверждением, parity-без-чистки, blind-only-норма, A4 вне скоупа.

## What Changes
- **D1 (R01)**: `cfr-report.mjs`: нормализация `7d`→`7.days.ago` + fail-loud
  на пустом логе при непустом репо + тесты.
- **D2 (R02)**: дашборд из Paseo: ускорение первого байта и/или bind/URL,
  acceptance — открытие из Paseo-браузера.
- **A1 (R03)**: NEW `tools/lifecycle-evals.mjs` + CI-шаг: pickup→409-backoff→
  approval→deny, детерминированные кейсы.
- **A2 (R04)**: claims.mjs execution-lock (409 на двойной claim) + `settle`
  с явным confirm для уборки worktree/веток.
- **A3 (R05)**: parity-решение live-vs-repo: доки + интерпретируемый check,
  без prune и каталога.
- **A5 (R06)**: NEW локальный JSONL-счётчик срабатываний гейтов/ролей.
- **B1 (R07)**: workflow.mjs: снижение или план сплита (тикет #16).
- **B2 (R08)**: GATES.md: правило сплит-vs-ресид.
- **B3 (R09)**: blind-oracle-only — норма для обычных T2 (PORTABLE §5).
- **B4 (R10)**: install reuse prepared storage.

## QA-план
Контракты: (1) `openspec validate fix-all-round2 --strict` exit 0;
(2) каждый кодовый фикс: red-before/green-after (тест или команда);
(3) существующие гейты зелёные (node COCO, eslint, size, clone).
Чёрный ящик: CFR-дефолт воспроизводим; дашборд из Paseo; lifecycle-evals
зелён в CI; двойной claim → 409.
Меняется в тестах: +cfr интервал/fail-loud; +claims 409/settle;
+lifecycle сьют; +счётчик; +install reuse. QA-check: A1–A10 из manifest.

## Non-Goals
- A4 память/Hindsight — вне скоупа (Wave 0: "Оставить как есть").
- Promptfoo-паритет evals (только lifecycle-ядро).
- Skills prune / lazy-каталог (только parity).
- Авто-уборка worktree без подтверждения.
- Сплит workflow.mjs кодом (только если влезет; иначе план).
- Новые гейты сверх счётчика — только чинка найденного.
