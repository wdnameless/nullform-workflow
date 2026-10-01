# JEV Automatic Assistance & Evaluation Guide / Руководство по JEV-ассистенту и оценке

---

## English

### Overview

JEV Automatic Assistance brings native, automated skill suggestion to NULLFORM WORKFLOW on top of Oh My Pi (OMP 18.4.4+). Powered by OpenRouter Decisions (`typesafe/jev-1.13`), it assists agent turns with relevant skill hints without altering canonical prompts, role contracts, models, permissions, or Oracle gates.

**User Scope & Dropped Routing**:
Following user decision («Только подсказки навыков»), automatic subagent model routing was completely removed from the release scope rather than left dormant. Previous v1 experimental evaluations showed that model routing achieved only 3/8 primary acceptances with 5 costly recoveries, resulting in higher net spend ($0.0281 unknown/extra spend, calib-10 HTTP 502) and zero demonstrated savings. Historical v1 reports remain negative experiment evidence and cannot activate v2 assistance.

Key principles:
1. **Engineering Judgment First**: Cost reduction is never permission to skip checks or downgrade high-risk tasks.
2. **Zero Plaintext Secrets**: API credentials reside exclusively in the OS native vault (`Bun.secrets`) or environment variables (`OPENROUTER_API_KEY`).
3. **Screening Before Dispatch**: Task prompts are inspected for synthetic and real credentials, private keys, or PII before any external network request. Blocked canaries produce zero network traffic.
4. **Autonomous Operation**: Once activated via `tools/jev-control.mjs enable`, assistance runs automatically in background OMP hooks without per-task operator commands.

### Safety Invariants & Bounded Scope

- **Skills-Only Suggestions**: Turns receive bounded skill recommendations at confidence $\ge 0.80$ when supported by validated v2 empirical proof.
- **Unchanged Models & System Prompts**: System prompts, execution models, and subagent tiers remain completely untouched.
- **Zero Silent Fallback**: If an API error, rate limit, quota exhaustion, or malformed response occurs, the system defaults immediately to baseline execution.

### Architecture & Module Graph

- `tools/jev-evidence.mjs`: Pure shared evidence module. Exports `policyFingerprint({ catalogFingerprint, baselineModel, decisionModel })`, `loadEvaluationDatasetContext`, and `evaluateReport(report, { datasetContext })` (raw hurdle validator enforcing canonical 64-hex SHA-256 dataset hashes, exact 14 calibration + 44 held-out case IDs/gold/safety canary flags, `errors === 0`, and `unknownSpendUsd === 0`). Zero dependencies on runtime or CLI modules.
- `tools/jev-evaluation-cases.mjs`: Deep paid case execution helpers. Implements `executeChatCall` (with finish_reason length and usage cost checks), `executeSkillCase` (interleaved skill matching, canary blocking, confidence evaluation).
- `tools/jev-evaluate.mjs`: Paired empirical evaluation CLI, budget reservation orchestrator, and Report v2 builder.
- `tools/jev-control.mjs`: Local policy lifecycle CLI (`status`, `enable`, `disable`). Pure offline validation. Only activates on valid v2 report.
- `tools/jev-assist.mjs`: Core runtime assistance module (`readCredential`, `loadSkillCatalog`, `screenTask`, `decide`, `readPolicy`, `appendEvent`).
- `agent/extensions/nullform-jev.ts`: Native OMP extension hooks for turn suggestions (`before_agent_start`).

### Paired Empirical Evaluation (`tools/jev-evaluate.mjs`)

The evaluation runner executes a reproducible, paired comparison between:
- **Baseline Skill Arm**: Pinned chat model (`google/gemini-3.8-flash`, observed catalog rate: $0.75/M input, $3.75/M output) prompted with the effective skill catalog.
- **Candidate Skill Arm**: JEV typed decisions endpoint (`typesafe/jev-1.13`).

#### Authoritative Native Skill Catalog Snapshot
Live evaluation and control activation accept `--catalog <path>` (e.g., `--catalog .tmp/jev-native-catalog.json`) to use an authoritative metadata snapshot of installed native skills:
- **Normal Configured Session (89 skills)**: Standard startup discovery with normal extension discovery captures the full 89 installed skills, preserving namespaces (`omp:`, plugins like `ponytail`, `pi-lens`), descriptions, and disabled skill precedence without reading file bodies or leaking contents.
- **Restricted Discovery Probe (78 skills)**: An earlier restrictive discovery probe excluded plugin-provided skills; the evaluation explicitly distinguishes this probe from the normal configured 89-record catalog snapshot.

#### Dataset Construction & Calibration Separation
- **Calibration Set**: 14 independently constructed reference cases used for baseline verification.
- **Held-out Set**: 44 independently constructed RU/EN cases (zero prompt overlap with calibration) ensuring generalization across languages and domains.
- **Dataset Integrity**: SHA-256 hashes of calibration and heldout fixtures are recorded in Report v2.

#### Accounting & Budget Invariants
- **JEV Decision Pricing**: `typesafe/jev-1.13` uses the published rate ($0.042/M tokens = $0.000000042/token) with bounded request reservation.
- **Conservative Reservation**: Token reservations are computed from UTF-8 byte lengths of full serialized payloads. The `max_tokens` limit covers reasoning tokens without double-counting.
- **Usage Accounting & Fallback Errors**: Missing or invalid `usage.cost` triggers an incomplete error rather than fabricating zero cost. Fallback API errors increment `totalErrors` while retaining rows and unknown-spend reserves.
- **Valid Decisions vs Abstention**: A valid high-confidence `none` prediction ($\ge 0.80$) counts as an attempted classifier decision; low-confidence output ($< 0.80$) is counted as abstention.

#### Hurdle Requirements for Activation
- **Safety**: 0 safety misses (100% of canary secrets blocked before network).
- **Skill Quality**: 0 critical misses, $\ge 70\%$ attempt coverage, and $\ge 95\%$ attempted precision (must be no worse than baseline precision).
- **Decision Cost**: Measured candidate decision cost lower than baseline OR demonstrated higher accuracy.

#### Running Evaluation
```bash
# Verify fixtures and catalog fingerprint offline
node tools/jev-evaluate.mjs --fixture-only

# Verify with authoritative native catalog snapshot
node tools/jev-evaluate.mjs --fixture-only --catalog .tmp/jev-native-catalog.json

# Run paired live evaluation within $1 hard spend cap
bun tools/jev-evaluate.mjs \
  --root . \
  --catalog .tmp/jev-native-catalog.json \
  --baseline google/gemini-3.8-flash \
  --max-cost-usd 1.0 \
  --output "$HOME/.omp/agent/jev-evaluation.json"
```

### Local Control CLI (`tools/jev-control.mjs`)

Manages local activation state in `~/.omp/agent/jev-policy.json`. CLI commands perform pure local validation and emit zero network calls.

```bash
# Check current activation and proof status
node tools/jev-control.mjs status

# Enable assistance by validating report SHA-256, hurdles, and catalog snapshot
node tools/jev-control.mjs enable \
  --report "$HOME/.omp/agent/jev-evaluation.json" \
  --catalog .tmp/jev-native-catalog.json

# Disable assistance (reverts immediately to standard baseline behavior)
node tools/jev-control.mjs disable
```

### Measured Scope, Opt-Out & Non-Claims

- **Measured Benefit**: Cost reductions and skill precision are proven solely for skill suggestion on the evaluated pair (`google/gemini-3.8-flash` baseline vs `typesafe/jev-1.13` decision classifier).
- **Default Inactive & Safe Failure**: JEV assistance is inactive by default (`unconfigured`). An interrupted, partial, or failed evaluation run leaves assistance disabled and does not constitute evidence of utility. Activation strictly requires a completed v2 evaluation report passing all hurdles.
- **Immediate Opt-Out**: Disabling assistance via `node tools/jev-control.mjs disable` sets `enabled: false` in `~/.omp/agent/jev-policy.json`. OMP hooks immediately bypass JEV and execute baseline turns without restarting the agent or altering project files.
- **No Blanket Claims**: This evaluation does NOT claim whole-workflow speedups, human productivity gains, or cost savings on flat-rate subscription models. No utility is claimed prior to live proof validation.

---

## Русский

### Обзор

JEV-ассистент обеспечивает автоматический подбор навыков в NULLFORM WORKFLOW поверх OMP 18.4.4+. В основе лежит эндпоинт OpenRouter Decisions (`typesafe/jev-1.13`), добавляющий подсказки навыков без изменения канонических промптов, ролей, моделей, прав доступа и гейтов Оракула.

**Объём работ и отказ от маршрутизации**:
По прямому выбору пользователя («Только подсказки навыков»), автоматическая маршрутизация моделей подзадач полностью исключена из релиза. Предыдущие эксперименты v1 показали, что маршрутизация моделей достигла лишь 3/8 первичных успешных выполнений при 5 дорогостоящих повторных вызовах (recovery), что привело к росту общих затрат (включая неопределённые расходы $0.0281 и HTTP 502 на calib-10) и отсутствию реальной экономии. Исторические отчёты v1 сохраняются как свидетельства отрицательного результата и не могут активировать v2.

Ключевые принципы:
1. **Инженерный контроль превыше экономии**: снижение стоимости не может служить поводом для снижения требований к безопасности или упрощения сложных задач.
2. **Никаких секретов в коде и отчётах**: API-ключи хранятся только в защищённом хранилище ОС (`Bun.secrets`) или переменных окружения (`OPENROUTER_API_KEY`).
3. **Фильтрация до отправки**: любой промпт проверяется на наличие секретов, токенов, ключей и персональных данных. Тестовые канарейки не порождают сетевых запросов.
4. **Автономность**: после однократной активации через `tools/jev-control.mjs enable`, подсказки навыков выполняются прозрачно через нативные хуки OMP.

### Ограничения и безопасность

- **Только подсказки навыков**: в промпт добавляются подсказки релевантных навыков при уверенности $\ge 0.80$ и наличии валидного доказательства v2.
- **Модели и системные промпты неизменны**: системные промпты, используемые модели и уровни субагентов остаются в исходном виде.
- **Мгновенный fallback**: при сетевых сбоях, таймаутах, лимитах провайдера или некорректных ответах классификатора задача выполняется стандартным образом.

### Архитектура и граф модулей

- `tools/jev-evidence.mjs`: чистый модуль доказательств. Экспортирует `policyFingerprint({ catalogFingerprint, baselineModel, decisionModel })`, `loadEvaluationDatasetContext` и `evaluateReport(report, { datasetContext })` (проверка порогов по сырым знаменателям, канонических 64-символьных SHA-256 хэшей набора, ID кейсов 14 калибровки + 44 отложенной выборки, эталонных ответов, флагов канареек, `errors === 0` и `unknownSpendUsd === 0`). Не зависит от рантайма и CLI.
- `tools/jev-evaluation-cases.mjs`: хелперы выполнения платных кейсов (`executeChatCall`, `executeSkillCase` с чередованием запросов и блокировкой канареек).
- `tools/jev-evaluate.mjs`: CLI парного бенчмарка, контроль лимита расходов и построитель Report v2.
- `tools/jev-control.mjs`: локальное управление политикой (`status`, `enable`, `disable`) без обращения к сети.
- `tools/jev-assist.mjs`: базовый модуль содействия (`readCredential`, `loadSkillCatalog`, `screenTask`, `decide`, `readPolicy`, `appendEvent`).
- `agent/extensions/nullform-jev.ts`: нативные хуки расширения OMP для подсказки навыков (`before_agent_start`).

### Парный бенчмарк (`tools/jev-evaluate.mjs`)

Инструмент оценки запускает воспроизводимое парное тестирование:
- **Базовое плечо навыков**: чат-модель (`google/gemini-3.8-flash`, каталожные цены: $0.75/M ввод, $3.75/M вывод) с полным каталогом эффективных навыков.
- **Кандидат навыков**: типизированный классификатор JEV (`typesafe/jev-1.13`).

#### Авторитетный снимок каталога нативных навыков
Оценка и активация поддерживают параметр `--catalog <путь>` (например, `--catalog .tmp/jev-native-catalog.json`), позволяющий использовать снимок метаданных нативных навыков:
- **Штатная конфигурация сессии (89 навыков)**: стандартный запуск с поиском расширений включает все 89 установленных навыков, сохраняя пространства имён (`omp:`, плагины `ponytail`, `pi-lens`), описания и правила отключённых навыков без чтения тел файлов.
- **Ограниченный зонд (78 навыков)**: изолированный запуск без плагинов исключал плагинные навыки; документация чётко разделяет тестовый зонд (78) и штатную конфигурацию (89).

#### Разделение калибровки и отложенной выборки
- **Калибровочный набор**: 14 независимых кейсов для настройки промптов и базовой валидации.
- **Отложенная выборка (Held-out)**: 44 независимых RU/EN кейса без пересечения с калибровочными промптами.
- **Хэширование данных**: SHA-256 фикстур фиксируются в Report v2.

#### Учёт расходов и резервирование бюджета
- **Цены JEV**: для `typesafe/jev-1.13` используется опубликованная ставка ($0.042/M токенов) с фиксированным резервом.
- **Консервативный резерв**: токены рассчитываются по объёму UTF-8 байт сериализованного запроса; лимит `max_tokens` учитывает токены рассуждений (reasoning) без двойного счёта.
- **Учёт отсутствующей стоимости и ошибок**: при отсутствии `usage.cost` возвращается ошибка. Ошибки fallback увеличивают счётчик `totalErrors` при сохранении строк в отчёте.
- **Валидные решения и воздержание**: уверенный ответ `none` ($\ge 0.80$) считается попыткой классификатора; ответ с низкой уверенностью ($< 0.80$) считается воздержанием (abstention).

#### Критерии допуска (Hurdles)
- **Безопасность**: 0 пропусков канареек (100% блокировка секретов до отправки).
- **Качество навыков**: 0 критических ошибок, покрытие $\ge 70\%$, точность попыток $\ge 95\%$ (не ниже базовой).
- **Стоимость классификатора**: суммарная стоимость решений JEV ниже стоимости базовой модели либо продемонстрирован более высокий уровень правильных ответов.

#### Запуск оценки
```bash
# Проверка фикстур и каталога в офлайн-режиме
node tools/jev-evaluate.mjs --fixture-only

# Проверка со снимком нативного каталога
node tools/jev-evaluate.mjs --fixture-only --catalog .tmp/jev-native-catalog.json

# Полный парный прогон в рамках жесткого лимита $1
bun tools/jev-evaluate.mjs \
  --root . \
  --catalog .tmp/jev-native-catalog.json \
  --baseline google/gemini-3.8-flash \
  --max-cost-usd 1.0 \
  --output "$HOME/.omp/agent/jev-evaluation.json"
```

### Управление политикой (`tools/jev-control.mjs`)

Управляет локальным файлом политики `~/.omp/agent/jev-policy.json` без обращения к сети.

```bash
# Проверить статус политики и валидность отчёта
node tools/jev-control.mjs status

# Активировать ассистента с проверкой хэша SHA-256 и порогов качества
node tools/jev-control.mjs enable \
  --report "$HOME/.omp/agent/jev-evaluation.json" \
  --catalog .tmp/jev-native-catalog.json

# Отключить ассистента (мгновенный возврат к стандартному базовому поведению)
node tools/jev-control.mjs disable
```

### Границы применимости и отказ от использования

- **Измеренная польза**: доказанная точность и затраты относятся строго к подбору навыков парой `google/gemini-3.8-flash` и классификатора `typesafe/jev-1.13`.
- **Отключён по умолчанию и безопасный отказ**: ассистент по умолчанию не активен (`unconfigured`). Прерванный, частичный или завершившийся ошибкой прогон оставляет ассистента отключённым и не является доказательством пользы. Для активации необходим полностью завершённый отчёт v2, прошедший все барьеры качества.
- **Мгновенный отказ (Opt-Out)**: команда `node tools/jev-control.mjs disable` устанавливает `enabled: false` в файле политики. Хуки OMP немедленно прекращают добавление подсказок без перезапуска системы.
- **Без необоснованных утверждений**: отчёт не делает заявлений об ускорении всего сквозного процесса разработки или об экономии на подписочных тарифах с фиксированной платой. До живого подтверждения отчётом польза не декларируется.
