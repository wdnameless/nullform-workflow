# Nullform Workflow

**Проверяемый процесс разработки поверх вашего AI-харнесса.**

Обычная работа — напрямую. Строгий протокол T0–T3 — для сложной разработки.

[![npm](https://img.shields.io/npm/v/nullform-workflow?color=171717)](https://www.npmjs.com/package/nullform-workflow)
[![CI](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/repo-gate.yml)
[![typos](https://github.com/wdnameless/nullform-workflow/actions/workflows/typos.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/typos.yml)
[![actionlint](https://github.com/wdnameless/nullform-workflow/actions/workflows/actionlint.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/actionlint.yml)
[![agnix](https://github.com/wdnameless/nullform-workflow/actions/workflows/agnix.yml/badge.svg)](https://github.com/wdnameless/nullform-workflow/actions/workflows/agnix.yml)
[![MIT](https://img.shields.io/badge/license-MIT-171717)](LICENSE)
[![skills.sh](https://skills.sh/b/wdnameless/nullform-workflow/nullform)](https://skills.sh/wdnameless/nullform-workflow/nullform)

[Установка за 1 минуту](#установка-за-1-минуту) · [Как работать](#как-работать) · [Почему Nullform](#почему-nullform) · [Структура](#структура) · [Доказательства](#доказательства-а-не-обещания)

---

## Установка за 1 минуту

**Skill для AI-агента** (Claude Code, Cursor, Codex, OpenCode и другие):

```bash
npx skills add wdnameless/nullform-workflow --skill nullform
```

Перезапустите агент. Готово — процесс Briefing → Build → Review внутри него.

**Полный CLI-харнесс:**

```bash
npm install -g --ignore-scripts nullform-workflow
nullform init       # выберите свой харнесс
nullform doctor     # fail=0 -> OK
```

📖 Полный гайд с проверками каждого шага: **[docs/SETUP.md](docs/SETUP.md)** —
три способа установки, чтение отчёта doctor, дымовой тест за 60 секунд,
обновление, частые проблемы.

---

## Как работать

Дайте агенту обычную задачу. Уровни ниже — явно включаемый строгий протокол
для разработки, а не обязательный режим каждого запроса.

```text
Задача → уровень сложности → работа → проверка → закрытие
```

| Уровень | Когда | Что требуется |
| --- | --- | --- |
| **T0** | Очевидная правка в 1–2 известных файлах | Объявить уровень |
| **T1** | Несколько файлов или незнакомый участок | Разобраться в коде и записать план проверки |
| **T2** | Новый модуль или архитектурное изменение | Требования R##, OpenSpec, независимая приёмка |
| **T3** | Несколько фич | T2 по частям и изолированные рабочие деревья |

```bash
nullform workflow start --tier T1 --task "Исправить экспорт отчёта"
nullform workflow artifact --kind recon --detail "Файлы: модуль экспорта; проверка: запустить экспорт."
# Выполните изменение и реальную проверку.
nullform workflow check
nullform workflow close
```

Dashboard: `node tools/dashboard.mjs --url` в checkout исходников.
[Пример интерфейса](docs/assets/dashboard-graph.jpg).

`start` сам поднимает дашборд и печатает живой адрес, проверенный пробой:
`dashboard: http://localhost:4200`. Если поднять не удалось — печатается
`dashboard: unavailable (<причина>)`; молчаливого пропуска нет. Отключить:
`--no-dashboard` или `NF_NO_DASHBOARD=1`.

Установка и починка без диалога (агентские команды):

```bash
nullform setup --dry-run   # план: что найдено, почему, что будет изменено
nullform setup --yes       # установить по этому плану
nullform heal              # doctor -> разрешённый ремонт -> doctor
```

Параллельные фичи — по одной изолированной папке на фичу, один писатель
на папку ([подробности](#параллельные-фичи)).

---

## Почему Nullform

**Харнесс даёт агенту инструменты. Nullform добавляет правила работы и проверку результата.**

| | Только ваш харнесс | Харнесс + Nullform |
|---|---|---|
| Процесс | Режимы клиента и ваши инструкции | Native-инструменты по умолчанию; T0–T3 явно для сложного |
| Готовность | Проверки клиента или проекта | Реальная проверка результата + CLI-гейты |
| Ревью | Возможности клиента | Opt-in Node-транспорт с денежным лимитом и pinned-снапшотом |
| Несколько агентов | Инструменты клиента | Native delegation; иначе — один агент, не новый loop |
| Переносимость | Настройка каждого клиента | 8 адаптеров + декларативный custom-контракт |
| Наблюдаемость | Логи и интерфейс клиента | Отчёт reuse/enable/manual/skip; dashboard по требованию |

Адаптеры: **Claude Code · Codex · OpenCode · Cursor · OMP · OpenClaw · Hermes · OpenHuman**.

Живые цифры против Autopilot v2.0 (наш T3-прогон vs их T2): **−29% времени,
0 ремонтов, ACCEPT с первого прогона** — [docs/benchmark-live.md](docs/benchmark-live.md).

---

## Структура

| Где | Ответственность |
|---|---|
| `bin/nullform.mjs` | `init`, `inspect`, `doctor`, `update`, `workflow`, `capabilities`, `evidence` |
| `tools/installation/` | Профили, адаптеры, установка, восстановление |
| `tools/review/` | Допуск расходов, контролируемый HTTP, evidence |
| `tools/workflow/` | Владение задачами, изолированные worktrees |
| `tools/*.mjs` | Реальные CLI-входы; zero dependencies |
| `agent/AGENTS.md` | Короткий native-first bootstrap |
| `core/PORTABLE.md` | Канонический строгий протокол (on-demand) |
| `skills/` | Opt-in skills: Elegant Objects, Angry Tests, DDD, TDD и другие |

## Параллельные фичи

```bash
nullform workflow workspace --feature export-report
# Передайте агенту возвращённый cwd. Чистые коммиты. Затем:
nullform workflow integrate --feature export-report
```

Общие предпосылки коммитьте заранее (worktree создаётся из HEAD).
Конфликты остаются видимыми интегратору.

## Обновление

```bash
nullform update --dry-run   # посмотреть
nullform update --yes       # обновить
```

Без фонового автообновления. Человеческие файлы сохраняются (`preserved-assets`).

## Что важно знать

- CLI-гейты — Node.js во всех 8 адаптерах. Денежный резерв `review-run` берётся до отправки; скрытых ретраев нет.
- Лимит `review-run` не охватывает вызовы самого клиента — маршрут выбирайте явно до делегирования.
- Delete-guard — отдельное OMP-расширение, не часть минимальной установки.
- Подробнее: [docs/SETUP.md](docs/SETUP.md) (частые проблемы) и полный текст ниже.

<details>
<summary>Полные оговорки, контракт качества, разработка</summary>

### Продуктовый контракт качества — unreleased

В исходниках `auto-review` проверяет **проект пользователя**: запускает
`build`, `typecheck`, `lint`, `test`; `--require` добавляет обязательные
скрипты, `--check` — команды других стеков:

```bash
node tools/auto-review.mjs --root /path/to/app --require build --require test --json
node tools/auto-review.mjs --root /path/to/python-app --check '["python","-m","pytest"]' --json
```

Пределы runner: 120 секунд и 1 MiB вывода на команду. Статусы: `pass`,
`fail`, `not-applicable`, `unverified`; обязательная невыполненная проверка
блокирует PASS.

### Ограничения

- Delete-guard запрашивает подтверждение опасных Git-восстановлений, но это не sandbox.
- Восстановление установки проверено при прерывании процесса, не при потере питания.
- Неопределённый lock интеграции не снимается автоматически — проверьте владельца.

### Для разработки и аудита

```bash
git clone https://github.com/wdnameless/nullform-workflow.git
cd nullform-workflow
npm ci
node tools/verify.mjs --profile verify   # или --profile audit
node --test tools/tests/*.test.mjs
```

[Переносимый контракт](core/PORTABLE.md) · [Термины](CONTEXT.md) · [Роли](agent/agents/) · [JEV](docs/jev.md)

</details>

## Доказательства, а не обещания

Общее улучшение качества/скорости/стоимости **не доказано** (`not-proven`):
в сохранённых сравнениях три пары дали одинаковую точность при ~двойном
расходе кандидата. SDK-тарифы не сверены со счетами. Новых платных A/B нет.

Что измерено честно: [benchmark-live](docs/benchmark-live.md) (наш T3 vs их T2),
[исправленные дефекты](openspec/changes/oss-product/evidence-comparison.md),
[приёмка релиза](openspec/changes/portable-product-release/oracle-final-publication.md).
В checkout: `nullform evidence`.

## Лицензия

[MIT](LICENSE). Сторонние assets: Apache 2.0 (`skill-creator`, `ui-styling`,
`frontend-design`); SIL OFL 1.1 (шрифты `ui-styling/canvas-fonts`); MIT —
anti-slop порты и адаптация [yegor256/prompt](https://github.com/yegor256/prompt)
(CI-линтеры, Elegant Objects, Angry Tests).
