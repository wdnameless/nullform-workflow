# Manifest: repair-red-findings

Источник: «да» на список красного из аудита (отчёты агентов FailingTests, DeadCodeLinks, CliSmoke
в истории сессии; полные тексты: agent://FailingTests/report, agent://DeadCodeLinks/report, agent://CliSmoke/report).

| ID | Verbatim user quote | Requirement | Status |
|---|---|---|---|
| R01 | «да» | delete-guard.test.mjs импортирует .ts напрямую → ERR_UNKNOWN_FILE_EXTENSION. Починить загрузку TS в тесте (strip-types/loader/компиляция — решение исполнителя, без новых зависимостей) | done |
| R02 | «да» | 9 JEV-тестов падают без bun в PATH. Решение: явный SKIP (bun not in PATH) вместо падения; с bun — полный прогон | done |
| R03 | «да» | paseo-install 8.3 short-path vs long-path в .harness-root на Windows. Нормализовать сравнение путей | done |
| R04 | «да» | 6 CLI: jev-evaluate/jev-control/run-skill-benefit-eval/skills-doctor --help (exit 0 + help, без боевых прогонов); cache-policy --help без leak в live-проверки; return-contract без аргов не виснет на stdin (isTTY) | done |
| R05 | «да» | Удалить рудименты archmap (CONTEXT.md, .gitignore, benchmark TOOL_ARTIFACT_PATHS, worktree-snapshot, sync-prune) и хардкод путей (fixer.md → <HARNESS>, benchmark D:/Python312 → env/PATH) | done |
| R06 | «да» | web-design-engineer SKILL.md 525→≤500 строк распилом + прямые markdown-ссылки на 8 references; то же для ui-ux-pro-max (2) и ui-styling (7) варнингов | done |

## Границы
- Мёртвые экспорты-константы (TASK_TIERS и т.п.) НЕ трогаем — публичный API.
- Doctor-флаки orphan-files/provider-reachability/plugins из прошлого прогона — вне этого захода (нужен отдельный разбор окружения CI).
