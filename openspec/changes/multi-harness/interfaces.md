# Interfaces: multi-harness

## Слайс A — адаптеры (первый, Wave 0: R07i)
Владелец файлов:
- `tools/install-harness.mjs` — +3 case-ветки (openclaw/hermes/openhuman): defaultRoot, detect-сигналы, генерация skills+agents+rules+mcp, help-текст. Шов: 7 точек из InstallSeamProbe §2.
- `tools/tests/install-harness.test.mjs` — 3 теста по канон-паттерну (≤60 строк адаптера, нет `<HARNESS>`, пути резолвятся) + detect-тест.
- `README.md` — секция «Установка одной фразой» с промптом (R03).

Контракты адаптеров (из HarnessFormatsProbe, проверено 2026-10-09):
- openclaw: skills → `~/.openclaw/skills/<name>/SKILL.md` (+ чтение `~/.agents/skills/`); agents → `agents.entries.<id>` в `openclaw.json` + `AGENTS.md`/`SOUL.md`/`USER.md` в workspace; mcp → ключ `mcp.servers`.
- hermes: skills → `$HERMES_HOME/skills/` (+ `.agents/skills` при trusted); agents → `AGENTS.md` + profiles; mcp → `mcp_servers` в `config.yaml`.
- openhuman: skills → `agents/<id>/skills/<name>/SKILL.md` копированием (симлинки запрещены); agents → `AGENTS.md` + AgentSpec; mcp — только чтение `openhuman-core mcp` (без записи чужого ядра).

## Слайс B — версионирование и обновление (второй)
Владелец файлов:
- `VERSION` (новый, SemVer) + `tools/self-update.mjs` (новый): `check` (сравнить с GitHub latest release, JSON+human) и `update` (git pull/ff-only + reinstall идемпотентно + doctor).
- `tools/doctor.mjs` — check `release-drift`: WARN при отставании от релиза (не FAIL).
- `tools/sync.mjs` — бэкап live-файлов перед deploy-перезаписью (закрывает риск №1 InstallSeamProbe).
- Тесты: `tools/tests/self-update.test.mjs` (mock releases), расширение sync-тестов на бэкап.

## Общие правила
- Один владелец на файл; слайсы в disjoint worktrees; shared prerequisite (manifest/interfaces) — inline до спавна.
- Расширение SUPPORTED_HARNESSES — только через 7 точек шва, без новых механизмов.
- Никаких новых MCP/зависимостей; версионирование через git tags + GitHub Releases API (read-only, https).
