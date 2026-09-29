# Sync and prune containment

## ADDED Requirements

### Requirement: Prune deletes only inside the real harness

Удаление обязано сверять реальный путь кандидата с каноническим корнем. Ссылка наружу — отказ без удаления.

#### Scenario: Junctioned tools directory
- **WHEN** `harness/tools` — junction наружу и кандидат `tools/victim.mjs`
- **THEN** `deletePruneCandidates` возвращает failed, внешний файл цел.

### Requirement: Dangling roots fail closed

Висячий `--harness`/`--agent-dir` обязан давать отказ до любого I/O.

#### Scenario: Harness points at nothing
- **WHEN** `--harness` — junction в несуществующее место
- **THEN** `--check`/`--deploy` завершаются ненулевым кодом, ничего не создано.
