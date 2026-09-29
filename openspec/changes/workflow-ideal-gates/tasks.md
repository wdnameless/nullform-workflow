# Tasks — идеальные гейты

- [ ] R01–R02 Sync worktree: красные регрессии prune-junction и dangling-root; realpath-сверка в `sync-prune.mjs`, `null` для висячих ссылок в `sync.mjs`. Родитель гоняет тесты и CLI-smoke после.
- [ ] R03–R05, R07 Gate worktree: красные регрессии same-commit oracle, binary numstat, rename через allow-границу, NUL dirty-check; правки `workflow.mjs` без новых абстракций. Родитель гоняет тесты и CLI-smoke после.
- [ ] R06 Installer worktree: guard в `install.ps1` + тест отказа без мутаций. Родитель проверяет на песочнице после.
- [ ] R01–R07 Integration: reconcile worktree; full suites, verify/audit, code-size/prompt/OpenSpec, CLI/HTTP smoke; один simplify-проход без смены тестов; слепой Oracle против manifest и поведения; commit/PR/CI.
