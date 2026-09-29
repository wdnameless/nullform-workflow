# Interfaces and ownership

Без смены публичных CLI-флагов и HTTP-форм. Только fail-closed ужесточения и один guard. Zero новых зависимостей.

| Consumer seam | Invariant | Owner and paths | Requirements |
|---|---|---|---|
| `sync-prune.mjs --delete`, `sync -Prune -Confirm` | Удаление только реальных путей внутри канонического harness; ссылка наружу — failed, не deleted | Sync worktree: `tools/sync-prune.mjs`, `tools/tests/sync-prune.test.mjs` | R01 |
| `sync --check/--deploy/--promote --harness/--agent-dir` | Висячий корень — отказ до I/O; каноникализация различает ссылку и реальный путь | Sync worktree: `tools/sync.mjs`, `tools/tests/sync.test.mjs` | R02 |
| `check-ci --tier T2/T3` | Оракул отдельно от кода: файлы change-каталога в том же коммите, что и первое появление оракула, — отказ; NUL dirty-check с точным `.workflow`-фильтром | Gate worktree: `tools/workflow.mjs`, `tools/tests/workflow-gate.test.mjs` | R03, R07 |
| `close --auto` | Любой бинарь в numstat — отказ; rename проверяет оба конца; обычный текстовый diff и cap без изменений | Gate worktree: `tools/workflow.mjs`, gate-тесты | R04, R05 |
| `install.ps1 -HarnessRoot` | Отказ до мутаций при цели внутри репо, кроме документированного in-place; тексты ошибок как в Node-инсталлере | Installer worktree: `install.ps1`, `tools/tests/test-portability.ps1` или новый `install-guard` тест | R06 |

Изолированные worktree под OS temp через `task(isolated:true)`. Писатели пропускают build/lint/tests mid-flight; родитель гоняет после интеграции. `backups/` не трогать.
