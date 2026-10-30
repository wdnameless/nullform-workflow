# fix-all-batch — interfaces

## T1: M1 python-COCO (owner: @fixer)

- `tools/session_cost.py`: разбить `parse_and_aggregate` (127→≤105) и
  `format_table` (35→≤23) выделением чистых функций (парсинг строк,
  агрегация по ролям, форматирование колонок); поведение байт-в-байт
  (существующий test_session_cost.py зелен без правок смысла).
- `.quality-baseline.json`: python rows меняются ТОЛЬКО ресидом остатка
  (если после сплита > baseline): значение := current + коммит с
  датой+причиной. Node rows не трогать.
- Проверка: локальный venv + pylint 4.1.3 + pylint-cognitive-complexity
  0.1.1 (как в repo-gate.yml:384-386) → 0 growth-failures.
- Не менять: CLI surface session_cost.py, другие python-файлы.

## T2: S1 toolAvailable (owner: @fixer)

- `tools/quality.mjs` `toolAvailable(argv, cwd)`: для path-like cmd без
  расширения на win32 пробовать `cmd + .exe/.cmd/.bat` через existsSync,
  затем `where cmd` (уже есть для не-path ветки). POSIX-путь без изменений.
- Тест в `tools/tests/u-quality.test.mjs`: QUALITY_PYTHON вида
  `.venv/Scripts/python` (без .exe) на фикстуре → available (мок spawnSync
  или фикстурный .exe-файл — на выбор владельца, без сети).
- Не менять: остальной quality.mjs, stacks.json, baseline.

## T3: S3 ledger (owner: @fixer)

- `tools/review/budget.mjs`: механизм удержания ledger ниже 1MiB на выбор
  владельца из двух: (a) settle-компакция (схлопывание settled в rollup
  при записи, инвариант rollup==sum сохранен — см. budget.mjs:327);
  (b) архив+rotate с тестом восстановления. Любой вариант: инварианты
  валидации (309-327) не слабее, MAX_LEDGER_BYTES не поднимать.
- Сам `.git/nullform-review-budget.json`: скомпактировать ниже 1MiB тем же
  механизмом (это data-fix, не код).
- Тест: ledger на грани → запись → размер < bound + rollup честен.
- Проверка: `review-run --dry-run` проходит admission (не ledger-refuse).

## T4: S2+S4 (owner: @sonic)

- S2: найти OMP-схему efforts (код OMP/вендор-док, путь назвать в контракте);
  если FCC-набор валиден — оставить + 1 строка коммента-источника; если нет —
  вернуть блок в коммент с причиной. Только models.yml.example.
- S4: append-only тест в `tools/tests/task-claim.test.mjs`:
  nested workspace (сабдир git-репо без своего .git) → baseCommit null.
  Существующие тесты не трогать.
