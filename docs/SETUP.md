# Nullform Workflow — Setup Guide

Три способа установки: от одной команды (skill) до полного CLI. Каждый шаг
оканчивается проверкой — вы всегда знаете, что установка удалась.

Требования: **Node.js ≥ 18.19** (для установки рекомендуются 22/24 LTS),
Git в PATH (для T3 worktrees), интернет для npm/skills.
После нескольких T3-слайсов проверяйте `node tools/worktree-doctor.mjs`: рабочие деревья
копится, а Git отказывается удалять ветку, пока её держит worktree. `--prune` убирает только
те, чья ветка уже влита и в которых нет незакоммиченной работы; всё остальное он только
перечисляет.

---

## Вариант A — Skill для AI-агента (1 команда, 1 минута)

Для Claude Code, Cursor, Codex, OpenCode и любого агента с поддержкой skills.

```bash
npx skills add wdnameless/nullform-workflow --skill nullform
```

Перезапустите агент (skills грузятся на старте). Проверка:

```bash
node tools/skills-doctor.mjs   # из checkout репозитория
```

Успех: `all checks passed (frontmatter, truncation, parity, orphans, names)`.

Что вы получили: процесс Briefing → Build → Review внутри вашего агента,
без отдельного CLI. Дальше — обычная задача агенту, уровни T0–T3 включаются
явно для сложной разработки.

---

## Вариант B — CLI-пакет из npm (полный харнесс, 5 минут)

```bash
npm install -g --ignore-scripts nullform-workflow
nullform init        # интерактивное меню: выберите свой харнесс
nullform doctor      # проверка установки
```

### Для AI-агента: `nullform setup`

`setup` — агентская команда: сама находит харнесс пользователя, объясняет
причину выбора и печатает план **до** любой записи.

```bash
nullform setup --dry-run            # только план, ничего не пишет
nullform setup --yes                # принять план и установить
nullform setup --harness cursor --project-root . --yes
nullform setup --json               # машинно-читаемый план и результат
```

Что печатается в плане: каждый найденный харнесс с причиной (`saved-state`,
`project marker …`, `home manifest …`, `command in PATH: …`), выбранная цель,
корень установки и список действий.

Коды выхода: `0` — установлено или уже стоит, `1` — отменено/ошибка,
`2` — неоднозначный детект без `--harness` и без `--yes` (fail-closed).
Без `--yes` в неинтерактивной сессии запись не выполняется: сначала план,
потом подтверждение.

### Самолечение: `nullform heal`

```bash
nullform heal --dry-run     # что будет починено, без изменений
nullform heal               # починить и перепроверить
nullform heal --json
```

Порядок: `doctor` → только разрешённые идемпотентные ремонты
(`reapply-installation`, `restore-managed-files` по хешам из состояния) →
`doctor` снова. Здоровая установка — no-op. Ремонт вне allow-list не
выполняется: команда останавливается и сообщает причину.

Без диалога (примеры):

```bash
nullform init --harness opencode --yes
nullform init --harness cursor --project-root . --yes
```

Адаптеры: **Claude Code · Codex · OpenCode · Cursor · OMP · OpenClaw · Hermes · OpenHuman**.

### Как понять, что установилось

`nullform doctor` печатает построчный отчёт. Здоровая установка:

```text
✓ [PASS] node / harness-files / tools-syntax / tools-smoke / configs / ...
Итог: pass=9 fail=0 warn=4 skip=3 — OK
```

Правила чтения:
- `fail=0` — установка рабочая. WARN допустимы (объяснены ниже).
- `agent-wiring` WARN в режиме repo — норма: checkout не привязан к агенту.
- `version-alignment` WARN — запустите `nullform update` (см. ниже).
- Любой `FAIL` — установка не завершена; читайте `detail` строки.

Дымовой тест workflow (60 секунд, в любом каталоге):

```bash
nullform workflow start --tier T1 --task "Проверить установку"
nullform workflow artifact --kind recon --detail "Файлы: нет; проверка: команды отвечают."
nullform workflow check     # должно быть COMPLETE
nullform workflow close
```

---

## Вариант C — Из исходников (для разработки и аудита)

```bash
git clone https://github.com/wdnameless/nullform-workflow.git
cd nullform-workflow
npm ci
node tools/verify.mjs --profile verify   # или --profile audit
node --test tools/tests/*.test.mjs
```

Локальный bin вместо глобального: `node bin/nullform.mjs <команда>`.
Dashboard из исходников: `node tools/dashboard.mjs --url`.

---

## Обновление

```bash
nullform update --dry-run   # посмотреть, что изменится
nullform update --yes       # обновить пакет и перепроверить харнесс
```

Выбранный харнесс и путь сохраняются. Фонового автообновления нет — команда
всегда запускается явно. Человеческие файлы сохраняются с пометкой
`preserved-assets`; неизменённые файлы Nullform обновляются молча.

***

## Частые проблемы

| Симптом | Причина | Действие |
|---|---|---|
| `node not found` | Нет Node.js в PATH | Установите Node 18+ с nodejs.org |
| doctor FAIL на tools-syntax | Битый checkout | Переустановите: `npm install -g --ignore-scripts nullform-workflow` |
| `version-alignment` WARN | Пакет новее установки | `nullform update --yes` |
| Skill не виден агенту | Нет рестарта | Перезапустите агент после `npx skills add` |
| `omp not found` WARN | OMP не в PATH | Установите OMP или выберите другой харнесс |

## Дальше

- [README](../README.md) — как работать (уровни T0–T3), структура, ограничения.
- [Benchmark](benchmark-live.md) — живые цифры против Autopilot.
- `nullform evidence` — проверяемые свидетельства качества (и честные границы).
- `nullform capabilities` — границы поддержки вашего адаптера.
