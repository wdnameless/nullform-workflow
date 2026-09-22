# Bug Sweep Report: workflow-repo

## P0: Блокирует установку

### 1. Синтаксическая ошибка в install.ps1 ломает установку и тесты
- **Файл:строка**: `install.ps1:464`
- **Доказательство**:
  - Команда: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File workflow-repo/install.ps1 -UserHome D:/TMP/test -SkipMcp -SkipPlugins -NonInteractive`
  - Вывод: `At D:\ohmypi\workflow-repo\install.ps1:464 char:36 ... Missing closing "}" in statement block ... ParserError: UnexpectedToken`
  - `tests/test-portability.ps1` падает на Test 1 с `Base installer failed with exit code 1`.
- **Почему баг**: Выражение `if ( -or $env:OS -eq "Windows_NT")` не содержит левого операнда у оператора `-or`, что приводит к синтаксической ошибке парсера PowerShell 5.1 и аварийному завершению работы инсталлера до выполнения каких-либо действий.
- **Минимальная правка**: Заменить на `if ($IsWindows -or $env:OS -eq "Windows_NT") {`.

## P1: Ломает поведение и синхронизацию

### 2. dashboard.mjs: возврат ошибки из асинхронного main() выходит с кодом 0
- **Файл:строка**: `tools/dashboard.mjs:2343-2345`
- **Доказательство**:
  - Команда: `node -e "const {spawnSync}=require('child_process'); const r=spawnSync('node', ['workflow-repo/tools/dashboard.mjs', '--unknown-flag'], {encoding:'utf8'}); console.log('Exit code:', r.status, 'stderr:', r.stderr.trim());"`
  - Вывод: `Exit code: 0 stderr: Ошибка: неизвестный параметр: --unknown-flag`
- **Почему баг**: Функция `main` объявлена как `async`. При прямом вызове `const res = main()` переменная `res` является `Promise` (`typeof res === "object"`). Проверка `if (typeof res === "number") process.exit(res)` никогда не срабатывает, из-за чего процесс выходит с кодом 0 даже при ошибке валидации аргументов (где возвращается 2).
- **Минимальная правка**: Заменить вызов на: `main(process.argv.slice(2)).then(code => { if (typeof code === "number") process.exit(code); });`.

### 3. Несуществующий файл в манифесте sync.ps1
- **Файл:строка**: `tools/sync.ps1:66`
- **Доказательство**:
  - Команда: `node -e "const fs=require('fs'); console.log(fs.existsSync('workflow-repo/skills/architecture-observability/SKILL.md'));"`
  - Вывод: `false`
- **Почему баг**: Навык `architecture-observability` был удален из репозитория в коммите b69d13c, но остался в массиве `$Manifest`. Если файл остался в живом харнессе, `sync.ps1` считает это дрейфом и при `-Promote` восстанавливает удаленный файл в репозиторий.
- **Минимальная правка**: Удалить строку 66 (`"skills\architecture-observability\SKILL.md`t$AgentsRoot"`) из `$Manifest`.

### 4. Отсутствие session_cost.py в CORE_TOOLS doctor.mjs
- **Файл:строка**: `tools/doctor.mjs:48-75`
- **Доказательство**:
  - Команда: `node -e "const {CORE_TOOLS}=await import('./workflow-repo/tools/doctor.mjs'); console.log(CORE_TOOLS.includes('session_cost.py'));"`
  - Вывод: `false`
- **Почему баг**: Инструмент `tools/session_cost.py` является частью каркаса, входит в `sync.ps1:78` и имеет тесты `test_session_cost.py`, но пропущен в массиве `CORE_TOOLS` в `doctor.mjs`. Проверка целостности инструментов (`tools-syntax` / `tools-smoke`) его не контролирует.
- **Минимальная правка**: Добавить `"session_cost.py"` в список `CORE_TOOLS` в `tools/doctor.mjs`.

## P2: Расхождения в документации

### 5. README.md заявляет несуществующий tools/package.json
- **Файл:строка**: `README.md:166` и `README.md:215`
- **Доказательство**:
  - Команда: `node -e "const fs=require('fs'); console.log(fs.existsSync('workflow-repo/tools/package.json'));"`
  - Вывод: `false`
- **Почему баг**: В README указано: `устанавливает зависимости инструментов (tools/package.json)`. В проекте принципиально нет npm-зависимостей и отсутствует `package.json`.
- **Минимальная правка**: Исключить упоминание `tools/package.json` из описания CI в `README.md`.

---
*Ponytail lens: net: -5 lines possible.*
