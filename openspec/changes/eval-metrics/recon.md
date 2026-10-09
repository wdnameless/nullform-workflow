# Recon: eval-метрики (видео bFHCK6PB0hA)

Источник: `context/product/video-agent-evals.srt` (автосубтитры RU, 4124 строки, 37 мин).
Тезисы: агент = 4 объекта (harness/модель/память/тулы); одиночный прогон ничего не значит;
pass@k (решил хоть раз) + pass^k (решил все K); детерминированные проверки → LLM-судья →
агент-судья; record/replay обвязки ($0/коммит) + живой сьют (PR/релиз); regression smoke
10 задач × 5, правило «0/5 при 5/5 на main = красный PR»; fail-taxonomy из реальных логов.

## Факты нашего bench (проверено чтением кода)
- `tools/benchmark.mjs`: `--runs/-n` ЕСТЬ (parseArgs:1272-1278, цикл runBenchmark:558-568, валидация ≥1).
  НЕТ агрегации pass@k/pass^k: report/compare показывают медианы (formatReport, compareArms:991+).
- `bench/tasks.json`: 4 задачи, все tier safety. Смок-набора 10×5 нет.
- Запись LM-ответов: `replay.mjs` — только HTTP-кассеты; LM record/replay нет.
- Oracle — уже «агент-судья с тулами»; калибровки по людям (каппа) нет.

## Файлы под изменение
- П.1: tools/benchmark.mjs (summarize/compare + format) + tools/tests/benchmark.test.mjs.
- П.2: bench/tasks.json (+6 задач из fail-taxonomy) + .github/workflows/repo-gate.yml (смок-джоба).
- П.3: tools/replay.mjs (расширение на LM) или новый tools/lm-replay.mjs + тесты.
- П.4: процедура калибровки (docs/ + скрипт подсчёта каппы) + 20–30 размеченных сессий.

## Acceptance check
- П.1: `benchmark.mjs report/compare` показывает pass@k и pass^k; `--runs 5` + тест с фиктивными ранами.
- П.2: 10 задач в tasks.json; CI-джоба краснеет по правилу 0/5-vs-5/5.
- П.3: record сохраняет LM-ответы; replay-прогон $0 и детерминирован.
- П.4: каппа oracle-vs-human посчитана и записана; порог калибровки зафиксирован.
