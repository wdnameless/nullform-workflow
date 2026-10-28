# universal-slices-wizard — interfaces

## T1: gates reuse (owner: @fixer)

- `tools/changed-scope.mjs`: `findMatchingSuite(root, target, suitesDir?)`
  (3-й опциональный параметр, дефолт `tools/tests`); `resolveRoot(explicit?)`
  вместо захардкоженного ROOT в гейтах (гейты принимают --root).
- `tools/mutation-changed.mjs`, `tools/coverage-changed.mjs`: CLI +`--root .`,
  +`--suites <dir>` (дефолт tools/tests); все пути через resolveRoot.
  Поведение без флагов байт-в-байт (регрессия покрыта существующими тестами).
- `tools/clone-coverage.mjs`: загрузчик `.clone.json` (`{scope:[...]}`) из
  --root; без файла — текущий DEFAULT_SCOPE. Экспорт `loadScope(root)`.
- `bin/nullform.mjs`: `quality` passthrough + `code-size` сабкоманда
  (`nullform quality code-size check --root X` → tools/code-size.mjs).
  HARNESS_MENU_ITEMS не трогать (зона T2).
- `docs/GATES.md`: таблица 5 гейтов × (команда, пороги, scope-файл,
  zero-dep?) + пример CI-шага для чужого проекта. ≤80 строк.
- Тесты: --root на фикстурном чужом дереве (без tools/tests); .clone.json
  override; quality code-size passthrough exit 0.

## T2: wizard+matrix (owner: @fixer)

- NEW `tools/harness-matrix.json`: `[{id,label,description,detect:{env|file|cmd},
  install:{userHome,projectPaths[]},scopes:[user|project],runtime:verified|
  declared|unverified}]` для omp/claude/codex/hermes/openhuman/cursor/opencode/
  openclaw/custom. MIT-идея agency tools.json → attribution в шапке.
- `bin/nullform.mjs` init: меню из матрицы (замена HARNESS_MENU_ITEMS чтением
  JSON с фолбэком на константу при битой матрице); шаги после harness:
  flow (quick/advanced) → slices (multi: S0 всегда, S1/S2/S3/S4 toggle) →
  dry-run preview → confirm; `..` = шаг назад (кроме irreversible write);
  non-TTY/CI → дефолты (quick, все слайсы, dry-run print, no write).
  Слайсы как install-опции: S1 = docs+GATES-ссылки, S2 = agent/agents копия,
  S3 = matrix+init (self), S4 = prompts копия. quick = всё.
- NEW `tools/tests/init-wizard.test.mjs`: piped stdin сценарии (quick-path,
  back-навигация, non-TTY дефолты) через deps-инъекцию runInit (stdin/session
  уже инжектятся — см. runInit deps).
- Не менять: adapters.mjs, profiles.mjs, install-harness.mjs.

## T3: docs+prompt (owner: @sonic)

- `docs/SLICES.md`: S0..S4 (назначение, файлы, зависимости только вниз),
  L0..L3 (gates-only → lanes → full SDD → managed) с маппингом на слайсы,
  clack-рекомендация для форков. ≤100 строк.
- `docs/AGENT-INTEGRATION.md`: инструкция юзеру (дай агенту промпт →
  получи аудит+L-уровень→план). ≤60 строк.
- `prompts/integration.md`: сам промпт (копипаста): шаги аудита
  (детект харнесса/CI/тестов/гейтов) → выбор L0..L3 (критерии) → план
  установки по шагам wizard. ≤80 строк. Ссылки на SLICES/GATES.
- Термины слайсов/уровней — ровно как в interfaces (S0..S4, L0..L3).

## T4: roles one-liners (owner: @sonic)

- `reviewer.md` <criteria>: +`NEXUS escalation: 3rd failed fix round on the
  same defect → HANDOFF with root-cause + tried/failed table (no 4th attempt).`
- `oracle.md` Rules: +`REALITY CHECKER: default NEEDS-WORK; a zero-issue
  report or A+ self-rating is a red flag — demand proof or REJECT.`
- По 1 строке, формат файла не менять.
