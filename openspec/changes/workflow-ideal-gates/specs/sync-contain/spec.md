# Sync and prune containment

## ADDED Requirements

### Requirement: Prune MUST delete only inside the real harness

The system MUST сверять реальный путь кандидата с каноническим корнем. Ссылка наружу — отказ без удаления.

#### Scenario: Junctioned tools directory
- **WHEN** `harness/tools` — junction наружу и кандидат `tools/victim.mjs`
- **THEN** `deletePruneCandidates` возвращает failed, внешний файл цел.

### Requirement: Dangling roots MUST fail closed

The system MUST давать отказ до любого I/O на висячий `--harness`/`--agent-dir`.

#### Scenario: Harness points at nothing
- **WHEN** `--harness` — junction в несуществующее место
- **THEN** `--check`/`--deploy` завершаются ненулевым кодом, ничего не создано.
