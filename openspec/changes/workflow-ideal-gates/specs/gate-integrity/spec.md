# Workflow evidence integrity

## ADDED Requirements

### Requirement: Oracle ships separately from code

Первый коммит с oracle-файлом не должен содержать других файлов change-каталога.

#### Scenario: All-in-one commit
- **WHEN** `oracle.md ACCEPT` и `evil.js` в одном коммите
- **THEN** `check-ci --tier T2` возвращает 1 с указанием на mixed commit.

#### Scenario: Honest separate commits
- **WHEN** оракул закоммичен отдельно, код — позже без изменений после
- **THEN** `check-ci` проходит как раньше.

### Requirement: Binary diffs MUST refuse auto-close

Любая строка numstat с `-` в счётчиках обязана давать отказ guarded-auto: бинарный объём неизмерим строками.

#### Scenario: Binary under allow
- **WHEN** T0 `--auto --allow 'bin/**' --max-diff 100`, изменён 5-МБ бинарь
- **THEN** `close` возвращает 1 (binary not measurable), задача открыта.

### Requirement: Renames MUST check both ends

Парсер numstat обязан разбирать `{old => new}` и `old => new` и проверять оба конца через allow-паттерн.

#### Scenario: Rename escapes allow
- **WHEN** `git mv src/ok lib/evil` при `--allow 'src/**'`
- **THEN** `close` возвращает 1 с указанием цели вне allow.

#### Scenario: Rename inside allow
- **WHEN** переименование внутри `src/**`
- **THEN** `close` ведёт себя как раньше (по строкам numstat).

### Requirement: Dirty-check MUST use NUL parsing

Проверка незакоммиченных изменений обязана использовать NUL-разбор и точный сегментный фильтр `.workflow/`.

#### Scenario: Newline in filename
- **WHEN** untracked файл с `\n` в имени
- **THEN** dirty-check его видит целиком, а не двумя строками.

#### Scenario: Similar directory name
- **WHEN** существует `my.workflow/x`
- **THEN** фильтр `.workflow/` его не скрывает.
