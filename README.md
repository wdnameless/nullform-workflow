# NULLFORM WORKFLOW

[![CI](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Portable engineering workflow harness for AI coding agents — hard gates over promises, verified tests over "done", live observability over guesswork.**  
**Переносимый инженерный каркас разработки для ИИ-агентов: строгие гейты вместо обещаний, проверенные тесты вместо «готово», наблюдаемость вместо догадок.**

Built for **Oh My Pi (OMP)** and **Paseo** with portable adapter generators for **Claude Code**, **Codex**, **OpenCode**, and **Cursor** on Windows, Linux, and macOS. Zero external npm dependencies (Node.js 18+ stdlib only) · 8 specialized roles · 69 skills · 33 CLI tools · 29 install & 15 audit checks.

![NULLFORM WORKFLOW Live Dashboard](docs/assets/dashboard-graph.jpg)

---

## English

### Quickstart (3 Steps)

**1. Clone the repository**
```bash
git clone https://github.com/wdnameless/nullform-workflow.git "$HOME/nullform-src"
cd "$HOME/nullform-src"
```

**2. Install the adapter for your harness** (`omp|claude|codex|opencode|cursor|all` or `auto`)
```bash
node tools/install-harness.mjs --harness auto --root .
# Or full OMP + Paseo + MCP fleet setup on Windows:
# powershell -ExecutionPolicy Bypass -File install.ps1 -SecretsFile secrets.env
```

**3. Verify environment & run your first gated task**
```bash
node tools/doctor.mjs --harness .
node tools/workflow.mjs start --tier T1 --task "smoke check"
node tools/workflow.mjs artifact --kind recon --detail "environment verified"
node tools/workflow.mjs close
```

### Work Tiers (T0–T3)

| Tier | Scope / When to Use | Required Gates & Artifacts (`tools/workflow.mjs`) |
|---|---|---|
| **T0** | 1–2 known files, trivial local fix | Declared tier (`start --tier T0` → `close`); supports guarded `--auto` (`--max-diff <= 20`) |
| **T1** | 3+ files or unfamiliar area | Reconnaissance (`recon` artifact) before edits + verification before `close` |
| **T2** | Architecture change or new module | 4-Wave SDD: `manifest.md` (`R##`), OpenSpec `proposal/tasks/specs`, `interfaces.md`, blind `oracle` ACCEPT |
| **T3** | Multi-feature program or cross-cutting epic | Full T2 contract and blind Oracle acceptance per vertical slice |

### Key Commands & Architecture Links

- **Core Protocol & 4-Wave SDD**: [`core/PORTABLE.md`](core/PORTABLE.md) — harness-agnostic specification, roles (`orchestrator`, `designer`, `fixer`, `oracle`, `reviewer`, `librarian`, `explorer`, `sonic`), Lean A→B→A stage rhythm, and evidence protocol.
- **Domain Glossary & Topology**: [`CONTEXT.md`](CONTEXT.md) — definitions of live/repo trees, `<HARNESS>` substitution, Oracle-lite, dual-pass flash-class acceptance, prompt budgets, `defer:` debt markers, and sync/prune semantics.
- **Documentation & Visual Assets**: [`docs/`](docs/) — dashboard overview and visual artifacts (`node tools/dashboard.mjs --url`).
- **JEV Assistance & Evaluation**: [`docs/jev.md`](docs/jev.md) — paired evaluation protocol, activation policy, and local control CLI (inactive by default pending empirical proof).
- **Always-On Agent Laws & Roles**: [`agent/AGENTS.md`](agent/AGENTS.md) · [`agent/agents/orchestrator.md`](agent/agents/orchestrator.md) · [`agent/plugins.json`](agent/plugins.json).
- **Verification, Sync & Quality Gates**:
  - `node tools/verify.mjs --profile verify` (29 install checks) · `--profile audit` (15 health checks)
  - `node tools/sync.mjs --check | --promote | --deploy | --prune` (wrapper scripts: `tools/sync.sh`, `tools/sync.ps1`)
  - `node tools/code-size.mjs check` · `node tools/debt-ledger.mjs scan --check` · `node tools/prompt-lint.mjs sizes --check`
  - `node tools/test-lens.mjs` · `node tools/benchmark.mjs` · `node tools/usage-audit.mjs` · `node tools/auto-review.mjs --root .`
  - CI template: [`templates/ci/workflow-gate.yml`](templates/ci/workflow-gate.yml) · Unit tests: `node --test tools/tests/*.test.mjs`

---

## Русский

### Быстрый старт (3 шага)

**1. Склонируйте репозиторий**
```bash
git clone https://github.com/wdnameless/nullform-workflow.git "$HOME/nullform-src"
cd "$HOME/nullform-src"
```

**2. Установите адаптер под ваш харнесс** (`omp|claude|codex|opencode|cursor|all` или `auto`)
```bash
./install.sh --harness auto --root .
# Или на любой ОС через Node.js:
node tools/install-harness.mjs --harness auto --root .
# Полная установка OMP (плагины, MCP-флот, Paseo) на Windows:
# powershell -ExecutionPolicy Bypass -File install.ps1 -SecretsFile secrets.env
```

**3. Проверьте установку и запустите первую задачу**
```bash
node tools/doctor.mjs --harness .
node tools/workflow.mjs start --tier T1 --task "проба"
node tools/workflow.mjs artifact --kind recon --detail "проверка окружения и инструментов"
node tools/workflow.mjs close
```

### Ярусы задач (T0–T3)

| Ярус | Когда применяется | Обязательные гейты и артефакты (`tools/workflow.mjs`) |
|---|---|---|
| **T0** | 1–2 известных файла, локальная правка | Объявленный ярус (`start --tier T0` → `close`); доступен защищённый `--auto` (`--max-diff <= 20`) |
| **T1** | 3+ файлов или незнакомая область | Рекогносцировка (`recon`) до правок и верификация перед `close` |
| **T2** | Архитектура или новый модуль | 4-Wave SDD: `manifest.md` (`R##`), OpenSpec `proposal/tasks/specs`, `interfaces.md`, слепая приёмка `oracle` (ACCEPT) |
| **T3** | Программа из нескольких фич | Полный цикл T2 и слепая приёмка Оракула на каждый вертикальный срез |

### Документация, канон и инструменты

- **Портативное ядро и 4-Wave SDD**: [`core/PORTABLE.md`](core/PORTABLE.md) — независимая от среды спецификация процесса, роли (`orchestrator`, `designer`, `fixer`, `oracle`, `reviewer`, `librarian`, `explorer`, `sonic`), бережливый цикл A→B→A и протокол доказательств.
- **Глоссарий домена и топология**: [`CONTEXT.md`](CONTEXT.md) — устройство live/repo-деревьев, подстановка `<HARNESS>`, двойная приёмка на flash-моделях, Oracle-lite, бюджеты промптов, маркеры техдолга `defer:` и правила синхронизации.
- **Материалы и дашборд**: [`docs/`](docs/) — живой дашборд наблюдаемости (`node tools/dashboard.mjs --url`, автозапуск при `workflow.mjs start`).
- **JEV-ассистент и оценка пользы**: [`docs/jev.md`](docs/jev.md) — парный бенчмарк, политика активации и локальное управление CLI (отключён по умолчанию до подтверждения пользы).
- **Законы агентов и шаблоны CI**: [`agent/AGENTS.md`](agent/AGENTS.md) · [`agent/agents/orchestrator.md`](agent/agents/orchestrator.md) · [`templates/ci/workflow-gate.yml`](templates/ci/workflow-gate.yml).
- **Проверка и сопровождение**: `node tools/verify.mjs --profile verify` (29 проверок) · `node tools/verify.mjs --profile audit` (15 проверок) · `node --test tools/tests/*.test.mjs`.

---

## License / Лицензия

MIT
