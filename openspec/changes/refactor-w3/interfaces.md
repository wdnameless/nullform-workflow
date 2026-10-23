# Interfaces — refactor-w3

## Владение (зоны disjoint)
- D01: `tools/doctor.mjs` (thin runDoctor), `tools/doctor-checks.mjs` (new).
- B01: `tools/benchmark.mjs` (ядро + роутер), `tools/bench-analytics.mjs` (new),
  `tools/bench-smoke.mjs` (new).
- Parent: openspec/, .workflow/, сьют, oracle. Тесты — читают оба, правит parent.

## Границы
| Граница | Контракт |
|---------|----------|
| runDoctor → checks | `checkX(ctx) => {id, status, detail}`; ctx = {harness, agentDir, agentsHome, userHome, projectRoot, profile, env, mode, probeResults, releaseInfo, runOmp}; порядок вызовов = порядок id |
| benchmark фасад | `loadTasks, runBenchmark, summarizeRuns, compareArms, runSmoke, validateTasks` + остальные тестовые импорты — из benchmark.mjs (прямо или реэкспорт) |
| CLI | `doctor.mjs --json`, `benchmark.mjs` сабкоманды — golden match |

## Сигнатуры
- Без новых публичных API кроме doctor-checks (внутренние, но exported для тестов).
