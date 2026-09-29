# Public release cleanup

## ADDED Requirements

### Requirement: Track MUST contain no secrets or junk

The system MUST NOT track `.db` backups, secret values, or personal machine paths outside documentation examples.

#### Scenario: Backup artifact removed
- **WHEN** `git ls-files backups/` выполняется
- **THEN** вывод пуст, локальный untracked `backups/` пользователя цел.

#### Scenario: Secrets scan clean
- **WHEN** скан `sk-|ghp_|AKIA|password\s*=` по треку (кроме примеров)
- **THEN** совпадений нет.

### Requirement: README MUST be short bilingual (brand + readme)

The README MUST present NULLFORM WORKFLOW in EN+RU under ~120 lines with quickstart and tier table.

#### Scenario: Newcomer opens repo
- **WHEN** открыт README
- **THEN** за 30 секунд понятны назначение, установка и T0–T3.
