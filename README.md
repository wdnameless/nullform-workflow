# NULLFORM WORKFLOW

[![CI](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Portable engineering workflow harness for AI coding agents — hard gates over promises, verified tests over "done", live observability over guesswork.**  
**Переносимый инженерный каркас разработки для ИИ-агентов: строгие гейты вместо обещаний, проверенные тесты вместо «готово», наблюдаемость вместо догадок.**

Built for **Oh My Pi (OMP)** and **Paseo** with portable adapter generators for **Claude Code**, **Codex**, **OpenCode**, **Cursor**, **OpenClaw**, **Hermes**, and **OpenHuman** on Windows, Linux, and macOS. Requires Node.js `>=18.19.0` with three pinned native-config parser dependencies justified by host formats (`jsonc-parser@3.3.1` for OpenCode JSONC, `json5@2.2.3` for OpenClaw JSON5, `yaml@2.9.1` for Hermes YAML) · 8 specialized roles · 70 skills · 34 CLI tools · 29 install & 15 audit checks.

![NULLFORM WORKFLOW Live Dashboard](docs/assets/dashboard-graph.jpg)

---

## English

### Quickstart (3 Steps)

**1. Install the package** (delivered as verified `.tgz` archive; package not publicly published to npmjs):
```bash
npm install -g --ignore-scripts ./nullform-workflow-1.1.0.tgz
# Source clone fallback remains supported for contributors:
# git clone https://github.com/wdnameless/nullform-workflow.git && cd nullform-workflow
```

**2. Select and configure your harness** (`claude|codex|opencode|cursor|omp|openclaw|hermes|openhuman`):
```bash
# Interactive selection menu:
nullform init

# Or non-interactive explicit installation (one of the 8 supported harnesses):
nullform init --harness opencode --yes
# For Cursor (project-scoped rules in <project>/.cursor/rules/00-workflow.mdc; no global ~/.cursor/rules/ on disk):
nullform init --harness cursor --project-root . --yes
```

**3. Verify environment & run your first gated task**
```bash
nullform doctor
# Invoke workflow tools from the installed root (e.g. ~/.config/opencode/workflow for opencode, or your custom --root):
node ~/.config/opencode/workflow/tools/workflow.mjs start --tier T1 --task "smoke check"
node ~/.config/opencode/workflow/tools/workflow.mjs artifact --kind recon --detail "environment verified"
node ~/.config/opencode/workflow/tools/workflow.mjs close
```

### One-Phrase Install (Agent Prompt)

Copy-paste this prompt to your AI coding agent (OMP, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, OpenHuman, Codex). The agent inspects environment markers, identifies the active harness among the 8 supported choices, previews the planned writes via `nullform init --dry-run`, and asks for confirmation before applying:

```text
You are an installer agent for the `nullform-workflow` npm CLI (`nullform`).
Follow these steps strictly:

1. INSTALL PACKAGE & INSPECT SUPPORTED HARNESSES:
   - Ensure `nullform` is installed globally from the verified tarball if not already in PATH:
     `npm install -g --ignore-scripts ./nullform-workflow-1.1.0.tgz`
   - Inspect CLI options and the 8 supported harness choices (`claude`, `codex`, `opencode`, `cursor`, `omp`, `openclaw`, `hermes`, `openhuman`):
     Run: `nullform --help`
   - Identify the host harness from explicit environment markers:
     • omp: `omp` binary in PATH, `~/.omp/` directory, `OMP_CONFIG_DIR`, or running inside an OMP session (`proc://`, `agent://`, `skill://`, `xd://`).
     • openclaw: `~/.openclaw/openclaw.json` or `openclaw` in PATH.
     • hermes: `~/.hermes/config.yaml`, `$HERMES_HOME`, or `hermes` in PATH.
     • openhuman: `~/.openhuman/` or `openhuman-core` in PATH.
     • claude: `~/.claude/` or `claude` in PATH.
     • codex: `~/.codex/` or `codex` in PATH.
     • opencode: `~/.config/opencode/` or `opencode` in PATH.
     • cursor: `.cursor/` in project or `cursor` in PATH (rules are project-scoped; pass `--project-root <dir>`).
   - If multiple or ambiguous markers exist, suggest the most probable harness and ask the user to choose one of the 8 explicit harnesses from `nullform --help`.

2. DRY-RUN PREVIEW & COMPONENT TABLE:
   - ALWAYS run a dry-run preview first before modifying any files on disk:
     `nullform init --harness <detected_harness> --dry-run`
   - Present a clear table showing what will be installed for <detected_harness>:
     | Component | Installed path & format for <detected_harness> |
     |---|---|
     | Skills | Target directory: omp (`~/.agents/skills/`), claude (`~/.claude/skills/`), codex (`~/.codex/skills/`), opencode (`~/.config/opencode/skills/`), openclaw (`~/.openclaw/skills/`), hermes (`~/.hermes/skills/`), openhuman (physical copies in `~/.openhuman/skills/` and `<root>/agents/workflow/skills/`, no symlinks) |
     | Agents & Roles | Managed adapter block (`<!-- BEGIN NULLFORM WORKFLOW -->`) preserving user text in `CLAUDE.md`, `AGENTS.md`, `~/.hermes/SOUL.md`, or `<project>/.cursor/rules/00-workflow.mdc`; full roster in `~/.omp/agent/agents` for omp |
     | Native Config & MCP | Preserves existing settings & keys in `~/.config/opencode/opencode.json[c]`, `~/.openclaw/openclaw.json` (JSON5 `agents.entries.workflow`), `~/.hermes/config.yaml` (YAML `mcp_servers:`), `~/.openhuman/config.toml` (TOML), or `~/.omp/agent/mcp.json` |
     | Core CLI Tools & State | Workflow runtime in `<installed_root>/tools/` and persisted identity in `~/.nullform/installation.json` |

3. USER CONFIRMATION:
   - Display the selected harness, target installation root (`<installed_root>`), and the component table.
   - Ask for explicit user confirmation before applying any changes.

4. APPLY INSTALLATION & VERIFY:
   - Upon confirmation, execute:
     `nullform init --harness <detected_harness> --yes`
   - Verify installation health:
     `nullform doctor`
   - Report status and next steps using the installed root path:
     `node <installed_root>/tools/workflow.mjs start --tier T1 --task "smoke check"`
```

### Work Tiers (T0–T3)

| Tier | Scope / When to Use | Required Gates & Artifacts (`tools/workflow.mjs`) |
|---|---|---|
| **T0** | 1–2 known files, trivial local fix | Declared tier (`start --tier T0` → `close`); supports guarded `--auto` (`--max-diff <= 20`) |
| **T1** | 3+ files or unfamiliar area | Reconnaissance (`recon` artifact) before edits + verification before `close` |
| **T2** | Architecture change or new module | 4-Wave SDD: `manifest.md` (`R##`), OpenSpec `proposal/tasks/specs`, `interfaces.md`, `reviewer` patch/consumer review, Stage-B simplification disposition, blind `oracle` ACCEPT backed by recorded execution evidence (`review-evidence.json`) |
| **T3** | Multi-feature program or cross-cutting epic | Full T2 contract and blind Oracle acceptance per vertical slice with recorded execution evidence |

### JEV: automatic skill hints, not model routing

JEV is a small decision model (`typesafe/jev-1.13`) used through OpenRouter Decisions. The native OMP extension selects a relevant **installed skill** before a main-agent turn; it does not execute the task, approve actions, or switch main/child models.

1. `before_agent_start` reads the effective native skill registry: identifiers and descriptions, not skill bodies.
2. The extension validates its v2 activation policy, current catalog fingerprint, report SHA-256, model snapshots and expiry. Sensitive, context-only or unsupported input is screened before dispatch.
3. A permitted current prompt and bounded skill metadata go to one typed skill-choice question. A real catalog ID at confidence **≥0.80** becomes a short extra turn message such as `Recommended skill: python-resilience`.
4. `none`, low confidence, opt-out, missing credentials/policy, stale evidence or an API error produce no hint: the existing agent workflow continues. JEV does not rewrite the stable system/catalog prefix.

**What this helps with:** selecting a suitable specialist instruction without adding a separate large-model classifier call. The hint remains advisory; the main agent still interprets the request, reads relevant instructions, writes code and runs the normal engineering gates. The full catalog remains available to that agent.

#### Measured improvement and its limits

The [complete live v2 report](openspec/changes/jev-automatic-assistance/evidence/live-skills-v2-measured.json) compares JEV with a separate `google/gemini-3.8-flash` skill-selection call using the same catalog. The constructed RU/EN corpus has **14 calibration + 44 held-out cases**; held-out metrics below cover **40 eligible inputs**, with four additional privacy canaries.

| Held-out metric | Gemini baseline | JEV |
|---|---:|---:|
| Confident/valid decisions | 40/40 | 36/40; four abstentions |
| Correct decisions | 37/40 | 36/36 attempted |
| Precision among attempts | 92.5% | 100% |
| Attempt coverage | 100% | 90% |
| Decision cost, including all 40 calls | $0.206936 | $0.012637 |
| Sum of request latencies, all 40 calls | 79.707 s | 16.414 s |

For this isolated decision step, cost fell **93.9% (16.4× lower)** and summed latency fell **79.4% (4.86× lower)**. This is not a whole-workflow speedup: JEV resolved **36/40** inputs versus **37/40** for the baseline, trading coverage for precision. No reduction in the main agent's catalog, token use, development time or subscription bill was measured.

The full paired run made **104 requests**, cost **$0.286911**, and recorded **zero API errors, unknown usage, safety misses and critical misses**. This total includes calibration and both arms; it is not the JEV-only held-out cost. Original negative/interrupted experiments are retained, not excluded to manufacture a passing result.

Evidence: [native/default-profile verification](openspec/changes/jev-automatic-assistance/evidence/current-profile-activation.json), [real redacted API cassette](openspec/changes/jev-automatic-assistance/evidence/skills-v2-api.cassette.json), [two independent ACCEPT verdicts](openspec/changes/jev-automatic-assistance/evidence/oracle-verdicts.json). Release verification: **538/538 tests passed**.

#### Operation

The current OMP profile is activated; new installations remain inactive until a complete, canonical v2 evaluation passes and is enabled once. Later turns need no per-task command.

```bash
node tools/jev-control.mjs status
node tools/jev-control.mjs disable
```

Credentials come from the native OS vault or `OPENROUTER_API_KEY` / `JEV_API_KEY`, never repository files. Privacy screening is a defensive filter, not a universal DLP guarantee. If catalog/model evidence changes or policy expires, hints stop until a new valid proof is enabled. An already running session may need normal reload to discover a newly installed extension; the installer does not restart the daemon.

Model routing was explicitly removed after negative results. The [`jev/`](jev/) directory is the user-provided **Claude-plugin reference**, not the active OMP extension and not part of automatic OMP installation. Implementation, evaluation and control details: [docs/jev.md](docs/jev.md).


### Agent Workflow Habits (evidence PRs, session retro, task graph)

Three habits borrowed from Matt Pocock's Skills v1.3 video ([transcript](https://www.youtube.com/watch?v=BsJGo1wFTvQ)):

- **Evidence PRs** ([`requesting-code-review`](skills/requesting-code-review/SKILL.md)): every PR body follows [`.github/pull_request_template.md`](.github/pull_request_template.md) — Summary → Evidence (before → after, exact command + raw output) → Merge danger (one-way/two-way door) → Blast radius. The reviewer rejects evidence-free PRs as P1+, same bar as the oracle evidence protocol.
- **Session retro** ([`session-retro`](skills/session-retro/SKILL.md), `node tools/session-retro.mjs scan`): retrospective over real `.jsonl` session logs — ranks sessions with hidden waste (errors/retries, heavy reads, long sessions, repeated commands) for human-led review. Findings apply manually through normal lanes; auto-fix loops are banned (they spiral on false positives).
- **Task graph + integration branch** ([`nullform-workflow-full`](skills/nullform-workflow-full/SKILL.md), Wave 2–3): tasks carry `blocked-by` edges, each build wave launches the ready frontier, ticket work merges into `feat/<name>-integration` for whole-branch review. Uniform tickets go through a deterministic script loop, not an agent loop.

### Release updates

Updates are driven through npm package distribution:

```bash
# Check available release and preview changes:
nullform update --dry-run

# Apply update across global executable and saved harness installation:
nullform update --yes
```

`nullform update` reads version metadata from the configured npm registry (or private/loopback endpoint), reinstalls the global package via `npm install -g`, and invokes the new package executable to re-apply and verify the saved harness installation (`~/.nullform/installation.json`).
- **No Git requirement**: Operates without a git clone, git working tree, or GitHub release tags.
- **Data preservation**: User instructions, custom configurations, secret tokens, and unrelated files are preserved.
- **Failure behavior**: If registry resolution, npm installation, or doctor verification fails, the process exits with a nonzero code and makes no false success claims; no silent partial state is persisted.
- **Capability limits**: Requires Node.js `>=18.19.0` (`package.json` `engines.node`) and three pinned parser dependencies justified by host native formats (`jsonc-parser@3.3.1` for OpenCode JSONC, `json5@2.2.3` for OpenClaw JSON5, and `yaml@2.9.1` for Hermes YAML) for safe native config preservation at user trust boundaries. Public npmjs publishing is excluded in this release (distributed via verified `.tgz` or private/loopback registry). The update process is completely Git-free (no Git public updater; queries npm registry metadata and invokes real `npm install -g`). Host CLI runtimes (OMP, Claude Code, OpenCode, Cursor, OpenClaw, Hermes, OpenHuman, Codex) and API credentials are external prerequisites; missing host binaries or disabled host loaders are reported honestly as `SETUP`, not `FAIL`. Cursor rules (`.cursor/rules/00-workflow.mdc`) require a project context (`--project-root` or `--root`). No background daemon or automatic session restart.
### Key Commands & Architecture Links

- **Core Protocol & 4-Wave SDD**: [`core/PORTABLE.md`](core/PORTABLE.md) — harness-agnostic specification, roles (`orchestrator`, `designer`, `fixer`, `oracle`, `reviewer`, `librarian`, `explorer`, `sonic`), Lean A→B→A stage rhythm, and evidence protocol.
- **Domain Glossary & Topology**: [`CONTEXT.md`](CONTEXT.md) — definitions of live/repo trees, `<HARNESS>` substitution, Oracle-lite, dual-pass flash-class acceptance, prompt budgets, `defer:` debt markers, and sync/prune semantics.
- **Documentation & Visual Assets**: [`docs/`](docs/) — dashboard overview and visual artifacts (`node tools/dashboard.mjs --url`).
- **JEV Assistance & Evaluation**: [`docs/jev.md`](docs/jev.md) — skills-only runtime, canonical paired evidence, activation policy and local control CLI; measured results and limits are described above.
- **Always-On Agent Laws & Roles**: [`agent/AGENTS.md`](agent/AGENTS.md) · [`agent/agents/orchestrator.md`](agent/agents/orchestrator.md) · [`agent/plugins.json`](agent/plugins.json).
- **Verification, Sync & Quality Gates**:
  - `node tools/verify.mjs --profile verify` (29 install checks) · `--profile audit` (15 health checks)
  - `node tools/sync.mjs --check | --promote | --deploy | --prune` (wrapper scripts: `tools/sync.sh`, `tools/sync.ps1`)
  - `node tools/code-size.mjs check` · `node tools/debt-ledger.mjs scan --check` · `node tools/prompt-lint.mjs sizes --check`
  - `node tools/test-lens.mjs` · `node tools/benchmark.mjs` · `node tools/usage-audit.mjs` · `node tools/auto-review.mjs --root .`
  - `node tools/workflow.mjs review-run --role <reviewer|oracle> --change <id> --model <provider/model> --base-ref <review-base> [--product-command JSON_ARGV] [--redo]` (oracle requires the product command) · `node tools/workflow.mjs stage-b --change <id> --phase before --test-cmd "<cmd>"`, then `--phase after --test-cmd "<same-cmd>" --disposition <lean-already|simplified>`
  - CI template: [`templates/ci/workflow-gate.yml`](templates/ci/workflow-gate.yml) · Unit tests: `node --test tools/tests/*.test.mjs`
  - Bounded fresh skill comparisons: `node tools/run-skill-benefit-eval.mjs --dry-run --root .` (real SDK setup, no API), then `--yes --ceiling 1`; see [`bench/README.md`](bench/README.md) for native caps, retained scores and fixed-tariff accounting limits.

---

## Русский

### Быстрый старт (3 шага)

**1. Установите пакет** (поставляется как проверенный архив `.tgz`; в публичный npmjs в этом релизе не публикуется):
```bash
npm install -g --ignore-scripts ./nullform-workflow-1.1.0.tgz
# Для разработчиков по-прежнему доступна установка из исходников:
# git clone https://github.com/wdnameless/nullform-workflow.git && cd nullform-workflow
```

**2. Выберите и настройте харнесс** (`claude|codex|opencode|cursor|omp|openclaw|hermes|openhuman`):
```bash
# Интерактивное меню выбора:
nullform init

# Или явный запуск без интерактива (один из 8 поддерживаемых харнессов):
nullform init --harness opencode --yes
# Для Cursor (правила <project>/.cursor/rules/00-workflow.mdc привязаны к проекту; глобального ~/.cursor/rules/ нет):
nullform init --harness cursor --project-root . --yes
```

**3. Проверьте установку и запустите первую задачу**
```bash
nullform doctor
# Запускайте инструменты workflow из установленного корня (например ~/.config/opencode/workflow для opencode или ваш --root):
node ~/.config/opencode/workflow/tools/workflow.mjs start --tier T1 --task "проба"
node ~/.config/opencode/workflow/tools/workflow.mjs artifact --kind recon --detail "проверка окружения и инструментов"
node ~/.config/opencode/workflow/tools/workflow.mjs close
```

### Установка одной фразой

Скопируйте и передайте этот промпт вашему ИИ-агенту (в любой среде: OMP, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, OpenHuman, Codex). Агент определит активный харнесс из 8 поддерживаемых вариантов, выполнит безопасный предпросмотр `nullform init --dry-run` и запросит подтверждение перед установкой:

```text
Ты — агент установки и настройки пакета `nullform-workflow` (CLI `nullform`).
Выполни установку строго по следующим шагам без самодеятельности:

1. УСТАНОВКА ПАКЕТА И ОПРЕДЕЛЕНИЕ ХАРНЕССА:
   - Если команда `nullform` ещё не доступна в PATH, установи глобальный пакет из проверенного архива:
     `npm install -g --ignore-scripts ./nullform-workflow-1.1.0.tgz`
   - Проверь доступные команды и 8 поддерживаемых харнессов (`claude`, `codex`, `opencode`, `cursor`, `omp`, `openclaw`, `hermes`, `openhuman`):
     Запусти: `nullform --help`
   - Определи активный харнесс хоста по явным маркерам окружения:
     • omp: наличие бинарника `omp` в PATH, каталога `~/.omp/`, переменной `OMP_CONFIG_DIR`, либо активная сессия OMP (`proc://`, `agent://`, `skill://`, `xd://`).
     • openclaw: наличие `~/.openclaw/openclaw.json` либо команды `openclaw` в PATH.
     • hermes: наличие `~/.hermes/config.yaml`, `$HERMES_HOME` либо команды `hermes` в PATH.
     • openhuman: наличие `~/.openhuman/` либо `openhuman-core` в PATH.
     • claude: наличие `~/.claude/` либо команды `claude` в PATH.
     • codex: наличие `~/.codex/` либо команды `codex` в PATH.
     • opencode: наличие `~/.config/opencode/` либо команды `opencode` в PATH.
     • cursor: наличие `.cursor/` в проекте либо команды `cursor` в PATH (правила проектные; передавай `--project-root <dir>`).
   - Если маркеров несколько или однозначного совпадения нет, назови наиболее вероятный вариант и попроси пользователя явно выбрать один из 8 харнессов из вывода `nullform --help`.

2. DRY-RUN ПРЕДПРОСМОТР И ТАБЛИЦА КОМПОНЕНТОВ:
   - ОБЯЗАТЕЛЬНО выполни dry-run предпросмотр до внесения любых изменений на диск:
     `nullform init --harness <определённый_харнесс> --dry-run`
   - Покажи пользователю таблицу компонентов для <определённый_харнесс>:
     | Компонент | Назначение и путь установки для <определённый_харнесс> |
     |---|---|
     | Навыки (skills) | Каталог: omp (`~/.agents/skills/`), claude (`~/.claude/skills/`), codex (`~/.codex/skills/`), opencode (`~/.config/opencode/skills/`), openclaw (`~/.openclaw/skills/`), hermes (`~/.hermes/skills/`), openhuman (физические копии в `~/.openhuman/skills/` и `<root>/agents/workflow/skills/` без симлинков) |
     | Агенты и инструкции | Управляемый блок (`<!-- BEGIN NULLFORM WORKFLOW -->`) с сохранением пользовательского текста в `CLAUDE.md`, `AGENTS.md`, `~/.hermes/SOUL.md` или `<project>/.cursor/rules/00-workflow.mdc`; роли в `~/.omp/agent/agents` для omp |
     | Конфигурация и MCP | Сохранение существующих настроек и ключей в `~/.config/opencode/opencode.json[c]`, `~/.openclaw/openclaw.json` (JSON5 `agents.entries.workflow`), `~/.hermes/config.yaml` (YAML `mcp_servers:`), `~/.openhuman/config.toml` (TOML) или `~/.omp/agent/mcp.json` |
     | Ядро и состояние | Инструменты в `<installed_root>/tools/` и сохранённый профиль установки в `~/.nullform/installation.json` |

3. ЗАПРОС ПОДТВЕРЖДЕНИЯ У ПОЛЬЗОВАТЕЛЯ:
   - Выведи пользователю выбранный харнесс, целевой путь установки (`<installed_root>`) и таблицу компонентов.
   - Запроси явное подтверждение (да/нет) перед применением изменений.

4. ПРИМЕНЕНИЕ УСТАНОВКИ И ПРОВЕРКА:
   - Только после явного согласия пользователя выполни:
     `nullform init --harness <определённый_харнесс> --yes`
   - Запусти диагностику выбранного харнесса:
     `nullform doctor`
   - Выведи результат и команду запуска первой задачи из установленного корня:
     `node <installed_root>/tools/workflow.mjs start --tier T1 --task "smoke check"`
```

### Ярусы задач (T0–T3)

| Ярус | Когда применяется | Обязательные гейты и артефакты (`tools/workflow.mjs`) |
|---|---|---|
| **T0** | 1–2 известных файла, локальная правка | Объявленный ярус (`start --tier T0` → `close`); доступен защищённый `--auto` (`--max-diff <= 20`) |
| **T1** | 3+ файлов или незнакомая область | Рекогносцировка (`recon`) до правок и верификация перед `close` |
| **T2** | Архитектура или новый модуль | 4-Wave SDD: `manifest.md` (`R##`), OpenSpec `proposal/tasks/specs`, `interfaces.md`, ревью патча `reviewer`, фиксация Stage-B и слепая приёмка `oracle` (ACCEPT) с подтверждённым выполнением (`review-evidence.json`) |
| **T3** | Программа из нескольких фич | Полный цикл T2, отдельное ревью и слепая приёмка Оракула на каждый вертикальный срез с записью выполнения |

### JEV: автоматический подбор навыков, без переключения моделей

JEV — небольшая модель принятия решений (`typesafe/jev-1.13`), которую нативная extension OMP вызывает через OpenRouter Decisions. Она подсказывает **существующий установленный навык** перед ходом основного агента. Саму задачу, код и разрешения JEV не исполняет; модели основного агента и подагентов не переключает.

1. Хук `before_agent_start` получает реальный реестр навыков OMP: имена и описания, без загрузки их полного текста для JEV.
2. Проверяет политику v2, актуальный отпечаток каталога, SHA-256 отчёта, версию модели и срок действия доказательств. Чувствительные, контекстно-зависимые и неподдерживаемые входы отсекаются до отправки.
3. Допущенный текущий промпт и ограниченные метаданные навыков отправляются в один типизированный вопрос. Если ответ — реальный ID навыка с confidence **≥0.80**, агент получает короткую подсказку, например `Recommended skill: python-resilience`.
4. При `none`, низкой уверенности, opt-out, отсутствии ключа/политики, устаревших доказательствах или ошибке API подсказка не добавляется: прежний workflow продолжает работу. Стабильный system/catalog prefix JEV не переписывает.

**Чем помогает:** делает отдельный шаг выбора специализированной инструкции дешевле, чем отдельный вызов большой модели-классификатора. Подсказка рекомендательная: основной агент по-прежнему понимает задачу, читает инструкции, пишет код и проходит обычные инженерные гейты. Полный каталог навыков у него остаётся.

#### Доказательства улучшения и границы вывода

[Живой отчёт v2](openspec/changes/jev-automatic-assistance/evidence/live-skills-v2-measured.json) сравнивает JEV с отдельным вызовом `google/gemini-3.8-flash` для выбора навыка из того же каталога. Это сконструированная RU/EN-выборка: **14 калибровочных + 44 отложенных случая**. Метрики ниже относятся к **40 допустимым входам**; ещё четыре held-out случая проверяют защиту от чувствительных данных.

| Метрика на held-out | Baseline Gemini | JEV |
|---|---:|---:|
| Уверенные/валидные решения | 40/40 | 36/40; четыре воздержания |
| Правильные решения | 37/40 | 36/36 попыток |
| Точность среди попыток | 92,5% | 100% |
| Покрытие попытками | 100% | 90% |
| Стоимость решений, все 40 вызовов | $0.206936 | $0.012637 |
| Сумма задержек всех 40 вызовов | 79,707 с | 16,414 с |

На этом отдельном шаге стоимость ниже на **93,9% — в 16,4 раза**, сумма задержек — на **79,4% — в 4,86 раза**. Это не ускорение всего workflow: JEV решил **36/40** случаев, baseline — **37/40**. Выше точность уверенных ответов, но ниже покрытие. Уменьшение каталога, токенов основного агента, времени разработки или расходов по подписке не измерялось.

Полный парный прогон: **104 запроса**, **$0.286911**, **ноль ошибок API, неопределённых расходов, пропусков защитных канареек и критических ошибок**. Общая сумма включает калибровку и обе модели; её нельзя путать со стоимостью JEV на held-out. Отрицательные и прерванные эксперименты сохранены, а не отброшены ради положительного результата.

Дополнительные доказательства: [реальная активация профиля OMP](openspec/changes/jev-automatic-assistance/evidence/current-profile-activation.json), [запись настоящих API-ответов без секретов](openspec/changes/jev-automatic-assistance/evidence/skills-v2-api.cassette.json), [две независимые приёмки ACCEPT](openspec/changes/jev-automatic-assistance/evidence/oracle-verdicts.json). Проверки релиза: **538/538 тестов прошли**.

#### Управление

Текущий профиль OMP активирован. На новой установке JEV выключен, пока полный канонический бенчмарк v2 не пройдёт проверку и политика не будет однократно включена. После этого отдельные команды на каждой задаче не нужны.

```bash
node tools/jev-control.mjs status
node tools/jev-control.mjs disable
```

Ключ берётся из OS-хранилища или `OPENROUTER_API_KEY` / `JEV_API_KEY`, не из файлов репозитория. Фильтр чувствительных данных — защитный барьер, не универсальная DLP-гарантия. При изменении доказательств/каталога или истечении политики подсказки прекращаются до новой валидной оценки. Уже открытой сессии может понадобиться обычный reload; установщик не перезапускает daemon.

Маршрутизация моделей удалена по согласованному решению. Папка [`jev/`](jev/) — предоставленный пользователем **референс Claude-плагина**, а не действующая extension OMP; автоматически она не устанавливается. Реализация и команды оценки: [docs/jev.md](docs/jev.md).


### Обновление релизов

Обновления управляются через npm-пакет и команду `nullform update`:

```bash
# Проверка и предпросмотр доступного обновления:
nullform update --dry-run

# Применение обновления глобального пакета и сохранённой установки:
nullform update --yes
```

`nullform update` запрашивает метаданные версии из настроенного npm-реестра (или приватного/локального зеркала), обновляет глобальный исполняемый файл через `npm install -g` и запускает новый бинарник для перепроверки и синхронизации сохранённой установки (`~/.nullform/installation.json`).
- **Без Git**: Работает автономно без git-клона, локального репозитория и GitHub-тегов.
- **Сохранение данных**: Пользовательские инструкции, настройки, токены/секреты и сторонние файлы сохраняются без изменений.
- **Поведение при сбоях**: При ошибке реестра, npm или проверки doctor процесс завершается с ненулевым кодом и не рапортует об успешном обновлении; скрытый откат не выполняется.
- **Границы и требования**: Требуется Node.js `>=18.19.0` (`package.json` `engines.node`) и три зафиксированных парсера нативных конфигураций под форматы хостов (`jsonc-parser@3.3.1` для OpenCode JSONC, `json5@2.2.3` для OpenClaw JSON5, `yaml@2.9.1` для Hermes YAML). Публикация в публичный npmjs не входит в этот релиз (поставка через проверенный `.tgz` или приватный/локальный реестр). Механизм обновления полностью автономен от Git (нет Git-апдейтера; используются метаданные npm-реестра и `npm install -g`). Исполняемые файлы хостов (OMP, Claude Code, OpenCode, Cursor, OpenClaw, Hermes, OpenHuman, Codex) и ключи доступа — внешние зависимости; отсутствующие рантаймы хостов честно помечаются как `SETUP`, а не `FAIL`. Правила Cursor (`.cursor/rules/00-workflow.mdc`) требуют проектного контекста (`--project-root` или `--root`). Фоновый демон отсутствует.

### Документация, канон и инструменты

- **Портативное ядро и 4-Wave SDD**: [`core/PORTABLE.md`](core/PORTABLE.md) — независимая от среды спецификация процесса, роли (`orchestrator`, `designer`, `fixer`, `oracle`, `reviewer`, `librarian`, `explorer`, `sonic`), бережливый цикл A→B→A и протокол доказательств.
- **Глоссарий домена и топология**: [`CONTEXT.md`](CONTEXT.md) — устройство live/repo-деревьев, подстановка `<HARNESS>`, двойная приёмка на flash-моделях, Oracle-lite, бюджеты промптов, маркеры техдолга `defer:` и правила синхронизации.
- **Материалы и дашборд**: [`docs/`](docs/) — живой дашборд наблюдаемости (`node tools/dashboard.mjs --url`, автозапуск при `workflow.mjs start`).
- **JEV-ассистент и оценка пользы**: [`docs/jev.md`](docs/jev.md) — skills-only реализация, канонический парный бенчмарк, политика активации и CLI; результаты и ограничения приведены выше.
- **Законы агентов и шаблоны CI**: [`agent/AGENTS.md`](agent/AGENTS.md) · [`agent/agents/orchestrator.md`](agent/agents/orchestrator.md) · [`templates/ci/workflow-gate.yml`](templates/ci/workflow-gate.yml).
- **Проверка и сопровождение**: `node tools/verify.mjs --profile verify` (29 проверок) · `node tools/verify.mjs --profile audit` (15 проверок) · `node --test tools/tests/*.test.mjs`.
  - `node tools/workflow.mjs review-run --role <reviewer|oracle> --change <id> --model <provider/model> --base-ref <review-base> [--product-command JSON_ARGV] [--redo]` (oracle требует команду продукта) · `node tools/workflow.mjs stage-b --change <id> --phase before --test-cmd "<cmd>"`, затем `--phase after --test-cmd "<same-cmd>" --disposition <lean-already|simplified>`

### Привычки workflow (evidence-PR, session-retro, граф задач)

Три привычки из видео Matt Pocock о Skills v1.3 (https://www.youtube.com/watch?v=BsJGo1wFTvQ):

- **Evidence-PR** ([`requesting-code-review`](skills/requesting-code-review/SKILL.md)): тело каждого PR — по [`.github/pull_request_template.md`](.github/pull_request_template.md): Summary → Evidence (before → after, точная команда + сырой вывод) → Merge danger (one-way/two-way door) → Blast radius. Ревьюер отклоняет PR без evidence как P1+ — та же планка, что протокол доказательств оракула.
- **Session-retro** ([`session-retro`](skills/session-retro/SKILL.md), `node tools/session-retro.mjs scan`): ретроспектива по реальным `.jsonl`-логам сессий — ранжирует сессии со скрытыми потерями (ошибки/ретраи, тяжёлые чтения, длинные сессии, повторы команд) для ручного разбора. Находки применяются вручную через обычные лейны; автофиксы запрещены (уходят в петлю на ложных срабатываниях).
- **Граф задач + integration-ветка** ([`nullform-workflow-full`](skills/nullform-workflow-full/SKILL.md), Wave 2–3): у задач рёбра `blocked-by`, каждая волна сборки запускает готовый фронт, работа тикетов сливается в `feat/<name>-integration` для ревью ветки целиком. Однородные тикеты — детерминированным скрипт-циклом, а не агент-циклом.

---

## License / Лицензия

MIT
