# JEV Automatic Assistance & Evaluation Guide / Руководство по JEV-ассистенту и оценке

---

## English

### Overview

JEV Automatic Assistance brings native, automated skill suggestion and bounded subagent model routing to NULLFORM WORKFLOW on top of Oh My Pi (OMP 18.4.4+). Powered by OpenRouter Decisions (`typesafe/jev-1.13`), it assists agent turns without altering canonical prompts, role contracts, or Oracle gates.

Key principles:
1. **Engineering Judgment First**: Cost reduction is never permission to skip checks or downgrade high-risk tasks.
2. **Zero Plaintext Secrets**: API credentials reside exclusively in the OS native vault (`Bun.secrets`) or environment variables (`OPENROUTER_API_KEY`).
3. **Screening Before Dispatch**: Task prompts are inspected for synthetic and real credentials, private keys, or PII before any external network request. Blocked canaries produce zero network traffic.
4. **Autonomous Operation**: Once activated via `tools/jev-control.mjs enable`, assistance runs automatically in background OMP hooks without per-task operator commands.

### Safety Invariants & Bounded Scope

- **Protected Roles Retain Baseline**: Roles including `oracle`, `reviewer`, `security-reviewer`, `orchestrator`, `designer`, `fixer`, and `librarian` never use cheap models.
- **Leaf Archetypes Only**: Model routing is permitted exclusively for narrow, self-contained leaf tasks evaluated in the benchmark:
  - `lookup` (reference tables, status codes, MIME types, specs)
  - `json-transform` (reshaping, filtering, aggregating structured data)
  - `formatting` (markdown lists, dates, normalized tables)
  - `text-normalization` (slugification, whitespace cleanup, identifier normalization)
- **Zero Silent Fallback**: If an API error, rate limit, quota exhaustion, or malformed response occurs, the system defaults immediately to baseline execution.
### Architecture & Module Graph

- `tools/jev-evidence.mjs`: Pure shared evidence module. Exports `policyFingerprint`, `checkOutcomeMatch` (using Node stdlib `isDeepStrictEqual` for structural JSON comparison), `loadEvaluationDatasetContext`, and `evaluateReport(report, { datasetContext })` (raw hurdle validator enforcing canonical 64-hex SHA-256 dataset hashes, exact case IDs/gold/safety canary flags, and `unknownSpendUsd === 0`). Zero dependencies on runtime or CLI modules.
- `tools/jev-evaluation-cases.mjs`: Deep paid case execution helpers. Implements `executeChatCall` (with finish_reason length and usage cost checks), `executeSkillCase` (interleaved skill matching and canary blocking), and `executeRoutingCase` (leaf routing and assisted recovery).
- `tools/jev-evaluate.mjs`: Paired empirical evaluation CLI, budget reservation orchestrator, and Report v1 builder.
- `tools/jev-control.mjs`: Local policy lifecycle CLI (`status`, `enable`, `disable`). Pure offline validation.
- `tools/jev-assist.mjs`: Core runtime assistance module (`readCredential`, `loadSkillCatalog`, `screenTask`, `decide`, `readPolicy`, `appendEvent`).
- `agent/extensions/nullform-jev.ts`: Native OMP extension hooks for turn suggestions and subagent routing.

### Paired Empirical Evaluation (`tools/jev-evaluate.mjs`)

The evaluation runner executes a reproducible, paired comparison between:
- **Baseline Skill Arm**: Pinned chat model (`google/gemini-3.8-flash`, observed catalog rate: $0.75/M input, $3.75/M output) prompted with the effective skill catalog.
- **Candidate Skill Arm**: JEV typed decisions endpoint (`typesafe/jev-1.13`).
- **Leaf Task Outcomes**: Baseline model vs candidate model (`google/gemini-3.1-flash-lite`, observed catalog rate: $0.25/M input, $1.50/M output) across deterministic outcome fixtures with fallback recovery.

#### Authoritative Native Skill Catalog Snapshot
Live evaluation and control activation accept `--catalog <path>` (e.g., `--catalog .tmp/jev-native-catalog.json`) to use an authoritative metadata snapshot of installed native skills:
- **Normal Configured Session (89 skills)**: Standard startup discovery with normal extension discovery captures the full 89 installed skills, preserving namespaces (`omp:`, plugins like `ponytail`, `pi-lens`), descriptions, and disabled skill precedence without reading file bodies or leaking contents.
- **Restricted Discovery Probe (78 skills)**: An earlier restrictive discovery probe excluded plugin-provided skills; the evaluation explicitly distinguishes this probe from the normal configured 89-record catalog snapshot.

#### Dataset Construction & Calibration Separation
- **Calibration Set**: 14 independently constructed reference cases used for prompt design and baseline verification.
- **Held-out Set**: 44 independently constructed RU/EN cases (zero prompt overlap with calibration) ensuring generalization across languages and domains.
- **Deterministic Outcomes**: 10 outcome cases across all 4 leaf archetypes with exact expected outputs (8 allowed transformations + 2 synthetic secret no-network canaries).
- **Constructed Labels & Anti-Echo Guard**: Outcome task prompts explicitly omit expected answer literals to measure genuine transformation ability rather than trivial verbatim echo. Outcome 08 replaces phone PII with harmless Russian text normalization (whitespace collapse and lowercasing).
- **Dataset Integrity**: SHA-256 hashes of calibration, heldout, and outcome fixtures are recorded in Report v1.

#### Accounting & Budget Invariants
- **Pricing Verification**: Exact catalog prices are observed for baseline (`google/gemini-3.8-flash`) and candidate (`google/gemini-3.1-flash-lite`) before live evaluation.
- **JEV Decision Pricing**: `typesafe/jev-1.13` is not present in the public `/models` endpoint; it uses the published input rate ($0.042/M tokens = $0.000000042/token, verified by synthetic token cost accounting) with a documented bounded request reserve rather than fabricating a false observed-price claim.
- **Conservative Reservation**: Token reservations are computed from UTF-8 byte lengths of full serialized payloads. The `max_tokens` limit covers reasoning tokens without double-counting.
- **Usage Accounting & Fallback Errors**: Missing or invalid `usage.cost` triggers an incomplete error rather than fabricating zero cost. Fallback API errors increment `totalErrors` while retaining rows and unknown-spend reserves.
- **Primary vs Recovery**: Candidate outcomes only attempt cheap execution when the JEV classifier approves cheap routing for an allowed leaf archetype; otherwise, baseline recovery runs with `candidatePrimaryAttempted = false`. Fallback successes are counted strictly as assisted recovery.

#### Hurdle Requirements for Activation
- **Safety**: 0 safety misses (100% of canary secrets blocked before network).
- **Skill Quality**: 0 critical misses, $\ge 70\%$ attempt coverage, and $\ge 95\%$ attempted precision (must be no worse than baseline precision). No-skill prediction `none` is counted as a valid attempt.
- **Decision Cost**: Measured candidate cost lower than baseline OR demonstrated higher accuracy.
- **Routing Quality**: Primary cheap accepted outcomes $\ge$ baseline accepted count, with lower total cost per accepted outcome.

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
  --candidate google/gemini-3.1-flash-lite \
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

- **Measured Benefit**: Cost reductions and skill precision are proven solely for the evaluated model pair (`google/gemini-3.8-flash` vs `google/gemini-3.1-flash-lite`) and the 4 declared leaf archetypes.
- **Default Inactive & Safe Failure**: JEV assistance is inactive by default (`unconfigured`). An interrupted, partial, or failed evaluation run (e.g., transport fault or quota error mid-flight) leaves assistance disabled and does not constitute evidence of utility. Activation strictly requires a completed evaluation report passing all hurdles.
- **Immediate Opt-Out**: Disabling assistance via `node tools/jev-control.mjs disable` sets `enabled: false` in `~/.omp/agent/jev-policy.json`. OMP hooks immediately bypass JEV routing and execute baseline prompts without restarting the agent or altering project files.
- **No Blanket Claims**: This evaluation does NOT claim whole-workflow speedups, human productivity gains, or cost savings on flat-rate subscription models. No utility is claimed prior to live proof validation.
---

## Русский

### Обзор

JEV-ассистент обеспечивает автоматический подбор навыков и контролируемую маршрутизацию простых подзадач на экономичные модели в NULLFORM WORKFLOW поверх OMP 18.4.4+. В основе лежит эндпоинт OpenRouter Decisions (`typesafe/jev-1.13`), работающий без изменения канонических промптов, ролей и гейтов Оракула.

Ключевые принципы:
1. **Инженерный контроль превыше экономии**: снижение стоимости не может служить поводом для снижения требований к безопасности или упрощения сложных задач.
2. **Никаких секретов в коде и отчётах**: API-ключи хранятся только в защищённом хранилище ОС (`Bun.secrets`) или переменных окружения (`OPENROUTER_API_KEY`).
3. **Фильтрация до отправки**: любой промпт проверяется на наличие секретов, токенов, ключей и персональных данных. Тестовые канарейки не порождают сетевых запросов.
4. **Автономность**: после однократной активации через `tools/jev-control.mjs enable`, подсказки и маршрутизация выполняются прозрачно через нативные хуки OMP.

### Ограничения и безопасность

- **Защищённые роли не понижаются**: роли `oracle`, `reviewer`, `security-reviewer`, `orchestrator`, `designer`, `fixer` и `librarian` всегда работают на базовых полноразмерных моделях.
- **Только проверенные листовые архетипы**: маршрутизация на экономичные модели разрешена исключительно для узких самодостаточных задач:
  - `lookup` (поиск в таблицах, коды ответов, MIME-типы, стандарты)
  - `json-transform` (фильтрация, маппинг, агрегация JSON-структур)
  - `formatting` (форматирование таблиц, списков markdown, дат)
  - `text-normalization` (слаги, нормализация пробелов, идентификаторов)
- **Мгновенный fallback**: при сетевых сбоях, таймаутах, лимитах провайдера или некорректных ответах классификатора задача мгновенно возвращается на базовую модель.
### Архитектура и граф модулей

- `tools/jev-evidence.mjs`: чистый модуль доказательств. Экспортирует `policyFingerprint`, `checkOutcomeMatch` (структурное сравнение JSON через `isDeepStrictEqual` из Node stdlib), `loadEvaluationDatasetContext` и `evaluateReport(report, { datasetContext })` (проверка порогов по сырым знаменателям, канонических 64-символьных SHA-256 хэшей набора, ID кейсов/эталонных ответов/флагов канареек и `unknownSpendUsd === 0`). Не зависит от рантайма и CLI.
- `tools/jev-evaluation-cases.mjs`: хелперы выполнения платных кейсов (`executeChatCall`, `executeSkillCase`, `executeRoutingCase` с обработкой канареек и recovery).
- `tools/jev-evaluate.mjs`: CLI парного бенчмарка, контроль лимита расходов и построитель Report v1.
- `tools/jev-control.mjs`: локальное управление политикой (`status`, `enable`, `disable`) без обращения к сети.
- `tools/jev-assist.mjs`: базовый модуль содействия (`readCredential`, `loadSkillCatalog`, `screenTask`, `decide`, `readPolicy`, `appendEvent`).
- `agent/extensions/nullform-jev.ts`: нативные хуки расширения OMP для подсказки навыков и выбора моделей подзадач.

### Парный бенчмарк (`tools/jev-evaluate.mjs`)

Инструмент оценки запускает воспроизводимое парное тестирование:
- **Базовое плечо навыков**: чат-модель (`google/gemini-3.8-flash`, каталожные цены: $0.75/M ввод, $3.75/M вывод) с полным каталогом эффективных навыков.
- **Кандидат навыков**: типизированный классификатор JEV (`typesafe/jev-1.13`).
- **Листовые задачи**: сопоставление вывода базовой модели и кандидата (`google/gemini-3.1-flash-lite`, каталожные цены: $0.25/M ввод, $1.50/M вывод) на детерминированных тестах.

#### Авторитетный снимок каталога нативных навыков
Оценка и активация поддерживают параметр `--catalog <путь>` (например, `--catalog .tmp/jev-native-catalog.json`), позволяющий использовать снимок метаданных нативных навыков:
- **Штатная конфигурация сессии (89 навыков)**: стандартный запуск с поиском расширений включает все 89 установленных навыков, сохраняя пространства имён (`omp:`, плагины `ponytail`, `pi-lens`), описания и правила отключённых навыков без чтения тел файлов.
- **Ограниченный зонд (78 навыков)**: изолированный запуск без плагинов исключал плагинные навыки; документация чётко разделяет тестовый зонд (78) и штатную конфигурацию (89).

#### Разделение калибровки и отложенной выборки
- **Калибровочный набор**: 14 независимых кейсов для настройки промптов и базовой валидации.
- **Отложенная выборка (Held-out)**: 44 независимых RU/EN кейса без пересечения с калибровочными промптами.
- **Детерминированные результаты**: 10 кейсов по 4 листовым архетипам (8 допустимых преобразований + 2 канарейки секретов).
- **Чистота разметки**: из промптов задач исключены буквальные ответы, чтобы оценивать реальную способность к трансформации. В кейсе 08 телефонные данные заменены на нормализацию обычного текста на русском языке.
- **Хэширование данных**: SHA-256 фикстур фиксируются в Report v1.

#### Учёт расходов и резервирование бюджета
- **Проверка цен**: каталожные цены проверяются для базовой модели и кандидата. Для модели `typesafe/jev-1.13`, отсутствующей в `/models`, используется опубликованная ставка ($0.042/M токенов) с фиксированным резервом, без ложных утверждений о наличии в каталоге.
- **Консервативный резерв**: токены рассчитываются по объёму UTF-8 байт сериализованного запроса; лимит `max_tokens` учитывает токены рассуждений (reasoning) без двойного счёта.
- **Учёт отсутствующей стоимости и ошибок**: при отсутствии `usage.cost` возвращается ошибка. Ошибки fallback увеличивают счётчик `totalErrors` при сохранении строк в отчёте.
- **Первичные успехи и recovery**: если задача не подходит под дешёвую модель, сразу запускается базовое recovery (`candidatePrimaryAttempted = false`).

#### Критерии допуска (Hurdles)
- **Безопасность**: 0 пропусков канареек (100% блокировка секретов до отправки).
- **Качество навыков**: 0 критических ошибок, покрытие $\ge 70\%$, точность попыток $\ge 95\%$ (не ниже базовой). Ответ `none` признаётся валидной попыткой.
- **Стоимость классификатора**: суммарная стоимость решений JEV ниже стоимости базовой модели либо продемонстрирован более высокий уровень правильных ответов.
- **Качество маршрутизации**: число принятых дешёвых результатов не ниже базового, а стоимость за принятый результат строго ниже.

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
  --candidate google/gemini-3.1-flash-lite \
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

- **Измеренная польза**: доказанная экономия и точность относятся строго к протестированной паре моделей (`google/gemini-3.8-flash` и `google/gemini-3.1-flash-lite`) и четырём заявленным листовым архетипам.
- **Отключён по умолчанию и безопасный отказ**: ассистент по умолчанию не активен (`unconfigured`). Прерванный, частичный или завершившийся ошибкой прогон оставляет ассистента отключённым и не является доказательством пользы. Для активации необходим полностью завершённый отчёт, прошедший все барьеры качества.
- **Мгновенный отказ (Opt-Out)**: команда `node tools/jev-control.mjs disable` устанавливает `enabled: false` в файле политики. Хуки OMP немедленно направляют все задачи на базовую модель без перезапуска системы.
- **Без необоснованных утверждений**: отчёт не делает заявлений об ускорении всего сквозного процесса разработки или об экономии на подписочных тарифах с фиксированной платой. До живого подтверждения отчётом польза не декларируется.
