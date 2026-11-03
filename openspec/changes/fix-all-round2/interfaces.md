# fix-all-round2 — interfaces

## T1: D1 CFR (owner: @fixer)

- `tools/cfr-report.mjs`: NEW `normalizeSince(s)` (export для тестов):
  `7d`/`30d` → `7.days.ago`/`30.days.ago`; уже-длинные формы — как есть;
  мусор → throw с текстом. `readGitLog`: пустой stdout при непустом
  репо (`git rev-parse --is-inside-work-tree` + хотя бы 1 коммит) →
  throw `cfr-empty-log`; main ловит → stderr + exit 2.
- Тесты: append в tools/tests/cfr-report.test.mjs: normalizeSince
  таблица + empty-log fail-loud (стаб execFileSync).
- Ориентир истины: 30d → total=318 feat=62 fix=109 (HEAD 3fae184, 2026-11-03).

## T2: D2 dashboard (owner: @fixer)

- Диагностика сначала: что жрёт 7.5s до первого байта (коллекторы?
  синхронный сбор?) + loopback-bind vs внешний Paseo-хост.
- Фикс на выбор исполнителя, acceptance одно: открытие из Paseo.
  Запасной выход: доказанный внешний корень + обходной путь в доке.
- dashboard-ui.mjs у потолка (1564/1570): только чтение, не править.
- Тесты: существующие + ручное открытие из Paseo (скрин/лог).

## T3: A1 lifecycle-evals (owner: @fixer)

- NEW `tools/lifecycle-evals.mjs` CLI: `node tools/lifecycle-evals.mjs check`
  exit 0/1; кейсы: pickup→claim ok; double-claim→409; approval→deny path;
  backoff-повтор. Детерминизм: фикстуры, без сети/таймеров.
- CI: append step в repo-gate.yml (node-профиль) — запуск сьюта.
- Тесты: tools/tests/lifecycle-evals.test.mjs — те же кейсы unit-уровнем.

## T4: A2 locks+settle (owner: @fixer)

- `claims.mjs`: `claimTask` на уже-claimed таску → throw `{code: 409}`
  (текст `already-claimed`); export `isClaimed(root, task)` для evals.
- `workflow.mjs`: NEW `settle --change <name> --yes`: без `--yes` → отказ
  текстом (ничего не удаляет); с `--yes` → удаление worktree/ветки change.
  Стиль отказа — как у budget-гейта (код + текст).
- Тесты: append в task-claim.test.mjs: 409 на двойной claim; settle без
  --yes не трогает FS; с --yes убирает фикстурный worktree.

## T5: A3+A5+B2+B3 (owner: @sonic)

- A3: дока (docs/ рядом с sync): кто источник правды live-vs-repo для
  скиллов + что делает оператор при parity-DRIFT. `sync --check` вывод
  не ломать, только документировать интерпретацию.
- A5: NEW `tools/gate-counter.mjs`: append-only JSONL
  `{t, gate, role?, result}` в `.workflow/gate-counts.jsonl` (gitignored);
  CLI `tally` печатает сводку; вызов — из workflow.mjs check/close +
  quality/code-size (минимум: workflow check). Без сети, без PII.
  Тесты: инкремент + tally на tmp-файле.
- B2: GATES.md: секция "split-vs-reseed" ≤20 строк: когда сплит, когда
  ресид с датой+причиной, примеры из M1/B2.
- B3: PORTABLE.md §5: абзац "blind-oracle-only — норма для обычных T2;
  keyed review-run — только релизы/деньги". Без переписывания секции.

## T6: B1+B4 (owner: @fixer)

- B1: workflow.mjs 2388→≤2500 соблюдён уже; работа: снизить дальше
  (вынос в существующие модули, без новых абстракций) ИЛИ обновить
  тикет #16 планом сплита. Минимум: #16 обновлён.
- B4: `tools/install-harness.mjs`: детект prepared store → reuse вместо
  полной копии; ключ: наличие маркера стора + сверка версии.
  Тесты: append в install-harness.test.mjs: повторный install реюзает
  (ассерт на маркер/вызов копирования).
