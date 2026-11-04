# Manifest — s2-dashboard

Source: user "Давай, так же давай сделаем рефакторинг и улучшение чтобы у нас был красивый и поддерживаемый код. И все работало" (2026-11-04) + program manifest R01+R02.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Красивый поддерживаемый код: хотспоты к потолкам с запасом, stage B | "красивый и поддерживаемый код" | in-spec |
| R02 | Всё работает: ноль поведения, тесты заморожены, гейты зелёные | "все работало" | in-spec |

## Constraints

- C1: dashboard-ui.mjs ≤ 1570 с запасом ≥ 5% (вынос arch tab в client-модуль по defer-триггеру).
- C2: dashboard-collectors.mjs удержать ≤ 1697.
- C3: dashboard.test.mjs → ≤ 1800, benchmark.test.mjs → ≤ 1200 (сплит файлов тестов без потери покрытия).
- C4: Поведение рендера байт-в-бит: HTML-снапшот до/после идентичен.
- C5: Замороженные тесты зелёные; baseline обновляется только для s2-строк.
- C6: Spend через ledger ($0 model calls для слайса S2).
