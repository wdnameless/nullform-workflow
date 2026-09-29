# Design — точечные fail-closed правки

## Prune (R01)

`deletePruneCandidates`: после лексической проверки резолвить `realpathSync(full)` и сравнивать с каноническим `realpathSync(harnessRoot)`. Несоответствие — `failed`, не `deleted`. `lstat`-проверка `isFile()` остаётся, чтобы не трогать каталоги. Поведение на обычных файлах не меняется.

## Висячий корень (R02)

`getCanonicalPath`: для dangling-ссылки возвращать `null`, а не сырой target. Тогда `validatePathWithinRoot` вернёт false для любого declaredRoot-ссылки без цели. Дополнительно: если `lstat(declaredRoot)` — symlink, требовать резолв цели до проверки детей. Обычные существующие корни не затрагиваются.

## Оракул отдельно от кода (R03)

В `validateCheckCiGit`: после нахождения `oracleCommit` проверять `git diff-tree --no-commit-id --name-only -r <oracleCommit>` (файлы самого коммита). Если среди них есть файл change-каталога, отличный от oracle-файлов, — отказ «оракул и код в одном коммите». Пустой diff `oracleCommit..HEAD` при этом больше не трактуется как «чисто». Альтернатива diff внутри коммита отвергнута виджетом.

## Бинари и rename (R04–R05)

`measureAutoDiff`: строка numstat с `-` в любом счётчике — немедленный отказ «binary file ... not measurable». Парсер rename: разбирать `{old => new}` и `old => new`, проверять оба конца через allow и считать строки обоих (строки берёт numstat, он для rename даёт 0/0 — проверка идёт по путям, не по объёму). Обычные текстовые пути без изменений.

## install.ps1 (R06)

В начало, до создания каталогов: резолв `HarnessRoot` через `Resolve-Path`/абсолютный путь; отказ если равен `$PSScriptRoot` (in-place делает только Node-инсталлер документированным путём) или строго внутри него. Текст ошибки — как в `install-harness.mjs` («Cannot install harness into ...»). Pester/Node-тест на отказ без мутаций.

## NUL dirty-check (R07)

`validateCheckCiGit`: `git -c core.quotepath=false status --porcelain -z -uall -- .` + NUL-сплит, как в `getPorcelainEntries`; фильтр `.workflow/` — точный (равенство сегментов пути после нормализации), а не подстрока. Имена с `\n` больше не рвут разбор.
