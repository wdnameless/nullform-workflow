# Design — минимум движений

## Мусор (R01–R02)

- `git rm backups/pre-migration-*.db` (пустой SQLite 4К, артефакт PR #6) + `backups/` в `.gitignore` уже покрыт? Проверить; если нет — добавить. Локальный untracked `backups/` пользователя не трогать.
- Машинные пути в треке — только документационные примеры (`C:\path\to\x.mjs`, `C:\temp\test-home`) и упоминания старых фикстур в `.workflow-recon.md`/oracle-доках: это не сенсетив, оставить.
- `wdnameless`/`omp-paseo-nullform-workflow` в README и oracle-доках: заменить на новое имя/URL после rename; историю openspec не переписывать (audit trail).
- Личный email автора старых коммитов остаётся в истории (решение Wave 0: без rewrite). Новые коммиты — noreply.

## Бренд (R03)

Замена видимых строк: `README.md` заголовок, `install.ps1/install.sh` баннеры, адаптеры `install-harness.mjs` (названия «Workflow Adapter» → «NULLFORM WORKFLOW»). Старые CLI-флаги и пути не менять.

## README (R04)

Структура ≤120 строк: бейджи (CI, license) → one-liner → Quickstart (3 шага) → T0–T3 таблица (4 строки) → ссылки (docs/, CONTEXT.md, openspec). Детали остаются в `docs/` и `core/PORTABLE.md`. Два языка: EN основной, RU вторым блоком (или наоборот — решить при написании, короткие оба).

## Public (R05)

`gh repo edit --visibility public` (+ rename при желании `nullform-workflow`). После — rerun CI, зелёные минуты безлимитны.
