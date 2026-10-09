# JEV Automatic Assistance & Evaluation Guide / Руководство по JEV-ассистенту и оценке

---

## English

### Overview

JEV Automatic Assistance brings native, automated skill suggestion to NULLFORM WORKFLOW on top of Oh My Pi (OMP 18.4.4+). Powered by OpenRouter Decisions (`typesafe/jev-1.13`), it assists agent turns with relevant skill hints without altering canonical prompts, role contracts, models, permissions, or Oracle gates.

**User Scope & Dropped Routing**:
Following user decision («Только подсказки навыков»), automatic subagent model routing was completely removed rather than left dormant. The complete v1 routing experiment had 3/8 cheap-model primary acceptances and five baseline recoveries; its total candidate-arm cost was $0.001312 versus $0.000701 for baseline. Separately, a later benchmark hit HTTP 502 on calibration case `calib-10`; $0.0281 was a conservative unknown-spend reserve, not measured routing cost. Those failed reports remain preserved and cannot activate v2.

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
- **Held-out Set**: 44 constructed RU/EN reference cases, separate from calibration. This permits comparison across the covered fixture domains; it is not independent real-user workload gold or a statistical guarantee of generalization.
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

### Empirical Evidence & Current Profile Activation

#### Measured v2 Evaluation Proof (`openspec/changes/jev-automatic-assistance/evidence/live-skills-v2-measured.json`)
The paired live evaluation completed with all hurdles PASSED:
- **Requests & Integrity**: 104 requests, 0 errors, 0 unknown spend; the actual per-run cap was $0.35.
- **Corpus**: 14 calibration cases + 44 held-out cases (40 eligible held-out cases, 4 safety canaries).
- **Baseline Arm (`google/gemini-3.8-flash`)**: 37/40 correct on held-out eligible cases, decision cost $0.206936, latency 79,707 ms (prior run: 38/40, $0.206264).
- **Candidate Arm (`typesafe/jev-1.13`)**: 36 correct out of 36 confident attempts, 90% coverage (36/40), four abstentions, 0 safety misses and 0 critical misses. Decision cost $0.012637 versus $0.206936 (93.9% lower, 16.4x lower); summed latency 16,414 ms versus 79,707 ms (79.4% lower, 4.86x lower). Counting all eligible inputs, JEV resolved 36/40 versus baseline 37/40: higher attempted precision, not higher all-case accuracy.
- **Total Run**: Total API spend $0.286911 within its $0.35 cap, including calibration and both arms (prior run: $0.286204); recorded run duration 128,412 ms and executed-command wall duration 128.54 s.

#### Preserved Negative Experimental Evidence (Model Routing Dropped)
The complete v1 routing experiment (`google/gemini-3.1-flash-lite`) produced 3/8 cheap-primary successes plus five baseline recoveries. Full candidate-arm cost was $0.001312 versus $0.000701 for eight correct baseline results, so quality/cost gates failed. A separate interrupted benchmark recorded a calibration HTTP 502 and an unknown-spend reserve; that error must not be attributed to routing. The user explicitly dropped routing and its runtime code was removed.

#### Current Profile Deployment & Runtime Verification
- **Targeted Deployment**: 9 manifest files deployed to current OMP profile; `tools/jev-control.mjs enable` validated against the active native catalog (89 skills) and policy verified active via `tools/jev-control.mjs status`.
- **Native Registry Behavior**: Default 89-skill native registry emits `python-resilience` on a relevant implementation turn without factory overrides; the execution model remains unchanged and the JEV callback does not mutate its system/catalog-prefix input or return a prefix override.
- **Full SDK Boundary Verification**: Verified across positive skill suggestion, safety canary (prompt blocked before network), opt-out (`enabled: false`), no-key fallback (injected credential availability test without touching OS native vault), and transport error recovery.
- **Callback Prefix Audit**: JEV callback preserves system/prefix text unchanged while unrelated SDK dynamic status blocks update.
- **Daemon Reload Limit**: Running OMP agent processes require session restart or reload to pick up updated extension files; installers do not restart external user daemons.

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
По выбору пользователя («Только подсказки навыков») маршрутизация подзадач полностью удалена, а не оставлена неактивной. Полный эксперимент v1 дал 3/8 первичных результатов дешёвой модели и пять восстановлений через baseline; общая стоимость плеча кандидата — $0.001312 против $0.000701 у baseline. Отдельный последующий прогон получил HTTP 502 на калибровочном `calib-10`; $0.0281 — консервативный резерв неопределённых расходов, а не измеренная цена маршрутизации. Оба отрицательных отчёта сохранены и не могут активировать v2.

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

### Эмпирические результаты и активация в текущем профиле

#### Доказательство оценки v2 (`openspec/changes/jev-automatic-assistance/evidence/live-skills-v2-measured.json`)
Парный живой запуск успешно ПРОЙДЕН со следующими показателями:
- **Запросы и целостность**: 104 запроса, 0 ошибок, 0 неопределённых расходов; фактический лимит этого прогона — $0.35.
- **Выборка**: 14 калибровочных кейсов + 44 отложенных кейса (40 допустимых held-out, 4 канарейки безопасности).
- **Базовое плечо (`google/gemini-3.8-flash`)**: 37/40 правильных ответов, затраты $0.206936, задержка 79 707 мс (предыдущий прогон: 38/40, $0.206264).
- **Кандидат (`typesafe/jev-1.13`)**: 36 правильных решений из 36 уверенных попыток, покрытие 90% (36/40), четыре воздержания, 0 пропусков защиты и критических ошибок. Стоимость $0.012637 против $0.206936 — ниже на 93,9%, в 16,4 раза; сумма задержек 16 414 мс против 79 707 мс — ниже на 79,4%, в 4,86 раза. По всем допустимым входам JEV решил 36/40, baseline — 37/40: выше точность попыток, но не общая точность.
- **Общий прогон**: $0.286911 в рамках его лимита $0.35, включая калибровку и обе модели (предыдущий прогон: $0.286204); в отчёте длительность 128 412 мс, время исполненной команды — 128.54 с.

#### Сохранение отрицательных результатов (отказ от маршрутизации)
Полный эксперимент v1 с `google/gemini-3.1-flash-lite` дал 3/8 первичных успехов и пять восстановлений через baseline. Общая стоимость плеча кандидата — $0.001312 против $0.000701 за восемь правильных результатов baseline: гейты качества и стоимости не пройдены. В отдельном прерванном бенчмарке был калибровочный HTTP 502 и резерв неизвестных расходов; это не ошибка маршрутизации. Пользователь исключил маршрутизацию из объёма, её runtime-код удалён.

#### Развёртывание в текущем профиле и проверка рантайма
- **Целевое развёртывание**: 9 файлов манифеста развёрнуты в текущий профиль OMP; `tools/jev-control.mjs enable` валидирован относительно активного нативного каталога (89 навыков), статус подтверждён как активный через `tools/jev-control.mjs status`.
- **Поведение нативного реестра**: штатные 89 навыков дают подсказку `python-resilience` на соответствующем запросе реализации без переопределения фабрики. Модель неизменна; коллбэк JEV не мутирует входной system/catalog prefix и не возвращает его переопределение.
- **Проверка границ SDK**: подтверждены сценарии позитивной подсказки навыка, канарейки безопасности (запрос блокируется до сети), opt-out (`enabled: false`), отсутствия ключа (проверка доступности без удаления системных ключей) и сетевых сбоев.
- **Аудит префикса коллбэка**: префикс промпта и модель остаются неизменными при штатном обновлении динамических блоков SDK.
- **Ограничение перезагрузки**: запущенные процессы OMP требуют перезапуска сессии для подхвата обновлений расширений; скрипты установки не перезапускают пользовательские демоны принудительно.

### Границы применимости и отказ от использования

- **Измеренная польза**: сконструированная RU/EN-выборка сравнивает отдельные API-классификаторы `google/gemini-3.8-flash` и `typesafe/jev-1.13`, а не размеченные реальные пользовательские задачи. Четыре воздержания входят в знаменатель покрытия; они не исчезают из отчёта.
- **Отключён по умолчанию и безопасный отказ**: ассистент по умолчанию не активен (`unconfigured`). Прерванный, частичный или завершившийся ошибкой прогон оставляет ассистента отключённым и не является доказательством пользы. Для активации необходим полностью завершённый отчёт v2, прошедший все барьеры качества.
- **Мгновенный отказ (Opt-Out)**: команда `node tools/jev-control.mjs disable` устанавливает `enabled: false` в файле политики. Хуки OMP немедленно прекращают добавление подсказок без перезапуска системы.
- **Без необоснованных утверждений**: отчёт не делает заявлений об ускорении всего сквозного процесса разработки или об экономии на подписочных тарифах с фиксированной платой. До живого подтверждения отчётом польза не декларируется.
