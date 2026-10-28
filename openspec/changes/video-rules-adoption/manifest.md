# Manifest — video rules adoption (Березницкий) + dashboard fix

Source: user "Делай и чини все" (2026-10-28, on prior analysis of video
RUSslI9Ahl4 "Как остаться инженером, когда весь код пишет AI") + standing
goal "универсальный инструмент который будет повышать качество, точность
и скорость разработки".

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Мутационные тесты работают в CI-гейте, а не только как ручной инструмент | "Делай и чини все" | in-spec |
| R02 | T2 proposal содержит QA-план (контракты + чёрный ящик) до нарезки задач | "Делай и чини все" | in-spec |
| R03 | Wave 1 включает enrich-дамп: инженер выгружает подводные камни до research | "Делай и чини все" | in-spec |
| R04 | Manifest несёт критичность (core/supporting/generic), oracle калибрует строгость | "Делай и чини все" | in-spec |
| R05 | Reviewer судит против курируемой БЗ (CONTEXT/interfaces/ADR), а не «по модели» | "Делай и чини все" | in-spec |
| R06 | CI включает SAST (npm audit/osv + semgrep), audit больше не отключён молча | "Делай и чини все" | in-spec |
| R07 | Wave 3 не стартует без аппрува дизайна человеком (пауза + подтверждение) | "Делай и чини все" | in-spec |
| R08 | Дашборд стартует без ERR_MODULE_NOT_FOUND (brief.mjs доезжает в инсталл) | "Делай и чини все" | in-spec |

## Constraints (recon facts)

- C1: mutation-test.mjs CLI принимает один --target, скопа к changed files нет;
  цена = N_mutants × T_suite, запуск синхронный (нужен wrapper + бюджет мутантов).
- C2: canonical proposal = Why/What/Non-Goals (PORTABLE.md:58-64); QA-план —
  новая секция конвенции, схемы нет.
- C3: manifest-парсер (requirements.mjs:58-131) не знает severity; формат строк R##
  валидируется workflow.mjs:997-1014 — criticality не должна ломать парсер.
- C4: docs/adr/ в репо НЕТ; R05 не может ссылаться на несуществующие ADR без их заведения.
- C5: reviewer.md — prompt surface; правка одобрена фразой «делай все».
- C6: пауза уже есть (workflow.mjs cmdAsk L1515-1551, WAIT_KINDS L1511,
  cmdAnswered L1554-1575); команды approve нет.
- C7: brief.mjs есть в дереве, но отсутствует в tools/sync-manifest.json —
  корень R08.
- C8: openspec validate требует proposal.md + tasks.md + непустой specs/
  и `openspec validate <id> --strict` exit 0.

## Acceptance (observable)

- A1: `node tools/mutation-test.mjs --target <file> --check` падает/проходит
  по threshold; в repo-gate.yml есть шаг мутационного гейта на изменённых файлах.
- A2: proposal.md этого ченджа содержит раздел QA-план; протокол Wave 2 требует его.
- A3: протокол Wave 1 требует enrich-дамп до research; manifest ченджа фиксирует дамп.
- A4: manifest ченджа содержит поле criticality; oracle.md ченджа калибрует строгость по нему.
- A5: reviewer.md ссылается на CONTEXT.md + interfaces.md ченджа; ревью без БЗ запрещено текстом роли.
- A6: repo-gate.yml запускает npm audit/osv/semgrep; `--no-audit` без замены не остаётся.
- A7: протокол требует `workflow ask plan/design` + подтверждение перед Wave 3;
  WAIT_KINDS знает дизайн-паузу.
- A8: `node tools/workflow.mjs start` поднимает дашборд без ERR_MODULE_NOT_FOUND;
  brief.mjs есть в sync-manifest.json.
- A9: Все существующие гейты зелёные (code-size, clone, eslint, quality).
