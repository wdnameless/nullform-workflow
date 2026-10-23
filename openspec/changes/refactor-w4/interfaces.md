# Interfaces — refactor-w4

## Владение
- S01: `tools/dashboard.mjs` (server/CLI), `tools/dashboard-collectors.mjs` (new),
  `tools/dashboard-ui.mjs` (new). Sequential, parent-doen.
- S02: `tools/session-log.mjs` (new) + 4 потребителя (замена дубликатов).
- Parent: openspec/, .workflow/, сьют, oracle.

## Границы
| Граница | Контракт |
|---------|----------|
| dashboard.mjs фасад | реэкспорт всех 28 тестовых имён из collectors/ui/server |
| collectors → server | collectDashboardData, generateDashboardHtml импортируются сервером |
| session-log | `readJsonlSafe(path, limit)`, `findNewestSession(dir)`, `transcriptTokens(jsonlPath)` — сигнатуры стабильны |

## Сигнатуры
- Без новых публичных API кроме session-log.mjs (внутренний, exported для тестов).
